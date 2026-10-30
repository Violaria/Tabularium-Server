import { createServer, request, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { openStore, passwordHash, verifyPassword, token, digest, type User, type Vault, type Device } from './store.js';
import { loadConsole } from './console-assets.js';
import { rejection } from './policy.js';
import { sendMail, type SmtpConfig } from './smtp.js';
import { Couch, basic, type CouchConfig } from './couch.js';
import { createTabularius, type TabulariusConfig } from './tabularius/index.js';

export interface Config {
  database: string; couch: CouchConfig; bootstrapUser?: string; bootstrapPassword?: string;
  origins: string[]; sessionMs?: number; deviceMs?: number; streamMs?: number;
  loginLimit?: number; syncLimit?: number; publicUrl?: string; rebuildMs?: number; writeLimit?: number; auditDays?: number;
  smtp?: SmtpConfig; kindleDomains?: string[]; kindleDaily?: number; kindleMaxBytes?: number;
  tabularius?: TabulariusConfig;
}
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request body too large');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'Invalid JSON'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail(400, 'Expected JSON object');
  return parsed;
}
async function raw(req: IncomingMessage, limit: number) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function payload(req: IncomingMessage, limit: number) {
  const data = await raw(req, limit);
  try { return { data, parsed: JSON.parse(data.toString()) }; } catch { return fail(400, 'Invalid JSON'); }
}
// An EPUB starts with an uncompressed `mimetype` entry holding application/epub+zip (OCF 3.3 §4.3).
const isEpub = (data: Buffer) => data.length > 58 && data.readUInt32LE(0) === 0x04034b50 && data.readUInt16LE(28) === 0 &&
  data.subarray(30, 38).toString() === 'mimetype' && data.subarray(38, 58).toString() === 'application/epub+zip';
