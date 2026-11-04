import { createServer, request, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { openStore, passwordHash, verifyPassword, same, token, digest, type User, type Vault, type Device } from './store.js';
import { loadConsole, loadViewer } from './console-assets.js';
import { rejection } from './policy.js';
import { sendMail, type SmtpConfig } from './smtp.js';
import { Couch, basic, type CouchConfig } from './couch.js';
import { createTabularius, MODES, type TabulariusConfig } from './tabularius/index.js';
import { clientReport, createMachines } from './machines.js';
import { HttpError, body, fail, field, json, payload, raw } from './http.js';
import { createShares, type SharesConfig } from './shares.js';
import { createServerSettings, ServerSettingsError } from './server-settings.js';
import { BackupError, createBackups } from './backup/index.js';
import { readFileSync } from 'node:fs';
/** The server's own version, recorded in backup points. */
const SERVER_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export interface Config {
  database: string; couch: CouchConfig; bootstrapUser?: string; bootstrapPassword?: string;
  origins: string[]; sessionMs?: number; deviceMs?: number; streamMs?: number;
  loginLimit?: number; syncLimit?: number; publicUrl?: string; rebuildMs?: number; writeLimit?: number; auditDays?: number;
  smtp?: SmtpConfig; kindleDomains?: string[]; kindleDaily?: number; kindleMaxBytes?: number;
  tabularius?: TabulariusConfig; shares?: Partial<SharesConfig>;
  /** Seals the passwords kept in the settings (TABULARIUS_SECRET_KEY). */
  secret?: Buffer;
  /** Where scheduled backups are written (TABULARIUM_BACKUP_DIR); without it they are not offered. */
  backupDir?: string;
}
// An EPUB starts with an uncompressed `mimetype` entry holding application/epub+zip (OCF 3.3 §4.3).
const isEpub = (data: Buffer) => data.length > 58 && data.readUInt32LE(0) === 0x04034b50 && data.readUInt16LE(28) === 0 &&
  data.subarray(30, 38).toString() === 'mimetype' && data.subarray(38, 58).toString() === 'application/epub+zip';
const forbidden = (id: unknown, reason: string) => ({ id, error: 'forbidden', reason });
const publicUser = (u: User) => ({ id: u.id, username: u.username, role: u.role, disabled: Boolean(u.disabled), mustChangePassword: Boolean(u.must_change_password),
  theme: u.theme ?? '', recipe: u.theme_recipe ? JSON.parse(u.theme_recipe) as unknown : null, customThemes: JSON.parse(u.custom_themes || '[]') as unknown[] });
/** An account's own colour schemes: a name and a recipe each. */
interface Scheme { id: string; name: string; accent: string; tint: number; side: 'light' | 'dark' }
const SCHEMES_LIMIT = 20;
/** Colour themes of the web pages; '' is the default, "custom" is built from the account's recipe. */
const THEMES = ['', 'forest', 'sakura', 'lavender', 'custom'];
/** A custom theme's recipe: main colour, tint strength (6 to 40 percent) and a light or dark sidebar. */
function recipe(value: unknown) {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== 'object' || typeof item.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.accent)
    || !Number.isInteger(item.tint) || (item.tint as number) < 6 || (item.tint as number) > 40 || !['light', 'dark'].includes(item.side as string)) return fail(400, 'Invalid colour recipe');
  return { accent: (item.accent as string).toLowerCase(), tint: item.tint as number, side: item.side as 'light' | 'dark' };
}
const publicVault = (v: Vault) => ({ id: v.id, name: v.name, state: v.state, syncPath: `/sync/${v.id}`,
  rebuild: v.rebuild_device ? { deviceId: v.rebuild_device, until: v.rebuild_until, started: v.rebuild_started } : null });
