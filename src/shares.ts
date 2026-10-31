// Shared notes and folders. The owner's clients build each share and upload its files; for an encrypted link the
// files and the share's own record (`sealed`) are ciphertext, the key travelling only in the link's fragment. The
// server keeps plain text only for public pages, which the owner chose explicitly. A share whose time ran out or that
// was revoked keeps its row, so its link says it is no longer available, and loses its files.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { body, fail, json, raw } from './http.js';
import { digest, passwordHash, same, token, verifyPassword, type Device, type Share, type User } from './store.js';

export interface SharesConfig {
  /** false turns sharing off: nothing can be created or opened. */
  enabled: boolean;
  maxBytes: number;
  /** Base address of share links; the owner's clients build links from it. */
  url?: string;
}
interface Deps {
  db: DatabaseSync;
  /** Read on every request, so changed settings apply at once. */
  settings(): SharesConfig;
  session(req: IncomingMessage): { user: User };
  deviceAuth(req: IncomingMessage): Device;
  audit(actorId: string, action: string, targetId: string): void;
  limit(key: string, max: number, res: ServerResponse): void;
  viewer: Buffer;
}

const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}_-]{1,63}$/u;
const FILE = /^[A-Za-z0-9_-]{1,64}$/;
const MODES = ['encrypted', 'public'];
const randomSlug = () => token().replace(/[^A-Za-z0-9]/g, '').slice(0, 10);

/**
 * Upload format: for each file, its name length (2 bytes, big-endian), name (ASCII), data length (4 bytes) and data.
 * The same framing is written by the clients (`encodeBundle` in `features/tabularium/share/package.ts`).
 */
export function readBundle(data: Buffer) {
  const files = new Map<string, Buffer>();
  let at = 0;
  while (at < data.length) {
    if (at + 2 > data.length) fail(400, 'Invalid share content');
    const nameLength = data.readUInt16BE(at); at += 2;
    const name = data.subarray(at, at + nameLength).toString('latin1'); at += nameLength;
    if (!FILE.test(name) || files.has(name) || at + 4 > data.length) fail(400, 'Invalid share content');
    const size = data.readUInt32BE(at); at += 4;
    if (at + size > data.length) fail(400, 'Invalid share content');
    files.set(name, data.subarray(at, at + size)); at += size;
  }
  if (!files.has('manifest')) fail(400, 'Share content needs a manifest');
  return files;
}