const forbidden = (id: unknown, reason: string) => ({ id, error: 'forbidden', reason });
function field(data: Record<string, unknown>, key: string, max = 128, min = 1): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(400, `Invalid ${key}`);
  return value as string;
}
const publicUser = (u: User) => ({ id: u.id, username: u.username, role: u.role, disabled: Boolean(u.disabled), mustChangePassword: Boolean(u.must_change_password) });
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
  const db = openStore(config.database);
  const couch = new Couch(config.couch);
  const active = new Map<ClientRequest, { device: string; user: string; vault: string; res: ServerResponse }>();
  const limits = new Map<string, { count: number; until: number }>();
  const stats = { requests: 0, proxyRequests: 0, statuses: {} as Record<string, number> };
  const prune = () => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('DELETE FROM audit_events WHERE occurred_at <= ?').run(Date.now() - (config.auditDays ?? 365) * 86_400_000);
    db.prepare('DELETE FROM kindle_deliveries WHERE occurred_at <= ?').run(Date.now() - (config.auditDays ?? 365) * 86_400_000);
  };
  prune();
  const tabularius = config.tabularius
    ? createTabularius(db, couch, config.tabularius, config.deviceMs ?? 2_592_000_000, fail, device => cancel(v => v.device === device)) : undefined;
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
      if (!isBrowserOrigin(req) || req.headers['x-csrf-token'] !== csrfFor(hash)) fail(403, 'Invalid CSRF token or origin');
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
    limit(`device:${device.id}`, config.syncLimit ?? 2400, res);
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
      const limit = config.writeLimit ?? 67_108_864;
      if (req.method === 'PUT' && rest.length === 1) {
        const { data, parsed } = await payload(req, limit);
        const reason = rejection({ ...parsed, _id: rest[0] });
        if (reason) { json(res, 403, forbidden(rest[0], reason)); return; }
        write = { data, rejected: [], newEdits: true };
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
        const results = JSON.parse(Buffer.concat(chunks).toString());
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
    const timer = setTimeout(() => { outgoing.destroy(); res.destroy(); }, Math.min(config.streamMs ?? 300_000, device.expires_at - Date.now()));
    timer.unref();
    res.once('close', () => { clearTimeout(timer); active.delete(outgoing); outgoing.destroy(); });
    outgoing.on('error', () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy(); else json(res, 502, { error: 'CouchDB unavailable' });
    });
    req.on('error', () => outgoing.destroy());
    if (write) outgoing.end(write.data); else req.pipe(outgoing);
  }
  async function rebuild(req: IncomingMessage, vault: Vault, user: User, rest: string[], method: string) {
    if (rest.length === 0 && method === 'POST') {
      const data = await body(req);
      const deviceId = field(data, 'deviceId');
      if (field(data, 'confirm') !== vault.name) fail(400, 'Confirmation does not match the vault name');
      if (vault.state !== 'ready') fail(409, 'Vault is not ready');
      if (vault.rebuild_started) fail(409, 'A rebuild is already in progress');
      if (!db.prepare('SELECT id FROM devices WHERE id=? AND vault_id=? AND revoked=0 AND expires_at>?').get(deviceId, vault.id, Date.now())) fail(404, 'Active device not found');
      db.prepare('UPDATE vaults SET rebuild_device=?, rebuild_until=? WHERE id=?').run(deviceId, Date.now() + (config.rebuildMs ?? 900_000), vault.id);
      audit(user.id, 'vault.rebuild-arm', vault.id);
    } else if (rest.length === 0 && method === 'DELETE') {
      clearRebuild(vault.id);
      audit(user.id, 'vault.rebuild-end', vault.id);
    } else if (rest.length === 1 && rest[0] === 'revert' && method === 'POST') {
      if (field(await body(req), 'confirm') !== vault.name) fail(400, 'Confirmation does not match the vault name');
      const previous = db.prepare('SELECT database_name FROM retired_databases WHERE vault_id=? AND partial=0 ORDER BY retired_at DESC LIMIT 1').get(vault.id) as { database_name: string } | undefined;
      if (!previous) fail(409, 'No retired database to revert to');
      cancel(v => v.vault === vault.id);
      // Undo the lock the rebuilding client placed on the previous database before replacing it.
      const path = `/${previous!.database_name}/_local/${MILESTONE}`;
      let response;
      try { response = await couch.admin(path); } catch { fail(502, 'CouchDB unavailable'); }
      if (response!.ok) {
        const milestone = await response!.json() as Record<string, unknown>;
        response = await couch.admin(path, 'PUT', { ...milestone, locked: false });
        if (!response.ok) fail(502, 'Could not unlock the previous database');
      }
      await response!.arrayBuffer();
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
  const kindleDomains = () => config.kindleDomains ?? ['kindle.com', 'free.kindle.com'];
  const kindleDaily = () => config.kindleDaily ?? 30;
  const sentToday = (userId: string) => (db.prepare("SELECT count(*) AS n FROM kindle_deliveries WHERE user_id=? AND status='sent' AND occurred_at>?")
    .get(userId, Date.now() - 86_400_000) as { n: number }).n;
  const ownerOf = (device: Device) => db.prepare('SELECT * FROM users WHERE id=?').get(device.user_id) as unknown as User;
  function kindleReady(user: User) {
    if (!config.smtp) fail(503, 'Mail delivery is not configured');
    if (!user.kindle_address) fail(409, 'Kindle address not set');
    if (sentToday(user.id) >= kindleDaily()) fail(429, 'Daily Kindle delivery limit reached');
  }
  // The attachment is relayed from memory and never stored; the log keeps only name, size and outcome.
  async function deliver(user: User, deviceId: string | null, attachment: { name: string; type: string; data: Buffer }) {
    const record = (status: string, error: string | null = null) => db.prepare(
      'INSERT INTO kindle_deliveries(user_id,device_id,occurred_at,file_name,size,status,error) VALUES(?,?,?,?,?,?,?)',
    ).run(user.id, deviceId, Date.now(), attachment.name, attachment.data.length, status, error);
    try {
      await sendMail(config.smtp!, { to: user.kindle_address!, subject: attachment.name.replace(/\.[^.]+$/, '').slice(0, 60), text: 'Sent by Tabularium.\n', attachment });
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
    if (parts[0] !== 'api' || parts[1] !== 'v1') fail(404, 'Route not found');
    const route = parts.slice(2);
    const method = req.method;
    if (['/api/v1/sessions', '/api/v1/web-session'].includes(path) && method === 'POST') {
      const web = path === '/api/v1/web-session';
      if (web && !isBrowserOrigin(req)) fail(403, 'Browser login requires same origin');
      limit(`login:${req.socket.remoteAddress}`, config.loginLimit ?? 20, res);
      const data = await body(req);
      const username = field(data, 'username'); const password = field(data, 'password', 1024);
      const user = db.prepare('SELECT * FROM users WHERE username=?').get(username) as unknown as User | undefined;
      if (!user || user.disabled || !await verifyPassword(password, user.password_hash)) fail(401, 'Invalid username or password');
      const accessToken = token(); const expiresAt = Date.now() + (config.sessionMs ?? 43_200_000);
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
      const expiresAt = Date.now() + (config.deviceMs ?? 2_592_000_000);
      db.prepare('UPDATE devices SET expires_at=? WHERE id=?').run(expiresAt, device.id);
      audit(device.user_id, 'device.renew', device.id);
      json(res, 200, { expiresAt });
      return;
    }
    // Kindle delivery from the plug-in authenticates with the device's sync credentials.
    if (path === '/api/v1/kindle/status' && method === 'GET') {
      const owner = ownerOf(deviceAuth(req));
      json(res, 200, { configured: Boolean(config.smtp), address: owner.kindle_address, dailyLimit: kindleDaily(), remaining: Math.max(0, kindleDaily() - sentToday(owner.id)) });
      return;
    }
    if (path === '/api/v1/kindle/send' && method === 'POST') {
      const device = deviceAuth(req);
      limit(`kindle:${device.id}`, 30, res);
      const owner = ownerOf(device);
      kindleReady(owner);
      const name = epubName(req.headers['x-tabularium-filename']);
      const data = await raw(req, config.kindleMaxBytes ?? 52_428_800);
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
    if (route[0] === 'me' && route[1] === 'kindle') {
      if (route.length === 2 && method === 'GET') {
        json(res, 200, { address: user.kindle_address, configured: Boolean(config.smtp), from: config.smtp?.from ?? null,
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
        json(res, 200, db.prepare('SELECT occurred_at AS occurredAt, file_name AS fileName, size, status, error FROM kindle_deliveries WHERE user_id=? ORDER BY id DESC LIMIT 50').all(user.id));
        return;
      }
    }
    if (route[0] === 'tabularius') {
      if (!tabularius) fail(503, 'Tabularius is not configured');
      const t = tabularius!;
      if (route.length === 1 && method === 'GET') {
        const vaults = db.prepare('SELECT * FROM vaults WHERE owner_id=?').all(user.id) as unknown as Vault[];
        json(res, 200, { provider: t.provider.name, model: t.provider.model, embeddings: t.embeddings, knowledge: t.knowledge && user.role === 'admin', vaults: vaults.map(t.status) }); return;
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
        if (route.length === 4 && route[3] === 'conversations' && method === 'GET') { json(res, 200, t.conversations(vault.id, user)); return; }
        if (route.length === 4 && route[3] === 'conversations' && method === 'POST') {
          await t.start_conversation(res, vault.id, user, field(await body(req, 65_536), 'message', 8000)); return;
        }
      }
      if (route[1] === 'vaults' && route.length === 4 && route[3] === 'proposals' && method === 'GET') {
        json(res, 200, t.proposals(ownedVault(route[2], user).id, user)); return;
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
      if (route[1] === 'conversations' && route.length >= 3) {
        if (route.length === 3 && method === 'GET') { json(res, 200, t.conversation(route[2], user)); return; }
        if (route.length === 3 && method === 'DELETE') { t.remove_conversation(route[2], user); json(res, 200, { ok: true }); return; }
        if (route.length === 4 && route[3] === 'messages' && method === 'POST') {
          await t.continue_conversation(res, route[2], user, field(await body(req, 65_536), 'message', 8000)); return;
        }
      }
      fail(404, 'Route not found');
    }
    if (route[0] === 'admin') {
      if (user.role !== 'admin') fail(403, 'Administrator required');
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
        json(res, 200, { ...stats, ...counts, activeProxyConnections: active.size, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }); return;
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
        if (route.length === 4 && route[3] === 'usage' && method === 'GET') {
          let response;
          try { response = await couch.admin(`/${vault!.database_name}`); } catch { fail(502, 'CouchDB unavailable'); }
          if (!response!.ok) { await response!.arrayBuffer(); fail(502, 'Vault usage unavailable'); }
          const info = await response!.json() as { sizes: { file: number; active: number; external: number }; doc_count: number; doc_del_count: number };
          json(res, 200, { diskBytes: info.sizes.file, activeBytes: info.sizes.active, documentBytes: info.sizes.external, documents: info.doc_count, deletedDocuments: info.doc_del_count }); return;
        }
        if (route.length === 4 && route[3] === 'devices' && method === 'GET') {
          json(res, 200, db.prepare('SELECT id,name,revoked,expires_at AS expiresAt FROM devices WHERE vault_id=?').all(vault!.id)); return;
        }
        if (route.length === 5 && route[3] === 'devices' && method === 'DELETE') {
          const result = db.prepare('UPDATE devices SET revoked=1 WHERE id=? AND vault_id=?').run(route[4], vault!.id);
          if (!result.changes) fail(404, 'Device not found');
          cancel(v => v.device === route[4]); audit(user.id, 'device.revoke', route[4]);
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
      if (route[2] === 'rebuild') { json(res, 200, await rebuild(req, vault, user, route.slice(3), method!)); return; }
      if (route[2] === 'databases') { json(res, 200, await retired(vault, user, route.slice(3), method!)); return; }
      if (route[2] === 'devices') {
        if (route.length === 3 && method === 'GET') {
          json(res, 200, db.prepare('SELECT id,name,revoked,expires_at AS expiresAt FROM devices WHERE vault_id=?').all(vault.id)); return;
        }
        if (route.length === 3 && method === 'POST') {
          if (vault.state !== 'ready') fail(409, 'Vault is not ready');
          const name = field(await body(req), 'name'); const id = randomUUID(); const secret = token();
          const expiresAt = Date.now() + (config.deviceMs ?? 2_592_000_000);
          db.prepare('INSERT INTO devices(id,user_id,vault_id,name,secret_hash,expires_at) VALUES(?,?,?,?,?,?)')
            .run(id, user.id, vault.id, name, digest(secret), expiresAt);
          audit(user.id, 'device.issue', id);
          json(res, 201, { id, username: id, password: secret, expiresAt, syncPath: `/sync/${vault.id}` }); return;
        }
        if (route.length === 4 && method === 'DELETE') {
          const result = db.prepare('UPDATE devices SET revoked=1 WHERE id=? AND vault_id=?').run(route[3], vault.id);
          if (!result.changes) fail(404, 'Device not found');
          cancel(v => v.device === route[3]); audit(user.id, 'device.revoke', route[3]); json(res, 200, { ok: true }); return;
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
      await tabularius?.close();
      clearInterval(cleanup); cancel(() => true);
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
}
