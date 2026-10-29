import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createGateway } from './server.js';
import type { SmtpConfig } from './smtp.js';
import { anthropic, embedder, openai } from './tabularius/providers.js';
import type { TabulariusConfig } from './tabularius/index.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
// Compose passes unset variables as empty strings, so empty means default throughout.
const security = (process.env.TABULARIUM_SMTP_SECURITY || 'tls') as SmtpConfig['security'];
if (!['tls', 'starttls', 'none'].includes(security)) throw new Error('TABULARIUM_SMTP_SECURITY must be tls, starttls or none');
const smtp: SmtpConfig | undefined = process.env.TABULARIUM_SMTP_HOST ? {
  host: process.env.TABULARIUM_SMTP_HOST, security,
  port: Number(process.env.TABULARIUM_SMTP_PORT || { tls: 465, starttls: 587, none: 25 }[security]),
  user: process.env.TABULARIUM_SMTP_USER || undefined, password: process.env.TABULARIUM_SMTP_PASSWORD || undefined,
  from: required('TABULARIUM_SMTP_FROM'),
} : undefined;
const database = resolve(process.env.TABULARIUM_DATABASE ?? 'data/tabularium.sqlite');
await mkdir(dirname(database), { recursive: true });
// Tabularius, the AI curator, is enabled by choosing a provider; its data lives next to the application database.
const provider = process.env.TABULARIUS_PROVIDER;
if (provider && !['anthropic', 'openai'].includes(provider)) throw new Error('TABULARIUS_PROVIDER must be anthropic or openai');
let tabularius: TabulariusConfig | undefined;
if (provider) {
  const key = Buffer.from(required('TABULARIUS_SECRET_KEY'), 'base64');
  if (key.length !== 32) throw new Error('TABULARIUS_SECRET_KEY must be 32 bytes in base64 (openssl rand -base64 32)');
  tabularius = {
    key, root: resolve(dirname(database), 'tabularius'),
    cli: resolve(process.env.TABULARIUS_CLI || new URL('../cli/index.cjs', import.meta.url).pathname),
    provider: provider === 'anthropic' ? anthropic(process.env.TABULARIUS_MODEL || 'claude-opus-5-5') : openai(required('TABULARIUS_MODEL')),
    embedder: process.env.TABULARIUS_EMBEDDING_MODEL
      ? embedder(process.env.TABULARIUS_EMBEDDING_MODEL, process.env.TABULARIUS_EMBEDDING_URL || undefined, process.env.TABULARIUS_EMBEDDING_KEY || undefined) : undefined,
  };
}
const gateway = await createGateway({
  database,
  publicUrl: process.env.TABULARIUM_PUBLIC_URL,
  bootstrapUser: process.env.TABULARIUM_ADMIN_USER,
  bootstrapPassword: process.env.TABULARIUM_ADMIN_PASSWORD,
  auditDays: process.env.TABULARIUM_AUDIT_DAYS ? Number(process.env.TABULARIUM_AUDIT_DAYS) : undefined,
  smtp,
  tabularius,
  kindleDomains: process.env.TABULARIUM_KINDLE_DOMAINS ? process.env.TABULARIUM_KINDLE_DOMAINS.split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean) : undefined,
  kindleDaily: process.env.TABULARIUM_KINDLE_DAILY ? Number(process.env.TABULARIUM_KINDLE_DAILY) : undefined,
  origins: (process.env.TABULARIUM_ORIGINS ?? 'app://obsidian.md,capacitor://localhost,http://localhost').split(','),
  couch: {
    url: required('COUCHDB_URL').replace(/\/$/, ''),
    adminUser: required('COUCHDB_ADMIN_USER'), adminPassword: required('COUCHDB_ADMIN_PASSWORD'),
    syncUser: required('COUCHDB_SYNC_USER'), syncPassword: required('COUCHDB_SYNC_PASSWORD'),
  },
});
const url = await gateway.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
console.log(`Tabularium listening on ${url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void gateway.close(); });