export function createShares({ db, settings, session, deviceAuth, audit, limit, viewer }: Deps) {
  const state = (share: Share) => share.revoked_at ? 'revoked' : share.expires_at !== null && share.expires_at <= Date.now() ? 'expired' : 'active';
  const view = (share: Share) => ({
    id: share.id, slug: share.slug, vaultId: share.vault_id, mode: share.mode, sealed: share.sealed, expiresAt: share.expires_at,
    password: Boolean(share.password), indexable: Boolean(share.indexable), views: share.views, size: share.size,
    createdAt: share.created_at, updatedAt: share.updated_at, state: state(share),
  });
  const drop = (id: string) => {
    db.prepare('DELETE FROM share_files WHERE share_id=?').run(id);
    db.prepare('UPDATE shares SET size=0 WHERE id=?').run(id);
  };
  const access = (share: Share) => digest(`share-access:${share.id}:${share.password_hash}`);
  const expiry = (value: unknown) => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= Date.now()) return fail(400, 'Invalid expiresAt');
    return value;
  };
  const sealed = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 65_536) fail(400, 'Invalid sealed');
    return value as string;
  };
  /** The share's own settings for public pages: the password is hashed here, encrypted links only flag one. */
  async function protection(mode: string, data: Record<string, unknown>) {
    if (mode === 'public') {
      if (data.password === undefined || data.password === null || data.password === '') return { password: 0, hash: null };
      if (typeof data.password !== 'string' || data.password.length > 1024) fail(400, 'Invalid password');
      return { password: 1, hash: await passwordHash(data.password as string) };
    }
    if (data.password !== undefined && typeof data.password !== 'boolean') fail(400, 'Invalid password');
    return { password: data.password ? 1 : 0, hash: null };
  }
  function owned(id: string, user: User, device?: Device) {
    const share = db.prepare('SELECT * FROM shares WHERE id=? AND owner_id=?').get(id, user.id) as unknown as Share | undefined;
    if (!share || (device && share.vault_id !== device.vault_id)) return fail(404, 'Share not found');
    return share;
  }
  /** Owner routes under /api/v1/shares, with a browser session or a device's credentials. */
  async function owner(req: IncomingMessage, res: ServerResponse, route: string[], method: string) {
    let user: User; let device: Device | undefined;
    if (req.headers.authorization?.startsWith('Basic ')) {
      device = deviceAuth(req);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(device.user_id) as unknown as User;
      limit(`shares:${device.id}`, 120, res);
    } else {
      user = session(req).user;
      if (user.must_change_password) fail(403, 'Change initial password first');
    }
    if (route.length === 1 && method === 'GET') {
      const vault = device?.vault_id ?? new URL(req.url!, 'http://local').searchParams.get('vault');
      const rows = vault
        ? db.prepare('SELECT * FROM shares WHERE owner_id=? AND vault_id=? ORDER BY created_at DESC').all(user.id, vault)
        : db.prepare('SELECT * FROM shares WHERE owner_id=? ORDER BY created_at DESC').all(user.id);
      json(res, 200, { base: settings().url ?? '', maxBytes: settings().maxBytes, shares: (rows as unknown as Share[]).map(view) }); return;
    }
    if (route.length === 1 && method === 'POST') {
      const data = await body(req, 131_072);
      const vaultId = device?.vault_id ?? data.vaultId;
      if (typeof vaultId !== 'string' || !db.prepare('SELECT id FROM vaults WHERE id=? AND owner_id=?').get(vaultId, user.id)) fail(404, 'Vault not found');
      const mode = data.mode;
      if (typeof mode !== 'string' || !MODES.includes(mode)) fail(400, 'Invalid mode');
      const written = data.slug === undefined || data.slug === '' ? randomSlug() : data.slug;
      if (typeof written !== 'string' || !SLUG.test(written)) fail(400, 'Invalid address');
      const slug = (written as string).normalize('NFC');
      const taken = db.prepare('SELECT * FROM shares WHERE slug=?').get(slug) as unknown as Share | undefined;
      // An ended share's address stays its owner's: another account taking it over would show its content under an old link.
      if (taken && (state(taken) === 'active' || taken.owner_id !== user.id)) fail(409, 'Address already in use');
      const { password, hash } = await protection(mode as string, data);
      const share: Share = {
        id: randomUUID(), slug, owner_id: user.id, vault_id: vaultId as string, mode: mode as Share['mode'], sealed: sealed(data.sealed),
        expires_at: expiry(data.expiresAt ?? null), password, password_hash: hash, indexable: mode === 'public' && data.indexable === true ? 1 : 0,
        views: 0, size: 0, created_at: Date.now(), updated_at: null, revoked_at: null,
      };
      db.exec('BEGIN');
      // An address whose share ended can be taken again.
      if (taken) db.prepare('DELETE FROM shares WHERE id=?').run(taken.id);
      db.prepare(`INSERT INTO shares(id,slug,owner_id,vault_id,mode,sealed,expires_at,password,password_hash,indexable,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(share.id, share.slug, share.owner_id, share.vault_id, share.mode, share.sealed, share.expires_at,
        share.password, share.password_hash, share.indexable, share.created_at);
      audit(user.id, 'share.create', share.id);
      db.exec('COMMIT');
      json(res, 201, view(share)); return;
    }
    if (route.length < 2) fail(404, 'Route not found');
    const share = owned(route[1], user, device);
    if (route.length === 3 && route[2] === 'content' && method === 'PUT') {
      if (state(share) !== 'active') fail(410, 'Share is no longer available');
      const data = await raw(req, settings().maxBytes + 1_048_576);
      const files = readBundle(data);
      const size = [...files.values()].reduce((sum, file) => sum + file.length, 0);
      if (size > settings().maxBytes) fail(413, 'Share is too large');
      const now = Date.now();
      db.exec('BEGIN');
      db.prepare('DELETE FROM share_files WHERE share_id=?').run(share.id);
      const insert = db.prepare('INSERT INTO share_files(share_id,name,data) VALUES(?,?,?)');
      for (const [name, file] of files) insert.run(share.id, name, file);
      db.prepare('UPDATE shares SET size=?, updated_at=? WHERE id=?').run(size, now, share.id);
      db.exec('COMMIT');
      json(res, 200, view({ ...share, size, updated_at: now })); return;
    }
    if (route.length === 2 && method === 'PATCH') {
      if (state(share) === 'revoked') fail(410, 'Share is no longer available');
      const data = await body(req, 131_072);
      const next = { ...share };
      if (data.sealed !== undefined) next.sealed = sealed(data.sealed);
      if (data.expiresAt !== undefined) next.expires_at = expiry(data.expiresAt);
      if (data.password !== undefined) {
        const { password, hash } = await protection(share.mode, data);
        next.password = password; next.password_hash = hash;
      }
      if (data.indexable !== undefined) {
        if (typeof data.indexable !== 'boolean') fail(400, 'Invalid indexable');
        next.indexable = share.mode === 'public' && data.indexable ? 1 : 0;
      }
      db.prepare('UPDATE shares SET sealed=?, expires_at=?, password=?, password_hash=?, indexable=? WHERE id=?')
        .run(next.sealed, next.expires_at, next.password, next.password_hash, next.indexable, share.id);
      if (data.expiresAt !== undefined || data.password !== undefined) audit(user.id, 'share.update', share.id);
      json(res, 200, view(next)); return;
    }
    if (route.length === 2 && method === 'DELETE') {
      revoke(share.id);
      audit(user.id, 'share.revoke', share.id);
      json(res, 200, { ok: true }); return;
    }
    fail(404, 'Route not found');
  }
  function revoke(id: string) {
    db.exec('BEGIN');
    drop(id);
    db.prepare('UPDATE shares SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(), id);
    db.exec('COMMIT');
  }

  /** The share behind a public address, or the reason it cannot be opened. */
  function lookup(slug: string) {
    // A disabled account's shares are not served.
    const share = db.prepare('SELECT s.* FROM shares s JOIN users u ON u.id=s.owner_id WHERE s.slug=? AND u.disabled=0').get(slug.normalize('NFC')) as unknown as Share | undefined;
    if (!share) return fail(404, 'Share not found');
    const now = state(share);
    if (now !== 'active') {
      if (share.size) drop(share.id);
      fail(410, 'Share is no longer available');
    }
    return share;
  }
  /** Search engines are kept out unless the owner published a public page and allowed indexing. */
  const robots = (res: ServerResponse, share?: Share) => {
    if (share?.indexable) res.removeHeader('x-robots-tag'); else res.setHeader('x-robots-tag', 'noindex, nofollow');
  };
  /** Public routes under /api/v1/public/shares/<address>; no sign-in, limited per address of the visitor. */
  async function visitor(req: IncomingMessage, res: ServerResponse, route: string[], method: string) {
    // Per share as well as per address: behind a reverse proxy all visitors share one address.
    limit(`share-visit:${req.socket.remoteAddress}:${route[2] ?? ''}`, 1200, res);
    robots(res);
    if (method !== 'GET' || route.length < 3) fail(404, 'Route not found');
    const share = lookup(route[2]);
    robots(res, share);
    if (share.mode === 'public' && share.password) {
      if (route.length === 3) {
        const typed = req.headers['x-share-password'];
        if (typeof typed !== 'string') fail(401, 'Password required');
        let password = '';
        try { password = decodeURIComponent(typed as string); } catch { fail(400, 'Invalid password'); }
        limit(`share-password:${route[2]}`, 20, res);
        if (!await verifyPassword(password, share.password_hash!)) fail(403, 'Wrong password');
      } else if (!same(req.headers['x-share-access'], access(share))) fail(401, 'Password required');
    }
    if (route.length === 3) {
      db.prepare('UPDATE shares SET views=views+1 WHERE id=?').run(share.id);
      const files = db.prepare('SELECT name FROM share_files WHERE share_id=?').all(share.id).map(row => row.name as string);
      json(res, 200, { mode: share.mode, password: Boolean(share.password), updatedAt: share.updated_at, files,
        access: share.mode === 'public' && share.password ? access(share) : undefined });
      return;
    }
    if (route.length === 5 && route[3] === 'files') {
      const file = db.prepare('SELECT data FROM share_files WHERE share_id=? AND name=?').get(share.id, route[4]) as { data: Uint8Array } | undefined;
      if (!file) fail(404, 'File not found');
      // Served as opaque bytes: the viewer decodes them; opened directly they cannot render as a page.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'attachment' });
      res.end(file!.data);
      return;
    }
    fail(404, 'Route not found');
  }

  /**
   * The viewer page in its owner's colour theme, as their own pages show it: the theme on the page element, and a custom
   * theme's recipe as data the viewer applies (the page allows no inline styles).
   */
  function themed(page: Buffer, theme: string | null, recipe: string | null) {
    const shown = theme === 'custom' && !recipe ? 'sakura' : theme || 'sakura';
    const parsed = shown === 'custom' ? JSON.parse(recipe!) as { accent: string; tint: number; side: string } : undefined;
    const attributes = (shown === 'forest' ? '' : ` data-theme="${shown}"`)
      + (parsed ? ` data-recipe-accent="${parsed.accent}" data-recipe-tint="${parsed.tint}" data-side="${parsed.side}"` : '');
    return page.toString('utf8').replace('<html lang="en" data-theme="sakura">', `<html lang="en"${attributes}>`);
  }

  return {
    /** Handles a share route; returns false when the path is not one. */
    async handle(req: IncomingMessage, res: ServerResponse, path: string, route: string[], method: string) {
      if (path.startsWith('/s/') && ['GET', 'HEAD'].includes(method)) {
        // The viewer page: its own scripts only; the content is fetched and rendered by the script.
        let share: (Share & { theme: string | null; theme_recipe: string | null }) | undefined;
        try {
          share = db.prepare('SELECT s.*, u.theme, u.theme_recipe FROM shares s JOIN users u ON u.id=s.owner_id WHERE s.slug=?')
            .get(decodeURIComponent(path.slice(3)).normalize('NFC')) as unknown as typeof share;
        } catch { /* the page reports it */ }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          ...(share?.indexable && state(share) === 'active' ? {} : { 'x-robots-tag': 'noindex, nofollow' }),
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        });
        res.end(method === 'HEAD' ? undefined : themed(viewer, share?.theme ?? null, share?.theme_recipe ?? null));
        return true;
      }
      if (route[0] === 'shares' || (route[0] === 'public' && route[1] === 'shares')) {
        if (!settings().enabled) fail(403, 'Sharing is turned off');
        if (route[0] === 'shares') await owner(req, res, route, method);
        else await visitor(req, res, route, method);
        return true;
      }
      return false;
    },
    /** Administrator routes: every share's metadata (never its content) and revocation. */
    async admin(res: ServerResponse, user: User, route: string[], method: string) {
      if (route.length === 2 && method === 'GET') {
        const rows = db.prepare(`SELECT s.*, u.username AS owner, v.name AS vault FROM shares s JOIN users u ON u.id=s.owner_id
          JOIN vaults v ON v.id=s.vault_id ORDER BY s.created_at DESC`).all() as unknown as (Share & { owner: string; vault: string })[];
        json(res, 200, rows.map(row => {
          const { sealed: _sealed, ...rest } = view(row);
          return { ...rest, owner: row.owner, vault: row.vault };
        }));
        return;
      }
      if (route.length === 3 && method === 'DELETE') {
        if (!db.prepare('SELECT id FROM shares WHERE id=?').get(route[2])) fail(404, 'Share not found');
        revoke(route[2]);
        audit(user.id, 'share.revoke', route[2]);
        json(res, 200, { ok: true });
        return;
      }
      fail(404, 'Route not found');
    },
    /** Drops the files of shares whose time ran out. */
    prune() {
      for (const row of db.prepare('SELECT id FROM shares WHERE expires_at<=? AND size>0').all(Date.now())) drop(row.id as string);
    },
  };
}
