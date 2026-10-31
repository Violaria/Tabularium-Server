// The server's running settings, edited by administrators on the web: mail and Kindle, sharing, and access (lifetimes,
// limits, retention). The first start imports what the configuration gave; afterwards the application database is the
// source and changes apply to the next request. The SMTP password is sealed with the server's secret key and never
// returned.
import type { DatabaseSync } from 'node:sqlite';
import { open, seal } from './tabularius/client.js';
import type { SmtpConfig } from './smtp.js';

export interface MailSettings { host: string; port: number; security: 'tls' | 'starttls' | 'none'; user: string; from: string; password: string | null; hint: string }
export interface Values {
  mail: MailSettings | null;
  kindle: { domains: string[]; daily: number; maxMegabytes: number };
  shares: { enabled: boolean; url: string; maxMegabytes: number };
  access: { sessionHours: number; deviceDays: number; rebuildMinutes: number; loginPerMinute: number; syncPerMinute: number; auditDays: number; streamMinutes: number; writeMegabytes: number };
}
export interface InitialServerSettings {
  smtp?: SmtpConfig; kindleDomains?: string[]; kindleDaily?: number; kindleMaxBytes?: number;
  shares?: { enabled?: boolean; url?: string; maxBytes?: number };
  sessionMs?: number; deviceMs?: number; rebuildMs?: number; loginLimit?: number; syncLimit?: number; auditDays?: number; streamMs?: number; writeLimit?: number;
}
export class ServerSettingsError extends Error {}

const MB = 1_048_576;
const hintOf = (secret: string) => secret.length > 8 ? secret.slice(-4) : '';