const MILESTONE = 'obsydian_livesync_milestone';
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headers(source: IncomingMessage['headers']) {
  const blocked = new Set([...hopHeaders, ...(source.connection ?? '').toLowerCase().split(',').map(s => s.trim()),
    'authorization', 'cookie', 'set-cookie', 'host', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-auth-couchdb-username', 'x-auth-couchdb-roles', 'x-auth-couchdb-token']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.has(key) && !key.startsWith('access-control-')));
}
function segments(path: string) {
  return path.split('/').filter((_, i) => i > 0).map(part => {
    let value;
    try { value = decodeURIComponent(part); } catch { return fail(400, 'Invalid path encoding'); }
    if (value === '.' || value === '..' || /[%\\\x00-\x1f\x7f]/.test(value)) fail(400, 'Invalid path');
    return value;
  });
}
function replicationAllowed(method: string, parts: string[]) {
  if (parts.length === 0 || (parts.length === 1 && !parts[0])) return ['GET', 'HEAD'].includes(method);
  const [id] = parts;
  if (parts.length === 2 && id === '_local' && parts[1]) return ['GET', 'PUT', 'HEAD'].includes(method);
  if (parts.length !== 1) return false;
  if (['_changes', '_all_docs'].includes(id)) return ['GET', 'POST'].includes(method);
  if (['_revs_diff', '_bulk_get', '_bulk_docs', '_find'].includes(id)) return method === 'POST';
  return Boolean(id) && !id.startsWith('_') && ['GET', 'PUT', 'HEAD'].includes(method);
}

export async function createGateway(config: Config) {
  const serveConsole = await loadConsole();
  const startedAt = Date.now();
  const unknownUserHash = passwordHash(token());
  const db = openStore(config.database);
  // Running settings: the configuration is imported on the first start, then the web settings apply.
  const settings = createServerSettings(db, config.secret ?? config.tabularius?.key, {
    smtp: config.smtp, kindleDomains: config.kindleDomains, kindleDaily: config.kindleDaily, kindleMaxBytes: config.kindleMaxBytes,
    shares: { ...config.shares, url: config.shares?.url ?? (config.publicUrl ?? '').split(',').map(value => value.trim()).filter(Boolean).at(-1) },
    sessionMs: config.sessionMs, deviceMs: config.deviceMs, rebuildMs: config.rebuildMs, loginLimit: config.loginLimit, syncLimit: config.syncLimit,
    auditDays: config.auditDays, streamMs: config.streamMs, writeLimit: config.writeLimit,
  });
  const couch = new Couch(config.couch);
  const backups = createBackups({ db, couch: config.couch, directory: config.backupDir, version: SERVER_VERSION,
    onFailure: error => { db.prepare('INSERT INTO audit_events(occurred_at,actor_id,action,target_id) VALUES(?,?,?,?)').run(Date.now(), 'system', 'backup.failed', error.slice(0, 200)); } });
  const active = new Map<ClientRequest, { device: string; user: string; vault: string; res: ServerResponse }>();
  const limits = new Map<string, { count: number; until: number }>();
  const stats = { requests: 0, proxyRequests: 0, statuses: {} as Record<string, number> };
  const shares = createShares({ db, session, deviceAuth, audit, limit, viewer: await loadViewer(),
    settings: () => settings.shares() });
  const prune = () => {
    shares.prune();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('DELETE FROM audit_events WHERE occurred_at <= ?').run(Date.now() - settings.auditDays() * 86_400_000);
    db.prepare('DELETE FROM kindle_deliveries WHERE occurred_at <= ?').run(Date.now() - settings.auditDays() * 86_400_000);
    // An expired credential can only be replaced by signing in again; the hosted ones renew themselves.
    db.prepare(`DELETE FROM devices WHERE expires_at <= ? AND id NOT IN (SELECT device_id FROM tabularius_vaults)
      AND id NOT IN (SELECT rebuild_device FROM vaults WHERE rebuild_device IS NOT NULL)`).run(Date.now());
    db.prepare('DELETE FROM machines WHERE id NOT IN (SELECT machine_id FROM devices WHERE machine_id IS NOT NULL)').run();
  };
  prune();
  const tabularius = config.tabularius
    ? createTabularius(db, couch, config.tabularius, () => settings.deviceMs(), fail, device => cancel(v => v.device === device)) : undefined;
  const cleanup = setInterval(() => {
    for (const [key, value] of limits) if (value.until <= Date.now()) limits.delete(key);
    prune();
  }, 60_000);
  cleanup.unref();
  try {
    await couch.prepare();
    if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
      if (!config.bootstrapUser || !config.bootstrapPassword || config.bootstrapPassword.length < 12) {
        throw new Error('First startup requires bootstrap username and password (at least 12 characters)');
      }
      db.prepare('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)')
        .run(randomUUID(), config.bootstrapUser, await passwordHash(config.bootstrapPassword), 'admin');
    }
  } catch (error) { clearInterval(cleanup); db.close(); throw error; }

  function limit(key: string, max: number, res: ServerResponse) {
    const now = Date.now();
    let bucket = limits.get(key);
    if (!bucket || bucket.until <= now) { bucket = { count: 0, until: now + 60_000 }; limits.set(key, bucket); }
    if (++bucket.count > max) { res.setHeader('retry-after', Math.ceil((bucket.until - now) / 1000)); fail(429, 'Too many requests'); }
  }
  function cancel(match: (v: { device: string; user: string; vault: string }) => boolean) {
    for (const [request, value] of active) if (match(value)) { request.destroy(); value.res.destroy(); }
  }
  function audit(actorId: string, action: string, targetId: string) {
    db.prepare('INSERT INTO audit_events(occurred_at,actor_id,action,target_id) VALUES(?,?,?,?)')
      .run(Date.now(), actorId, action, targetId);
  }
  const machines = createMachines({ db, audit, disconnect: device => cancel(v => v.device === device) });
  /** A vault's devices that were not revoked; the hosted one is only removed by turning Tabularius off. */
  const deviceList = (vaultId: string) => (db.prepare(`SELECT d.id, COALESCE(m.name, d.name) AS name, d.expires_at AS expiresAt, d.last_seen_at AS lastSeenAt, d.machine_id AS machineId,
    EXISTS(SELECT 1 FROM tabularius_vaults t WHERE t.device_id=d.id) AS hosted
    FROM devices d LEFT JOIN machines m ON m.id=d.machine_id WHERE d.vault_id=? AND d.revoked=0`).all(vaultId) as { hosted: number; expiresAt: number }[])
    .filter(device => device.hosted || device.expiresAt > Date.now())
    .map(device => ({ ...device, hosted: Boolean(device.hosted) }));
  /** Gives back the space of old revisions and of what was cleared: CouchDB compacts in the background. */
  async function compact(vault: Vault, actorId: string) {
    if (vault.state !== 'ready') fail(409, 'Vault is not ready');
    const response = await couch.admin(`/${vault.database_name}/_compact`, 'POST', {});
    await response.arrayBuffer();
    if (!response.ok) fail(502, 'Compaction could not start');
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    audit(actorId, 'vault.compact', vault.id);
  }
  function revokeDevice(vaultId: string, deviceId: string, actorId: string) {
    if (db.prepare('SELECT 1 FROM tabularius_vaults WHERE device_id=? AND vault_id=?').get(deviceId, vaultId)) fail(409, 'The hosted device stops with Tabularius');
    db.prepare('UPDATE vaults SET rebuild_device=NULL, rebuild_until=NULL, rebuild_started=NULL WHERE rebuild_device=? AND id=?').run(deviceId, vaultId);
    const result = db.prepare('DELETE FROM devices WHERE id=? AND vault_id=?').run(deviceId, vaultId);
    if (!result.changes) fail(404, 'Device not found');
    machines.dropEmpty();
    cancel(v => v.device === deviceId);
    audit(actorId, 'device.revoke', deviceId);
  }
  // TABULARIUM_PUBLIC_URL may list several entrances (LAN and public); without it the console is served over plain HTTP.
  const publicUrls = () => (config.publicUrl ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => new URL(value));
  const isBrowserOrigin = (req: IncomingMessage, origin = req.headers.origin) => {
    const urls = publicUrls();
    return urls.length ? urls.some(url => url.origin === origin) : origin === `http://${req.headers.host}`;
  };
  const csrfFor = (hash: string) => digest(`csrf:${hash}`);
  function setSessionCookie(res: ServerResponse, value: string, maxAge: number) {
    res.setHeader('set-cookie', `tabularium_session=${value}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${publicUrls().length && publicUrls().every(url => url.protocol === 'https:') ? '; Secure' : ''}`);
  }
  function session(req: IncomingMessage) {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ');
    const value = bearer ? auth!.slice(7) : req.headers.cookie?.split(';').map(item => item.trim())
      .find(item => item.startsWith('tabularium_session='))?.slice('tabularium_session='.length);
    if (!value) return fail(401, 'Session required');
    const hash = digest(value);
    const user = db.prepare(`SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
      WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`).get(hash, Date.now()) as unknown as User | undefined;
    if (!user) return fail(401, 'Session expired or invalid');
    if (!bearer && !['GET', 'HEAD'].includes(req.method!)) {
      if (!isBrowserOrigin(req) || !same(req.headers['x-csrf-token'], csrfFor(hash))) fail(403, 'Invalid CSRF token or origin');
    }
    return { user, hash };
  }
  function ownedVault(id: string, user: User) {
    const vault = db.prepare('SELECT * FROM vaults WHERE id=? AND owner_id=?').get(id, user.id) as unknown as Vault | undefined;
    if (!vault) return fail(404, 'Vault not found');
    return vault;
  }
  async function provision(vault: Vault, actorId: string) {
    db.prepare("UPDATE vaults SET state='provisioning' WHERE id=?").run(vault.id);
    try {
      await couch.provision(vault.database_name);
      db.prepare("UPDATE vaults SET state='ready' WHERE id=?").run(vault.id);
      vault.state = 'ready';
      audit(actorId, 'vault.provision', vault.id);
    } catch {
      db.prepare("UPDATE vaults SET state='failed' WHERE id=?").run(vault.id);
      fail(502, `Vault provisioning failed; retry /api/v1/vaults/${vault.id}/provision`);
    }
    return publicVault(vault);
  }
  function deviceAuth(req: IncomingMessage) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Basic ')) return fail(401, 'Device credentials required');
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const split = decoded.indexOf(':');
    const device = db.prepare(`SELECT d.* FROM devices d JOIN users u ON u.id=d.user_id
      WHERE d.id=? AND d.secret_hash=? AND d.revoked=0 AND d.expires_at>? AND u.disabled=0 AND u.must_change_password=0`)
      .get(decoded.slice(0, split), digest(decoded.slice(split + 1)), Date.now()) as unknown as Device | undefined;
    if (!device) return fail(401, 'Device credentials expired or invalid');
    // Last synchronisation time, written at most once a minute per device.
    const now = Date.now();
    if (!device.last_seen_at || now - device.last_seen_at > 60_000) {
      db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now, device.id);
      device.last_seen_at = now;
    }
    return device;
  }
  const clearRebuild = (vaultId: string) => db.prepare('UPDATE vaults SET rebuild_device=NULL, rebuild_until=NULL, rebuild_started=NULL WHERE id=?').run(vaultId);
  // Replaces the vault's database during a client-driven LiveSync rebuild; the previous database is kept as retired.
  async function switchDatabase(vault: Vault, device: Device) {
    const name = `tab_${vault.id.replaceAll('-', '')}_r${Date.now().toString(36)}`;
    try { await couch.provision(name); } catch { fail(502, 'Rebuild database could not be created'); }
    db.exec('BEGIN');
    // A database replaced while a rebuild was already under way never became complete, so it is not a revert target.
    db.prepare('INSERT INTO retired_databases VALUES(?,?,?,?)').run(vault.database_name, vault.id, Date.now(), vault.rebuild_started ? 1 : 0);
    db.prepare('UPDATE vaults SET database_name=?, rebuild_started=? WHERE id=?').run(name, Date.now(), vault.id);
    audit(device.user_id, 'vault.rebuild-switch', vault.id);
    db.exec('COMMIT');
    cancel(v => v.vault === vault.id);
  }
  async function proxy(req: IncomingMessage, res: ServerResponse, parts: string[], query: string) {
    const device = deviceAuth(req);
    limit(`device:${device.id}`, settings.syncLimit(), res);
    let targetPath = '/';
    let completesRebuild = false;
    let write: { data: Buffer; rejected: { index: number; entry: ReturnType<typeof forbidden> }[]; newEdits: boolean } | undefined;
    if (parts.length > 1 && parts[1]) {
      if (parts[1] !== device.vault_id) fail(403, 'Device belongs to another vault');
      const vault = db.prepare('SELECT * FROM vaults WHERE id=?').get(device.vault_id) as unknown as Vault;
      if (vault.state !== 'ready') fail(409, 'Vault is not ready');
      const rest = parts.slice(2);
      const rebuilder = vault.rebuild_device === device.id;
      if (vault.rebuild_started && !rebuilder) fail(409, 'Vault is being rebuilt');
      if ((rest.length === 0 || (rest.length === 1 && !rest[0])) && ['DELETE', 'PUT'].includes(req.method!)) {
        req.resume();
        if (req.method === 'PUT' && rebuilder && vault.rebuild_started) {
          json(res, 412, { error: 'file_exists', reason: 'The database could not be created, the file already exists.' }); return;
        }
        if (req.method === 'PUT' || !rebuilder || vault.rebuild_until! <= Date.now()) fail(403, 'Replication route not allowed');
        await switchDatabase(vault, device);
        json(res, 200, { ok: true }); return;
      }
      if (!replicationAllowed(req.method!, rest)) fail(403, 'Replication route not allowed');
      completesRebuild = rebuilder && Boolean(vault.rebuild_started) && req.method === 'PUT' && rest[0] === '_local' && rest[1] === MILESTONE;
      // Document writes are read in full and checked against the encrypted document policy before CouchDB sees them.
      const limit = settings.writeLimit();
      if (req.method === 'PUT' && rest.length === 1) {
        const { data, parsed } = await payload(req, limit);
        const reason = rejection({ ...parsed, _id: rest[0] });
        if (reason) { json(res, 403, forbidden(rest[0], reason)); return; }
        write = { data, rejected: [], newEdits: true };
      } else if (req.method === 'PUT' && rest[0] === '_local') {
        // Checkpoints and the milestone document hold no notes; they are only held to the same size limit.
        write = { data: (await payload(req, limit)).data, rejected: [], newEdits: true };
      } else if (req.method === 'POST' && rest.length === 1 && rest[0] === '_bulk_docs') {
        const { data, parsed } = await payload(req, limit);
        if (!Array.isArray(parsed?.docs)) fail(400, 'Expected docs array');
        const rejected = [], accepted = [];
        for (const [index, doc] of (parsed.docs as Record<string, unknown>[]).entries()) {
          const reason = typeof doc === 'object' && doc ? rejection(doc) : 'documents must be objects';
          if (reason) rejected.push({ index, entry: forbidden(doc?._id, reason) }); else accepted.push(doc);
        }
        if (rejected.length && !accepted.length) { json(res, 201, rejected.map(r => r.entry)); return; }
        write = { data: rejected.length ? Buffer.from(JSON.stringify({ ...parsed, docs: accepted })) : data, rejected, newEdits: parsed.new_edits !== false };
      }
      targetPath = `/${vault.database_name}` + (parts.length > 2 ? `/${rest.map(encodeURIComponent).join('/')}` : '');
    } else if (!['GET', 'HEAD'].includes(req.method!)) fail(403, 'Replication route not allowed');
    const url = new URL(config.couch.url + targetPath + query);
    const outgoing = (url.protocol === 'https:' ? httpsRequest : request)(url, {
      method: req.method, headers: { ...headers(req.headers), authorization: basic(config.couch.syncUser, config.couch.syncPassword),
        ...(write ? { 'content-length': String(write.data.length) } : {}) },
    }, response => {
      // The rebuilding device has written the new milestone, so upstream locking now protects the other devices.
      if (completesRebuild && response.statusCode! < 300) { clearRebuild(device.vault_id); audit(device.user_id, 'vault.rebuild-complete', device.vault_id); }
      response.on('error', () => res.destroy());
      if (!write?.rejected.length) { res.writeHead(response.statusCode!, headers(response.headers)); response.pipe(res); return; }
      // Put the rejected entries back where they were: CouchDB lists every document normally, but only failures with new_edits=false.
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        // An event handler: a reply CouchDB cut short must fail this request, not the process.
        let results: unknown;
        try { results = JSON.parse(Buffer.concat(chunks).toString()); } catch { json(res, 502, { error: 'Invalid response from CouchDB' }); return; }
        if (!Array.isArray(results)) { json(res, response.statusCode!, results); return; }
        if (!write!.newEdits) { json(res, response.statusCode!, [...results, ...write!.rejected.map(r => r.entry)]); return; }
        const merged = [];
        const total = results.length + write!.rejected.length;
        for (let index = 0, next = 0; index < total; index++) {
          merged.push(write!.rejected[next]?.index === index ? write!.rejected[next++].entry : results.shift());
        }
        json(res, response.statusCode!, merged);
      });
    });
    stats.proxyRequests++;
    active.set(outgoing, { device: device.id, user: device.user_id, vault: device.vault_id, res });
    const timer = setTimeout(() => { outgoing.destroy(); res.destroy(); }, Math.min(settings.streamMs(), device.expires_at - Date.now()));
    timer.unref();
    res.once('close', () => { clearTimeout(timer); active.delete(outgoing); outgoing.destroy(); });
    outgoing.on('error', () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy(); else json(res, 502, { error: 'CouchDB unavailable' });
    });
    req.on('error', () => outgoing.destroy());
    if (write) outgoing.end(write.data); else req.pipe(outgoing);
  }
  // Notes per vault database: live file metadata documents, recounted only when the database has changed.
  const noteCounts = new Map<string, { seq: string; count: number }>();
  async function countNotes(database: string, seq: string) {
    const cached = noteCounts.get(database);
    if (cached?.seq === seq) return cached.count;
    const range = `startkey=${encodeURIComponent('"f:"')}&endkey=${encodeURIComponent('"f:\ufff0"')}`;
    const response = await couch.admin(`/${database}/_all_docs?include_docs=true&${range}`);
    if (!response.ok) { await response.arrayBuffer(); fail(502, 'CouchDB unavailable'); }
    const rows = ((await response.json()) as { rows: { doc?: { deleted?: boolean; _deleted?: boolean } }[] }).rows;
    const count = rows.filter(row => row.doc && !row.doc.deleted && !row.doc._deleted).length;
    noteCounts.set(database, { seq, count });
    return count;
  }
  /** The signed-in user's own vaults at a glance, recent Tabularius conversations, and a server summary for administrators. */
  async function home(user: User) {
    const vaults = db.prepare('SELECT * FROM vaults WHERE owner_id=? ORDER BY name').all(user.id) as unknown as Vault[];
    const result = [];
    for (const vault of vaults) {
      let size = 0, notes = 0, locked = false;
      if (vault.state === 'ready') {
        const response = await couch.admin(`/${vault.database_name}`);
        if (!response.ok) { await response.arrayBuffer(); fail(502, 'CouchDB unavailable'); }
        const info = await response.json() as { sizes: { file: number }; update_seq: string };
        size = info.sizes.file;
        notes = await countNotes(vault.database_name, String(info.update_seq));
        locked = Boolean((await milestone(vault.database_name))?.locked);
      }
      const devices = db.prepare(`SELECT COALESCE(m.name, d.name) AS name, d.last_seen_at AS lastSeenAt FROM devices d LEFT JOIN machines m ON m.id=d.machine_id
        WHERE d.vault_id=? AND d.revoked=0 AND d.expires_at>? AND d.id NOT IN (SELECT device_id FROM tabularius_vaults) ORDER BY d.last_seen_at DESC`).all(vault.id, Date.now());
      const assistant = tabularius?.status(vault);
      // Note names only where the server already holds the plaintext (Tabularius enabled).
      const recent = assistant?.enabled
        ? db.prepare('SELECT path, mtime FROM tabularius_files WHERE vault_id=? ORDER BY mtime DESC LIMIT 5').all(vault.id) : [];
      result.push({ id: vault.id, name: vault.name, state: vault.state, locked, rebuilding: Boolean(vault.rebuild_started),
        size, notes: assistant?.enabled ? (assistant as { notes: number }).notes : notes, devices, tabularius: Boolean(assistant?.enabled), recent });
    }
    const conversations = tabularius ? db.prepare(`SELECT c.id, c.title, c.vault_id AS vaultId, v.name AS vault, c.updated_at AS updatedAt
      FROM tabularius_conversations c JOIN vaults v ON v.id=c.vault_id WHERE c.user_id=? AND c.archived_at IS NULL ORDER BY c.updated_at DESC LIMIT 5`).all(user.id) : [];
    let server = null;
    if (user.role === 'admin') {
      let storage = false;
      try { const up = await couch.admin('/_up'); storage = up.ok; await up.arrayBuffer(); } catch { /* Shown as not ready. */ }
      server = { uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), activeProxyConnections: active.size, storage,
        model: tabularius ? (({ recipes, defaultRecipe }) => recipes.find(recipe => recipe.id === defaultRecipe)?.name ?? null)(tabularius.overview()) : null };
    }
    return { vaults: result, conversations, server };
  }
  /** LiveSync's milestone document of a vault database: its lock, accepted devices and chunk parameters. */
  async function milestone(database: string) {
    let response;
    try { response = await couch.admin(`/${database}/_local/${MILESTONE}`); } catch { fail(502, 'CouchDB unavailable'); }
    if (response!.status === 404) { await response!.arrayBuffer(); return undefined; }
    if (!response!.ok) { await response!.arrayBuffer(); fail(502, 'CouchDB unavailable'); }
    return await response!.json() as Record<string, unknown>;
  }
  async function unlock(database: string) {
    const current = await milestone(database);
    if (!current) return;
    const response = await couch.admin(`/${database}/_local/${MILESTONE}`, 'PUT', { ...current, locked: false });
    await response.arrayBuffer();
    if (!response.ok) fail(502, 'Could not unlock the database');
  }
  async function rebuild(req: IncomingMessage, vault: Vault, user: User, rest: string[], method: string) {
    if (rest.length === 0 && method === 'POST') {
      const data = await body(req);
      const deviceId = field(data, 'deviceId');
      if (field(data, 'confirm') !== vault.name) fail(400, 'Confirmation does not match the vault name');
      if (vault.state !== 'ready') fail(409, 'Vault is not ready');
      if (vault.rebuild_started) fail(409, 'A rebuild is already in progress');
      if (!db.prepare('SELECT id FROM devices WHERE id=? AND vault_id=? AND revoked=0 AND expires_at>?').get(deviceId, vault.id, Date.now())) fail(404, 'Active device not found');
      db.prepare('UPDATE vaults SET rebuild_device=?, rebuild_until=? WHERE id=?').run(deviceId, Date.now() + settings.rebuildMs(), vault.id);
      audit(user.id, 'vault.rebuild-arm', vault.id);
    } else if (rest.length === 0 && method === 'DELETE') {
      clearRebuild(vault.id);
      audit(user.id, 'vault.rebuild-end', vault.id);
    } else if (rest.length === 1 && rest[0] === 'lock' && method === 'GET') {
      return { locked: Boolean((await milestone(vault.database_name))?.locked) };
    } else if (rest.length === 1 && rest[0] === 'lock' && method === 'DELETE') {
      // The owner lifts the lock a rebuild leaves once the other devices have fetched again, as the plug-in's unlock does.
      if (vault.rebuild_started) fail(409, 'A rebuild is already in progress');
      await unlock(vault.database_name);
      audit(user.id, 'vault.unlock', vault.id);
    } else if (rest.length === 1 && rest[0] === 'revert' && method === 'POST') {
      if (field(await body(req), 'confirm') !== vault.name) fail(400, 'Confirmation does not match the vault name');
      const previous = db.prepare('SELECT database_name FROM retired_databases WHERE vault_id=? AND partial=0 ORDER BY retired_at DESC LIMIT 1').get(vault.id) as { database_name: string } | undefined;
      if (!previous) fail(409, 'No retired database to revert to');
      cancel(v => v.vault === vault.id);
      // Undo the lock the rebuilding client placed on the previous database before replacing it.
      await unlock(previous!.database_name);
      db.exec('BEGIN');
      db.prepare('DELETE FROM retired_databases WHERE database_name=?').run(previous!.database_name);
      db.prepare('INSERT INTO retired_databases VALUES(?,?,?,0)').run(vault.database_name, vault.id, Date.now());
      db.prepare('UPDATE vaults SET database_name=?, rebuild_device=NULL, rebuild_until=NULL, rebuild_started=NULL WHERE id=?').run(previous!.database_name, vault.id);
      audit(user.id, 'vault.rebuild-revert', vault.id);
      db.exec('COMMIT');
    } else fail(404, 'Route not found');
    return publicVault(db.prepare('SELECT * FROM vaults WHERE id=?').get(vault.id) as unknown as Vault);
  }
  async function retired(vault: Vault, user: User, rest: string[], method: string) {
    if (rest.length === 0 && method === 'GET') {
      const rows = db.prepare('SELECT database_name AS name, retired_at AS retiredAt, partial FROM retired_databases WHERE vault_id=? ORDER BY retired_at DESC').all(vault.id) as { name: string; retiredAt: number; partial: number }[];
      const result = [];
      for (const row of rows) {
        let response;
        try { response = await couch.admin(`/${row.name}`); } catch { fail(502, 'CouchDB unavailable'); }
        if (!response!.ok) { await response!.arrayBuffer(); fail(502, 'Database usage unavailable'); }
        result.push({ ...row, partial: Boolean(row.partial), diskBytes: ((await response!.json()) as { sizes: { file: number } }).sizes.file });
      }
      return result;
    }
    if (rest.length === 1 && method === 'DELETE') {
      if (!db.prepare('SELECT 1 FROM retired_databases WHERE database_name=? AND vault_id=?').get(rest[0], vault.id)) fail(404, 'Retired database not found');
      let response;
      try { response = await couch.admin(`/${rest[0]}`, 'DELETE'); } catch { fail(502, 'CouchDB unavailable'); }
      await response!.arrayBuffer();
      if (!response!.ok && response!.status !== 404) fail(502, 'Could not delete the database');
      db.prepare('DELETE FROM retired_databases WHERE database_name=?').run(rest[0]);
      audit(user.id, 'vault.database-delete', vault.id);
      return { ok: true };
    }
    return fail(404, 'Route not found');
  }
  const kindleDomains = () => settings.kindleDomains();
  const kindleDaily = () => settings.kindleDaily();
  const sentToday = (userId: string) => (db.prepare("SELECT count(*) AS n FROM kindle_deliveries WHERE user_id=? AND status='sent' AND occurred_at>?")
    .get(userId, Date.now() - 86_400_000) as { n: number }).n;
  const ownerOf = (device: Device) => db.prepare('SELECT * FROM users WHERE id=?').get(device.user_id) as unknown as User;
  function kindleReady(user: User) {
    if (!settings.smtp()) fail(503, 'Mail delivery is not configured');
    if (!user.kindle_address) fail(409, 'Kindle address not set');
    if (sentToday(user.id) >= kindleDaily()) fail(429, 'Daily Kindle delivery limit reached');
  }
  // The attachment is relayed from memory and never stored; the log keeps only name, size and outcome.
  async function deliver(user: User, deviceId: string | null, attachment: { name: string; type: string; data: Buffer }) {
    const record = (status: string, error: string | null = null) => db.prepare(
      'INSERT INTO kindle_deliveries(user_id,device_id,occurred_at,file_name,size,status,error) VALUES(?,?,?,?,?,?,?)',
    ).run(user.id, deviceId, Date.now(), attachment.name, attachment.data.length, status, error);
    try {
      await sendMail(settings.smtp()!, { to: user.kindle_address!, subject: attachment.name.replace(/\.[^.]+$/, '').slice(0, 60), text: 'Sent by Tabularium.\n', attachment });
    } catch (error) {
      const reason = (error as Error).message.slice(0, 300);
      record('failed', reason);
      fail(502, `Mail delivery failed: ${reason}`);
    }
    record('sent');
  }
  function epubName(header: string | string[] | undefined) {
    let name = 'Tabularium';
    if (typeof header === 'string') {
      try { name = decodeURIComponent(header); } catch { fail(400, 'Invalid file name'); }
    }
    name = name.replace(/[\x00-\x1f\x7f/\\]/g, ' ').trim().slice(0, 120).replace(/\.epub$/i, '') || 'Tabularium';
    return `${name}.epub`;
  }
  const server = createServer((req, res) => {
    stats.requests++;
    res.once('finish', () => { stats.statuses[res.statusCode] = (stats.statuses[res.statusCode] ?? 0) + 1; });
    void handle(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) json(res, error.status, { error: error.message });
      else { console.error('Gateway request failed:', error.code ?? error.name); json(res, 500, { error: 'Internal server error' }); }
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin) {
      if (!isBrowserOrigin(req, origin) && !config.origins.includes(origin)) fail(403, 'Origin not allowed');
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-expose-headers', 'etag, retry-after');
      res.setHeader('vary', 'Origin');
    }
    const [path, ...query] = req.url!.split('?');
    const parts = segments(path);
    if (serveConsole(path, req.method!, res)) return;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, accept, if-none-match, if-match, x-csrf-token', 'access-control-max-age': '600' });
      res.end(); return;
    }
    if (path === '/health/live' && req.method === 'GET') { json(res, 200, { ok: true }); return; }
    if (path === '/health/ready' && req.method === 'GET') {
      let ready = false;
      try { const check = await couch.admin('/_up'); ready = check.ok; await check.arrayBuffer(); } catch { /* Upstream failure means not ready. */ }
      json(res, ready ? 200 : 503, { ok: ready }); return;
    }
    if (parts[0] === 'sync') { await proxy(req, res, parts, query.length ? `?${query.join('?')}` : ''); return; }
    if (parts[0] === 's' && parts.length === 2 && await shares.handle(req, res, path, [], req.method!)) return;
    if (parts[0] !== 'api' || parts[1] !== 'v1') fail(404, 'Route not found');
    const route = parts.slice(2);
    const method = req.method;
    if (await shares.handle(req, res, path, route, method!)) return;
    if (['/api/v1/sessions', '/api/v1/web-session'].includes(path) && method === 'POST') {
      const web = path === '/api/v1/web-session';
      if (web && !isBrowserOrigin(req)) fail(403, 'Browser login requires same origin');
      // Behind a reverse proxy every request comes from the proxy's address, so the limit is kept per account (against
      // guessing one password) with a looser one per address (against trying many accounts), and nobody locks out everyone.
      limit(`login:${req.socket.remoteAddress}`, settings.loginLimit() * 10, res);
      const data = await body(req);
      const username = field(data, 'username'); const password = field(data, 'password', 1024);
      limit(`login-user:${username.toLowerCase()}`, settings.loginLimit(), res);
      const user = db.prepare('SELECT * FROM users WHERE username=?').get(username) as unknown as User | undefined;
      // An unknown user costs the same time as a wrong password, so the timing does not tell which usernames exist.
      const valid = await verifyPassword(password, user?.password_hash ?? await unknownUserHash);
      if (!user || user.disabled || !valid) fail(401, 'Invalid username or password');
      const accessToken = token(); const expiresAt = Date.now() + settings.sessionMs();
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(accessToken), user!.id, expiresAt);
      if (web) {
        setSessionCookie(res, accessToken, Math.ceil((expiresAt - Date.now()) / 1000));
        json(res, 201, { csrf: csrfFor(digest(accessToken)), expiresAt, user: publicUser(user!) });
      } else json(res, 201, { token: accessToken, expiresAt, user: publicUser(user!) });
      return;
    }
    // A device in use renews its own credentials: the secret stays, the expiry restarts from now.
    if (path === '/api/v1/devices/current/renew' && method === 'POST') {
      const device = deviceAuth(req);
      limit(`renew:${device.id}`, 10, res);
      const expiresAt = Date.now() + settings.deviceMs();
      db.prepare('UPDATE devices SET expires_at=? WHERE id=?').run(expiresAt, device.id);
      audit(device.user_id, 'device.renew', device.id);
      json(res, 200, { expiresAt });
      return;
    }
    // A client that was connected before it could report itself joins its client with the credentials it has.
    if (path === '/api/v1/devices/current/machine' && method === 'POST') {
      const device = deviceAuth(req);
      limit(`machine:${device.id}`, 10, res);
      const data = await body(req);
      const report = clientReport(data, field(data, 'name'));
      if (!report) fail(400, 'Invalid machine');
      const machine = machines.attach(device, report!);
      json(res, 200, { machineId: machine.id, name: machine.name });
      return;
    }
    if (path === '/api/v1/devices/current' && method === 'DELETE') {
      const device = deviceAuth(req);
      revokeDevice(device.vault_id, device.id, device.user_id);
      json(res, 200, { ok: true });
      return;
    }
    // Kindle delivery from the plug-in authenticates with the device's sync credentials.
    if (path === '/api/v1/kindle/status' && method === 'GET') {
      const owner = ownerOf(deviceAuth(req));
      json(res, 200, { configured: Boolean(settings.smtp()), address: owner.kindle_address, dailyLimit: kindleDaily(), remaining: Math.max(0, kindleDaily() - sentToday(owner.id)) });
      return;
    }
    if (path === '/api/v1/kindle/send' && method === 'POST') {
      const device = deviceAuth(req);
      limit(`kindle:${device.id}`, 30, res);
      const owner = ownerOf(device);
      kindleReady(owner);
      const name = epubName(req.headers['x-tabularium-filename']);
      const data = await raw(req, settings.kindleMaxBytes());
      if (!isEpub(data)) fail(400, 'Body is not an EPUB');
      await deliver(owner, device.id, { name, type: 'application/epub+zip', data });
      json(res, 200, { ok: true }); return;
    }
    const { user, hash } = session(req);
    if (path === '/api/v1/web-session' && method === 'GET') { json(res, 200, { user: publicUser(user), csrf: csrfFor(hash) }); return; }
    if (path === '/api/v1/me' && method === 'GET') { json(res, 200, publicUser(user)); return; }
    if (['/api/v1/sessions/current', '/api/v1/web-session'].includes(path) && method === 'DELETE') {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); setSessionCookie(res, '', 0); json(res, 200, { ok: true }); return;
    }
    // Colour schemes: a built-in theme, or one of the account's own schemes (the one in use is kept in theme_recipe).
    const schemes = () => JSON.parse(user.custom_themes || '[]') as Scheme[];
    const activeScheme = () => user.theme === 'custom' && user.theme_recipe ? (JSON.parse(user.theme_recipe) as Scheme).id : undefined;
    const schemeName = (value: unknown) => {
      const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
      if (!name || name.length > 40) fail(400, 'Invalid scheme name');
      return name;
    };
    if (path === '/api/v1/me/theme' && method === 'PUT') {
      const data = await body(req);
      const theme = field({ theme: '', ...data }, 'theme', 32, 0);
      if (!THEMES.includes(theme)) fail(400, 'Unknown theme');
      // A custom theme is one of the account's schemes; choosing another theme keeps them all.
      const chosen = theme === 'custom' ? schemes().find(item => item.id === data.id) : undefined;
      if (theme === 'custom' && !chosen) fail(404, 'Scheme not found');
      if (chosen) db.prepare('UPDATE users SET theme=?, theme_recipe=? WHERE id=?').run(theme, JSON.stringify(chosen), user.id);
      else db.prepare('UPDATE users SET theme=? WHERE id=?').run(theme || null, user.id);
      json(res, 200, { theme, recipe: chosen ?? null }); return;
    }
    if (path === '/api/v1/me/themes' && method === 'POST') {
      const data = await body(req);
      const list = schemes();
      if (list.length >= SCHEMES_LIMIT) fail(409, 'Too many schemes');
      const scheme: Scheme = { id: randomUUID(), name: schemeName(data.name), ...recipe(data) };
      db.prepare('UPDATE users SET custom_themes=? WHERE id=?').run(JSON.stringify([...list, scheme]), user.id);
      json(res, 201, scheme); return;
    }
    const schemePath = /^\/api\/v1\/me\/themes\/([\w-]{1,64})$/.exec(path);
    if (schemePath && (method === 'PUT' || method === 'DELETE')) {
      const list = schemes();
      const index = list.findIndex(item => item.id === schemePath[1]);
      if (index < 0) fail(404, 'Scheme not found');
      const inUse = activeScheme() === schemePath[1];
      if (method === 'DELETE') {
        list.splice(index, 1);
        // The scheme in use goes: the pages go back to the default theme.
        db.prepare(`UPDATE users SET custom_themes=?${inUse ? ', theme=NULL, theme_recipe=NULL' : ''} WHERE id=?`).run(JSON.stringify(list), user.id);
        json(res, 200, { ok: true }); return;
      }
      const data = await body(req);
      const scheme: Scheme = { id: list[index].id, name: data.name === undefined ? list[index].name : schemeName(data.name), ...recipe(data) };
      list[index] = scheme;
      db.prepare(`UPDATE users SET custom_themes=?${inUse ? ', theme_recipe=?' : ''} WHERE id=?`).run(...[JSON.stringify(list), ...(inUse ? [JSON.stringify(scheme)] : []), user.id]);
      json(res, 200, scheme); return;
    }
    if (path === '/api/v1/me/password' && method === 'PUT') {
      const data = await body(req);
      if (!await verifyPassword(field(data, 'currentPassword', 1024), user.password_hash)) fail(401, 'Invalid current password');
      const replacement = await passwordHash(field(data, 'password', 1024, 12));
      db.exec('BEGIN');
      db.prepare('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?').run(replacement, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id, hash);
      audit(user.id, 'user.password-change', user.id);
      db.exec('COMMIT'); json(res, 200, { ok: true }); return;
    }
    if (user.must_change_password) fail(403, 'Change initial password first');
    if (path === '/api/v1/home' && method === 'GET') { json(res, 200, await home(user)); return; }
    if (route[0] === 'me' && route[1] === 'kindle') {
      if (route.length === 2 && method === 'GET') {
        json(res, 200, { address: user.kindle_address, configured: Boolean(settings.smtp()), from: settings.smtp()?.from ?? null,
          domains: kindleDomains(), dailyLimit: kindleDaily(), sentToday: sentToday(user.id) });
        return;
      }
      if (route.length === 2 && method === 'PUT') {
        const address = field(await body(req), 'address', 254, 0).trim().toLowerCase();
        if (address && !(/^[^\s@]+@[^\s@]+$/.test(address) && kindleDomains().includes(address.split('@')[1]))) fail(400, 'Address must be on an allowed Kindle domain');
        db.prepare('UPDATE users SET kindle_address=? WHERE id=?').run(address || null, user.id);
        audit(user.id, 'user.kindle-address', user.id);
        json(res, 200, { address: address || null }); return;
      }
      if (route.length === 3 && route[2] === 'test' && method === 'POST') {
        kindleReady(user);
        await deliver(user, null, { name: 'Tabularium test.txt', type: 'text/plain; charset=UTF-8',
          data: Buffer.from('这是一封来自 Tabularium 的测试邮件。\nThis is a test message from Tabularium.\n') });
        json(res, 200, { ok: true }); return;
      }
      if (route.length === 3 && route[2] === 'deliveries' && method === 'GET') {
        json(res, 200, db.prepare("SELECT occurred_at AS occurredAt, file_name AS fileName, size, status, error FROM kindle_deliveries WHERE user_id=? AND file_name<>'' ORDER BY id DESC LIMIT 50").all(user.id));
        return;
      }
      if (route.length === 3 && route[2] === 'deliveries' && method === 'DELETE') {
        // What was sent in the last day still counts towards the daily limit, as a row without any details.
        const since = Date.now() - 86_400_000;
        db.prepare("DELETE FROM kindle_deliveries WHERE user_id=? AND NOT (status='sent' AND occurred_at>?)").run(user.id, since);
        db.prepare("UPDATE kindle_deliveries SET file_name='', size=0, error=NULL WHERE user_id=?").run(user.id);
        json(res, 200, { ok: true });
        return;
      }
    }
    if (route[0] === 'tabularius') {
      if (!tabularius) fail(503, 'Tabularius is not configured');
      const t = tabularius!;
      if (route.length === 1 && method === 'GET') {
        const vaults = db.prepare('SELECT * FROM vaults WHERE owner_id=?').all(user.id) as unknown as Vault[];
        const overview = t.overview();
        json(res, 200, { ...overview, knowledge: overview.knowledge && user.role === 'admin', admin: user.role === 'admin',
          modes: user.role === 'admin' ? MODES.slice(0, MODES.indexOf(t.modeLimit()) + 1) : ['read-only'], vaults: vaults.map(t.status) }); return;
      }
      // LLM settings: providers and keys, models, recipes, the default prompt, the knowledge base. Administrators only.
      if (route[1] === 'settings') {
        if (user.role !== 'admin') fail(403, 'Administrator required');
        if (route.length === 2 && method === 'GET') { json(res, 200, t.settings()); return; }
        if (route.length === 2 && method === 'PUT') {
          const result = await t.updateSettings(await body(req, 262_144));
          audit(user.id, 'tabularius.settings', user.id);
          json(res, 200, result); return;
        }
        if (route.length === 3 && route[2] === 'test' && method === 'POST') { json(res, 200, await t.testModel(field(await body(req), 'model', 200))); return; }
        if (route.length === 4 && route[2] === 'models' && method === 'GET') { json(res, 200, await t.providerModels(route[3])); return; }
        if (route.length === 3 && route[2] === 'embedding-models' && method === 'GET') { json(res, 200, await t.embeddingModels()); return; }
        if (route.length === 3 && route[2] === 'datasets' && method === 'POST') { json(res, 200, await t.datasets(field(await body(req), 'url', 500))); return; }
        if (route.length === 3 && route[2] === 'knowledge' && method === 'POST') { json(res, 200, await t.testKnowledge(field(await body(req), 'question', 500))); return; }
        fail(404, 'Route not found');
      }
      if (route[1] === 'vaults' && route.length >= 3) {
        const vault = ownedVault(route[2], user);
        if (route.length === 3 && method === 'POST') {
          const data = await body(req, 65_536);
          if (data.confirm !== true) fail(400, 'Confirmation required');
          await t.enable(vault, user, field(data, 'passphrase', 1024), field({ excluded: '', ...data }, 'excluded', 20_000, 0), field({ masks: '', ...data }, 'masks', 20_000, 0));
          audit(user.id, 'tabularius.enable', vault.id);
          json(res, 201, t.status(vault)); return;
        }
        if (route.length === 3 && method === 'DELETE') {
          await t.disable(vault.id);
          audit(user.id, 'tabularius.disable', vault.id);
          json(res, 200, t.status(vault)); return;
        }
        if (route.length === 4 && route[3] === 'rules' && method === 'PUT') {
          const data = await body(req, 65_536);
          t.rules(vault.id, field(data, 'excluded', 20_000, 0), field(data, 'masks', 20_000, 0));
          json(res, 200, t.status(vault)); return;
        }
        if (route.length === 4 && route[3] === 'knowledge' && method === 'PUT') {
          const data = await body(req);
          if (typeof data.enabled !== 'boolean') fail(400, 'enabled must be a boolean');
          t.setKnowledge(vault.id, user, data.enabled as boolean);
          audit(user.id, data.enabled ? 'tabularius.knowledge.enable' : 'tabularius.knowledge.disable', vault.id);
          json(res, 200, t.status(vault)); return;
        }
        if (route.length === 4 && route[3] === 'web' && method === 'PUT') {
          const data = await body(req);
          if (typeof data.enabled !== 'boolean') fail(400, 'enabled must be a boolean');
          t.setWeb(vault.id, data.enabled as boolean);
          audit(user.id, data.enabled ? 'tabularius.web.enable' : 'tabularius.web.disable', vault.id);
          json(res, 200, t.status(vault)); return;
        }
        if (route.length === 4 && route[3] === 'prompt' && method === 'PUT') {
          t.setPrompt(vault.id, field(await body(req, 131_072), 'prompt', 40_000, 0));
          json(res, 200, t.status(vault)); return;
        }
        if (route.length === 4 && route[3] === 'prompt' && method === 'GET') { json(res, 200, t.preview(vault.id)); return; }
        if (route.length === 5 && route[3] === 'prompt' && route[4] === 'import' && method === 'POST') { json(res, 200, { prompt: await t.importPrompt(vault.id) }); return; }
        if (route.length === 4 && route[3] === 'recipe' && method === 'PUT') {
          t.setRecipe(vault.id, (await body(req)).recipe ?? null);
          json(res, 200, t.status(vault)); return;
        }
        if (route.length === 4 && route[3] === 'mode' && method === 'PUT') {
          const data = await body(req);
          t.setMode(vault.id, user, data.mode);
          audit(user.id, `tabularius.mode.${data.mode}`, vault.id);
          json(res, 200, t.status(vault)); return;
        }
        if (route.length === 4 && route[3] === 'conversations' && method === 'GET') { json(res, 200, t.conversations(vault.id, user)); return; }
        if (route.length === 4 && route[3] === 'projects' && method === 'GET') { json(res, 200, t.projects(vault.id, user)); return; }
        if (route.length === 4 && route[3] === 'projects' && method === 'POST') { json(res, 201, t.createProject(vault.id, user, (await body(req)).name)); return; }
        if (route.length === 4 && route[3] === 'conversations' && method === 'POST') {
          const data = await body(req, 131_072);
          // A message may be attachments alone; its text is then empty.
          await t.start_conversation(res, vault.id, user, field(data, 'message', 8000, 0), { recipe: data.recipe, prompt: data.prompt, params: data.params, web: data.web, attachments: data.attachments }); return;
        }
        if (route.length === 4 && route[3] === 'attachments' && method === 'POST') {
          // The file is the request body; its name comes URL-encoded in a header.
          let name = '';
          try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).normalize('NFC'); } catch { fail(400, 'Invalid file name'); }
          if (!name || name.length > 200 || /[\u0000-\u001f/\\]/.test(name)) fail(400, 'Invalid file name');
          json(res, 201, await t.upload(vault.id, user, name, await raw(req, t.attachmentLimit()))); return;
        }
      }
      if (route[1] === 'vaults' && route.length === 4 && route[3] === 'proposals' && method === 'GET') {
        json(res, 200, t.proposals(ownedVault(route[2], user).id, user)); return;
      }
      if (route[1] === 'approvals' && route.length === 3 && method === 'POST') {
        const data = await body(req);
        if (typeof data.approved !== 'boolean') fail(400, 'approved must be a boolean');
        t.decide(route[2], user, data.approved as boolean);
        json(res, 200, { ok: true }); return;
      }
      if (route[1] === 'hosts' || route[1] === 'commands') {
        if (user.role !== 'admin') fail(403, 'Administrator required');
        if (route[1] === 'commands' && route.length === 2 && method === 'GET') { json(res, 200, t.commands()); return; }
        if (route[1] === 'commands' && route.length === 2 && method === 'DELETE') { t.clearCommands(); audit(user.id, 'tabularius.commands-clear', user.id); json(res, 200, { ok: true }); return; }
        if (route.length === 2 && method === 'GET') { json(res, 200, t.hosts()); return; }
        if (route.length === 2 && method === 'POST') {
          const data = await body(req);
          const port = Number(data.port ?? 22);
          if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, 'Invalid port');
          const host = t.addHost({ name: field(data, 'name', 64), address: field(data, 'address', 255), port, username: field(data, 'username', 64),
            policy: field(data, 'policy', 16), commands: field({ commands: '', ...data }, 'commands', 20_000, 0) });
          audit(user.id, 'tabularius.host.add', host.id);
          json(res, 201, host); return;
        }
        if (route.length === 3 && method === 'PUT') {
          const data = await body(req);
          const host = t.updateHost(route[2], { policy: field(data, 'policy', 16), commands: field({ commands: '', ...data }, 'commands', 20_000, 0) });
          audit(user.id, 'tabularius.host.update', route[2]);
          json(res, 200, host); return;
        }
        if (route.length === 3 && method === 'DELETE') { t.removeHost(route[2]); audit(user.id, 'tabularius.host.remove', route[2]); json(res, 200, { ok: true }); return; }
        if (route.length === 4 && route[3] === 'check' && method === 'POST') {
          const host = await t.checkHost(route[2]);
          audit(user.id, 'tabularius.host.check', route[2]);
          json(res, 200, host); return;
        }
      }
      if (route[1] === 'memories') {
        if (route.length === 2 && method === 'GET') { json(res, 200, t.memories(user)); return; }
        if (route.length === 2 && method === 'POST') { json(res, 201, await t.addMemory(user, (await body(req)).content)); return; }
        if (route.length === 3 && method === 'PUT') { json(res, 200, await t.updateMemory(user, route[2], (await body(req)).content)); return; }
        if (route.length === 3 && method === 'DELETE') { t.removeMemory(user, route[2]); json(res, 200, { ok: true }); return; }
      }
      if (route[1] === 'proposals' && route.length >= 3) {
        if (route.length === 3 && method === 'GET') { json(res, 200, t.proposal(route[2], user)); return; }
        if (route.length === 4 && route[3] === 'apply' && method === 'POST') {
          const result = await t.apply(route[2], user);
          audit(user.id, 'tabularius.apply', route[2]);
          json(res, 200, result); return;
        }
        if (route.length === 4 && route[3] === 'discard' && method === 'POST') { json(res, 200, t.discard(route[2], user)); return; }
      }
      if (route[1] === 'projects' && route.length === 3) {
        if (method === 'PATCH') { t.renameProject(route[2], user, (await body(req)).name); json(res, 200, { ok: true }); return; }
        if (method === 'DELETE') { t.removeProject(route[2], user); json(res, 200, { ok: true }); return; }
      }
      if (route[1] === 'conversations' && route.length >= 3) {
        if (route.length === 3 && method === 'GET') { json(res, 200, t.conversation(route[2], user)); return; }
        if (route.length === 3 && method === 'DELETE') { t.remove_conversation(route[2], user); json(res, 200, { ok: true }); return; }
        if (route.length === 3 && method === 'PATCH') { json(res, 200, t.configure(route[2], user, await body(req, 131_072))); return; }
        if (route.length === 4 && route[3] === 'messages' && method === 'POST') {
          const data = await body(req, 65_536);
          await t.continue_conversation(res, route[2], user, field(data, 'message', 8000, 0), data.attachments); return;
        }
      }
      if (route[1] === 'attachments' && route.length === 3 && method === 'GET') {
        // Opened in the browser (images) or saved (text files, PDFs); served as inert bytes either way.
        const file = t.attachment(route[2], user);
        res.writeHead(200, { 'content-type': file.mime === 'text/plain' ? 'text/plain; charset=utf-8' : file.mime, 'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox",
          'content-disposition': `${file.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}` });
        res.end(file.data); return;
      }
      fail(404, 'Route not found');
    }
    if (route[0] === 'admin') {
      if (user.role !== 'admin') fail(403, 'Administrator required');
      if (route[1] === 'shares') { await shares.admin(res, user, route, method!); return; }
      // Running settings: mail and Kindle, sharing, access. Changes apply to the next request.
      if (route[1] === 'settings') {
        if (route.length === 2 && method === 'GET') { json(res, 200, settings.view()); return; }
        if (route.length === 2 && method === 'PUT') {
          try { settings.update(await body(req, 65_536)); } catch (error) {
            if (error instanceof ServerSettingsError) fail(400, error.message);
            throw error;
          }
          audit(user.id, 'server.settings', user.id);
          json(res, 200, settings.view()); return;
        }
        if (route.length === 3 && route[2] === 'mail-test' && method === 'POST') {
          const smtp = settings.smtp();
          if (!smtp) fail(409, 'Mail delivery is not configured');
          const to = field(await body(req), 'to', 254);
          if (!/^[^\s@]+@[^\s@]+$/.test(to)) fail(400, 'Invalid address');
          try { await sendMail(smtp!, { to, subject: 'Tabularium', text: '这是一封来自 Tabularium 的测试邮件。\nThis is a test message from Tabularium.\n',
            attachment: { name: 'Tabularium test.txt', type: 'text/plain; charset=UTF-8', data: Buffer.from('Tabularium mail test\n') } }); }
          catch (error) { fail(502, `Mail delivery failed: ${(error as Error).message.slice(0, 300)}`); }
          json(res, 200, { ok: true }); return;
        }
      }
      if (path === '/api/v1/admin/audit' && method === 'DELETE') {
        db.prepare('DELETE FROM audit_events').run();
        json(res, 200, { ok: true }); return;
      }
      if (path === '/api/v1/admin/audit' && method === 'GET') {
        json(res, 200, db.prepare(`SELECT a.id,a.occurred_at AS occurredAt,a.actor_id AS actorId,
          u.username AS actor,a.action,a.target_id AS targetId FROM audit_events a
          LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100`).all()); return;
      }
      if (path === '/api/v1/admin/overview' && method === 'GET') {
        const counts = db.prepare(`SELECT (SELECT count(*) FROM users) AS users,
          (SELECT count(*) FROM users WHERE disabled=0) AS activeUsers,
          (SELECT count(*) FROM vaults) AS vaults,
          (SELECT count(*) FROM devices WHERE revoked=0 AND expires_at>?) AS devices`).get(Date.now());
        json(res, 200, { ...stats, ...counts, activeProxyConnections: active.size, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), backupFailure: backups.lastFailure() }); return;
      }
      if (path === '/api/v1/admin/backups' && method === 'GET') { json(res, 200, await backups.view()); return; }
      if (path === '/api/v1/admin/backups/settings' && method === 'PUT') {
        try { backups.update(await body(req)); } catch (error) { if (error instanceof BackupError) fail(400, error.message); throw error; }
        audit(user.id, 'backup.settings', 'server');
        json(res, 200, await backups.view()); return;
      }
      if (path === '/api/v1/admin/backups/run' && method === 'POST') {
        let run;
        try { run = backups.run(); } catch (error) { if (error instanceof BackupError) fail(409, error.message); throw error; }
        audit(user.id, 'backup.run', 'server');
        // The backup goes on in the background; the page follows it through the history.
        void run.catch(() => {});
        json(res, 202, await backups.view()); return;
      }
      if (route[1] === 'vaults') {
        if (route.length === 2 && method === 'GET') {
          const rows = db.prepare(`SELECT v.*,u.username AS owner FROM vaults v JOIN users u ON u.id=v.owner_id`).all();
          json(res, 200, rows.map(row => ({ ...publicVault(row as unknown as Vault), ownerId: row.owner_id, owner: row.owner }))); return;
        }
        if (route.length === 2 && method === 'POST') {
          const data = await body(req); const ownerId = field(data, 'ownerId'); const name = field(data, 'name');
          if (!db.prepare('SELECT id FROM users WHERE id=? AND disabled=0').get(ownerId)) fail(404, 'Enabled owner not found');
          const id = randomUUID();
          const vault: Vault = { id, owner_id: ownerId, name, database_name: `tab_${id.replaceAll('-', '')}`, state: 'provisioning', rebuild_device: null, rebuild_until: null, rebuild_started: null };
          db.prepare('INSERT INTO vaults(id,owner_id,name,database_name,state) VALUES(?,?,?,?,?)').run(id, ownerId, name, vault.database_name, vault.state);
          audit(user.id, 'vault.create', id);
          json(res, 201, await provision(vault, user.id)); return;
        }
        if (route.length < 3) fail(404, 'Route not found');
        const vault = db.prepare('SELECT * FROM vaults WHERE id=?').get(route[2]) as unknown as Vault | undefined;
        if (!vault) fail(404, 'Vault not found');
        if (route.length === 4 && route[3] === 'provision' && method === 'POST') {
          json(res, 200, await provision(vault!, user.id)); return;
        }
        if (route.length === 4 && route[3] === 'compact' && method === 'POST') { await compact(vault!, user.id); json(res, 200, { ok: true }); return; }
        if (route.length === 4 && route[3] === 'usage' && method === 'GET') {
          let response;
          try { response = await couch.admin(`/${vault!.database_name}`); } catch { fail(502, 'CouchDB unavailable'); }
          if (!response!.ok) { await response!.arrayBuffer(); fail(502, 'Vault usage unavailable'); }
          const info = await response!.json() as { sizes: { file: number; active: number; external: number }; doc_count: number; doc_del_count: number };
          json(res, 200, { diskBytes: info.sizes.file, activeBytes: info.sizes.active, documentBytes: info.sizes.external, documents: info.doc_count, deletedDocuments: info.doc_del_count }); return;
        }
        if (route.length === 4 && route[3] === 'devices' && method === 'GET') {
          json(res, 200, deviceList(vault!.id)); return;
        }
        if (route.length === 5 && route[3] === 'devices' && method === 'DELETE') {
          revokeDevice(vault!.id, route[4], user.id);
          json(res, 200, { ok: true }); return;
        }
      }
      fail(404, 'Route not found');
    }
    if (route[0] === 'users' || route[0] === 'metrics') {
      if (user.role !== 'admin') fail(403, 'Administrator required');
      if (path === '/api/v1/metrics' && method === 'GET') { json(res, 200, { ...stats, activeProxyConnections: active.size }); return; }
      if (route[0] === 'users' && route.length === 1 && method === 'GET') {
        json(res, 200, (db.prepare('SELECT * FROM users').all() as unknown as User[]).map(publicUser)); return;
      }
      if (route[0] === 'users' && route.length === 1 && method === 'POST') {
        const data = await body(req); const username = field(data, 'username');
        if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) fail(409, 'Username already exists');
        const id = randomUUID(); const password = await passwordHash(field(data, 'password', 1024, 12));
        db.prepare('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)').run(id, username, password, 'user');
        audit(user.id, 'user.create', id);
        json(res, 201, { id, username, mustChangePassword: true }); return;
      }
      if (route.length === 2 && route[0] === 'users' && method === 'PATCH') {
        const data = await body(req);
        if (typeof data.disabled !== 'boolean') fail(400, 'Invalid disabled');
        if (route[1] === user.id) fail(400, 'Cannot disable current administrator');
        const result = db.prepare('UPDATE users SET disabled=? WHERE id=?').run(data.disabled ? 1 : 0, route[1]);
        if (!result.changes) fail(404, 'User not found');
        if (data.disabled) {
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(route[1]);
          cancel(v => v.user === route[1]);
        }
        audit(user.id, data.disabled ? 'user.disable' : 'user.enable', route[1]);
        json(res, 200, { ok: true }); return;
      }
    }
    if (route[0] === 'machines') {
      if (route.length === 1 && method === 'GET') { json(res, 200, machines.list(user.id)); return; }
      if (route.length === 2 && method === 'PATCH') { machines.rename(route[1], user.id, field(await body(req), 'name')); json(res, 200, { ok: true }); return; }
      if (route.length === 2 && method === 'DELETE') { machines.remove(route[1], user.id); json(res, 200, { ok: true }); return; }
    }
    if (route[0] === 'vaults') {
      if (route.length === 1 && method === 'GET') {
        json(res, 200, (db.prepare('SELECT * FROM vaults WHERE owner_id=?').all(user.id) as unknown as Vault[]).map(publicVault)); return;
      }
      if (route.length === 1 && method === 'POST') {
        const name = field(await body(req), 'name'); const id = randomUUID();
        const vault: Vault = { id, owner_id: user.id, name, database_name: `tab_${id.replaceAll('-', '')}`, state: 'provisioning', rebuild_device: null, rebuild_until: null, rebuild_started: null };
        db.prepare('INSERT INTO vaults(id,owner_id,name,database_name,state) VALUES(?,?,?,?,?)').run(id, user.id, name, vault.database_name, vault.state);
        audit(user.id, 'vault.create', id);
        json(res, 201, await provision(vault, user.id)); return;
      }
      if (route.length < 2) fail(404, 'Route not found');
      const vault = ownedVault(route[1], user);
      if (route.length === 2 && method === 'GET') { json(res, 200, publicVault(vault)); return; }
      if (route.length === 3 && route[2] === 'provision' && method === 'POST') { json(res, 200, await provision(vault, user.id)); return; }
      if (route.length === 3 && route[2] === 'compact' && method === 'POST') { await compact(vault, user.id); json(res, 200, { ok: true }); return; }
      if (route[2] === 'rebuild') { json(res, 200, await rebuild(req, vault, user, route.slice(3), method!)); return; }
      if (route[2] === 'databases') { json(res, 200, await retired(vault, user, route.slice(3), method!)); return; }
      if (route[2] === 'devices') {
        if (route.length === 3 && method === 'GET') {
          json(res, 200, deviceList(vault.id)); return;
        }
        if (route.length === 3 && method === 'POST') {
          if (vault.state !== 'ready') fail(409, 'Vault is not ready');
          const data = await body(req);
          const name = field(data, 'name'); const report = clientReport(data, name); const id = randomUUID(); const secret = token();
          const expiresAt = Date.now() + settings.deviceMs();
          db.prepare('INSERT INTO devices(id,user_id,vault_id,name,secret_hash,expires_at) VALUES(?,?,?,?,?,?)')
            .run(id, user.id, vault.id, name, digest(secret), expiresAt);
          audit(user.id, 'device.issue', id);
          const machine = report && machines.attach({ id, user_id: user.id, vault_id: vault.id }, report);
          json(res, 201, { id, username: id, password: secret, expiresAt, syncPath: `/sync/${vault.id}`, ...(machine ? { machineId: machine.id, machineName: machine.name } : {}) }); return;
        }
        if (route.length === 4 && method === 'DELETE') {
          revokeDevice(vault.id, route[3], user.id); json(res, 200, { ok: true }); return;
        }
      }
    }
    fail(404, 'Route not found');
  }
  return {
    server,
    async listen(port = 0, host = '127.0.0.1') {
      server.listen(port, host); await once(server, 'listening');
      const bound = (server.address() as import('node:net').AddressInfo).port;
      // The hosted clients sync through this gateway like any other device.
      await tabularius?.start(`http://127.0.0.1:${bound}/sync`);
      return `http://${host}:${bound}`;
    },
    async close() {
      await backups.close();
      await tabularius?.close();
      clearInterval(cleanup); cancel(() => true);
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
}