export function createServerSettings(db: DatabaseSync, secret: Buffer | undefined, initial: InitialServerSettings) {
  const write = (values: Values) => db.prepare("INSERT INTO server_settings(key, value) VALUES('values', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(values));
  const sealed = (password: string) => {
    if (!secret) throw new ServerSettingsError('Passwords need TABULARIUS_SECRET_KEY on the server');
    return seal(secret, password).toString('base64');
  };
  // First start of this version: take the configuration as it was.
  if (!db.prepare("SELECT 1 FROM server_settings WHERE key='values'").get()) {
    const smtp = initial.smtp;
    write({
      mail: smtp ? { host: smtp.host, port: smtp.port, security: smtp.security, user: smtp.user ?? '', from: smtp.from,
        password: smtp.password && secret ? sealed(smtp.password) : null, hint: smtp.password ? hintOf(smtp.password) : '' } : null,
      kindle: { domains: initial.kindleDomains ?? ['kindle.com', 'free.kindle.com'], daily: initial.kindleDaily ?? 30, maxMegabytes: Math.round((initial.kindleMaxBytes ?? 50 * MB) / MB) },
      shares: { enabled: initial.shares?.enabled ?? true, url: initial.shares?.url ?? '', maxMegabytes: Math.round((initial.shares?.maxBytes ?? 50 * MB) / MB) },
      access: {
        sessionHours: (initial.sessionMs ?? 43_200_000) / 3_600_000, deviceDays: (initial.deviceMs ?? 2_592_000_000) / 86_400_000,
        rebuildMinutes: (initial.rebuildMs ?? 900_000) / 60_000, loginPerMinute: initial.loginLimit ?? 20, syncPerMinute: initial.syncLimit ?? 2400,
        auditDays: initial.auditDays ?? 365, streamMinutes: (initial.streamMs ?? 300_000) / 60_000, writeMegabytes: Math.round((initial.writeLimit ?? 64 * MB) / MB),
      },
    });
  }
  let cached: Values | undefined;
  const values = () => (cached ??= JSON.parse((db.prepare("SELECT value FROM server_settings WHERE key='values'").get() as { value: string }).value) as Values);

  const number = (value: unknown, min: number, max: number, name: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ServerSettingsError(`Invalid ${name}`);
    return value;
  };
  return {
    /** The SMTP connection, or undefined when mail is not set up. */
    smtp(): SmtpConfig | undefined {
      const mail = values().mail;
      if (!mail?.host || !mail.from) return undefined;
      return { host: mail.host, port: mail.port, security: mail.security, user: mail.user || undefined, from: mail.from,
        password: mail.password && secret ? open(secret, Buffer.from(mail.password, 'base64')) : undefined };
    },
    kindleDomains: () => values().kindle.domains,
    kindleDaily: () => values().kindle.daily,
    kindleMaxBytes: () => values().kindle.maxMegabytes * MB,
    shares: () => ({ enabled: values().shares.enabled, url: values().shares.url || undefined, maxBytes: values().shares.maxMegabytes * MB }),
    sessionMs: () => values().access.sessionHours * 3_600_000,
    deviceMs: () => values().access.deviceDays * 86_400_000,
    rebuildMs: () => values().access.rebuildMinutes * 60_000,
    loginLimit: () => values().access.loginPerMinute,
    syncLimit: () => values().access.syncPerMinute,
    auditDays: () => values().access.auditDays,
    streamMs: () => values().access.streamMinutes * 60_000,
    writeLimit: () => values().access.writeMegabytes * MB,
    /** What the settings page shows: the password only as set or not, with its last four characters. */
    view() {
      const { mail, ...rest } = values();
      return { ...rest, mail: mail ? { host: mail.host, port: mail.port, security: mail.security, user: mail.user, from: mail.from, passwordSet: Boolean(mail.password), passwordHint: mail.hint } : null,
        secretKey: Boolean(secret) };
    },
    /** Saves the sections the page sent. A password is replaced only when one is given; an empty one removes it. */
    update(data: Record<string, unknown>) {
      const next: Values = structuredClone(values());
      if (data.mail !== undefined) {
        const m = data.mail as Record<string, unknown> | null;
        if (m === null || !m.host) next.mail = null;
        else {
          if (typeof m.host !== 'string' || m.host.length > 255 || typeof m.from !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(m.from)) throw new ServerSettingsError('Invalid mail settings');
          if (!['tls', 'starttls', 'none'].includes(m.security as string)) throw new ServerSettingsError('Invalid mail security');
          const port = number(m.port, 1, 65535, 'mail port');
          const previous = next.mail;
          let password = previous?.password ?? null; let hint = previous?.hint ?? '';
          if (m.password !== undefined) {
            if (typeof m.password !== 'string' || m.password.length > 1024) throw new ServerSettingsError('Invalid mail password');
            password = m.password ? sealed(m.password) : null; hint = m.password ? hintOf(m.password) : '';
          }
          next.mail = { host: m.host.trim(), port, security: m.security as MailSettings['security'], user: typeof m.user === 'string' ? m.user.trim() : '', from: m.from.trim(), password, hint };
        }
      }
      if (data.kindle !== undefined) {
        const k = data.kindle as Record<string, unknown>;
        if (!Array.isArray(k.domains) || !k.domains.length || !k.domains.every(d => typeof d === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))) throw new ServerSettingsError('Invalid Kindle domains');
        next.kindle = { domains: (k.domains as string[]).map(d => d.toLowerCase()), daily: number(k.daily, 1, 1000, 'daily limit'), maxMegabytes: number(k.maxMegabytes, 1, 200, 'size limit') };
      }
      if (data.shares !== undefined) {
        const s = data.shares as Record<string, unknown>;
        if (typeof s.enabled !== 'boolean' || typeof s.url !== 'string' || (s.url && !/^https?:\/\/[^\s/]+\/?$/.test(s.url))) throw new ServerSettingsError('Invalid sharing settings');
        next.shares = { enabled: s.enabled, url: s.url.replace(/\/$/, ''), maxMegabytes: number(s.maxMegabytes, 1, 1024, 'share size limit') };
      }
      if (data.access !== undefined) {
        const a = data.access as Record<string, unknown>;
        next.access = {
          sessionHours: number(a.sessionHours, 1, 24 * 90, 'session lifetime'), deviceDays: number(a.deviceDays, 1, 3650, 'device lifetime'),
          rebuildMinutes: number(a.rebuildMinutes, 1, 24 * 60, 'rebuild window'), loginPerMinute: number(a.loginPerMinute, 1, 10_000, 'login limit'),
          syncPerMinute: number(a.syncPerMinute, 10, 1_000_000, 'sync limit'), auditDays: number(a.auditDays, 1, 3650, 'activity retention'),
          streamMinutes: number(a.streamMinutes, 1, 24 * 60, 'stream duration'), writeMegabytes: number(a.writeMegabytes, 1, 4096, 'write limit'),
        };
      }
      write(next);
      cached = next;
    },
  };
}
export type ServerSettings = ReturnType<typeof createServerSettings>;
