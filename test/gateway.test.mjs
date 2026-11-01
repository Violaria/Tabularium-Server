import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../dist/server.js';
import { startSmtpSink, parseMessage } from './smtp-sink.mjs';

const exec = promisify(execFile);
// Documents written through the gateway must have the encrypted LiveSync chunk shape.
const chunk = data => ({ type: 'leaf', e_: true, data: `%=${data}` });
const basic = d => `Basic ${Buffer.from(`${d.username}:${d.password}`).toString('base64')}`;
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(30); }
  assert.fail('Condition did not become true');
}
test('gateway with real CouchDB', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tabularium-server-'));
  const password = randomBytes(24).toString('hex');
  const runId = `tabularium-api-${Date.now()}`;
  const compose = (...args) => exec('docker', ['compose', '-f', resolve('../../deploy/test/compose.yaml'), '-p', runId, ...args], {
    env: { ...process.env, BASELINE_PASSWORD: password }, timeout: 90_000,
  });
  let gateway;
  try {
    await compose('up', '-d', '--wait');
    const port = (await compose('port', 'couchdb', '5984')).stdout.trim();
    const config = {
      database: join(directory, 'app.sqlite'), bootstrapUser: 'admin', bootstrapPassword: password,
      origins: ['app://obsidian.md'], loginLimit: 100, streamMs: 20_000,
      couch: { url: `http://${port}`, adminUser: 'baseline', adminPassword: password, syncUser: 'tabularium', syncPassword: randomBytes(24).toString('hex') },
    };
    gateway = await createGateway(config);
    let url = await gateway.listen();
    let admin, alice, bob, userId, vault, otherVault, device;
    const api = async (path, method = 'GET', data, session, expected = 200) => {
      const response = await fetch(url + '/api/v1' + path, { method, headers: {
        'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}),
      }, body: data === undefined ? undefined : JSON.stringify(data) });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result)); return result;
    };
    const sync = async (path, method = 'GET', data, credentials = device, expected = 200, extra = {}) => {
      const response = await fetch(url + '/sync/' + vault.id + path, { method, headers: {
        authorization: basic(credentials), 'content-type': 'application/json', ...extra,
      }, body: data === undefined ? undefined : JSON.stringify(data) });
      const text = await response.text(); assert.equal(response.status, expected, text); return text ? JSON.parse(text) : undefined;
    };
    // Running settings live in the application database (the settings page writes them there); a test changes them the
    // same way, below the page's minimums where it needs short times, and restarts the gateway on the same database.
    const configure = async change => {
      await gateway.close();
      const store = new DatabaseSync(config.database);
      const values = JSON.parse(store.prepare("SELECT value FROM server_settings WHERE key='values'").get().value);
      change(values);
      store.prepare("UPDATE server_settings SET value=? WHERE key='values'").run(JSON.stringify(values));
      store.close();
      gateway = await createGateway(config); url = await gateway.listen();
    };
    const enroll = (v, session = alice) => api(`/vaults/${v.id}/devices`, 'POST', { name: 'desktop' }, session, 201);
    const metrics = () => api('/metrics', 'GET', undefined, admin);
    await t.test('private accounts, first password change, sessions', async () => {
      admin = (await api('/sessions', 'POST', { username: 'admin', password }, undefined, 201)).token;
      await api('/vaults', 'POST', { name: 'blocked' }, admin, 403);
      await api('/me/password', 'PUT', { currentPassword: password, password: 'admin-updated-password' }, admin);
      userId = (await api('/users', 'POST', { username: 'alice', password: 'alice-initial-password' }, admin, 201)).id;
      await api('/users', 'POST', { username: 'bob', password: 'bob-initial-password' }, admin, 201);
      await api('/users', 'POST', { username: 'public', password }, undefined, 401);
      alice = (await api('/sessions', 'POST', { username: 'alice', password: 'alice-initial-password' }, undefined, 201)).token;
      await api('/me/password', 'PUT', { currentPassword: 'alice-initial-password', password: 'alice-updated-password' }, alice);
      bob = (await api('/sessions', 'POST', { username: 'bob', password: 'bob-initial-password' }, undefined, 201)).token;
      await api('/me/password', 'PUT', { currentPassword: 'bob-initial-password', password: 'bob-updated-password' }, bob);
      await api('/users', 'GET', undefined, alice, 403);
      const temporary = (await api('/sessions', 'POST', { username: 'alice', password: 'alice-updated-password' }, undefined, 201)).token;
      await api('/sessions/current', 'DELETE', undefined, temporary);
      await api('/me', 'GET', undefined, temporary, 401);
      await configure(v => { v.access.sessionHours = 1 / 3_600_000; });
      const expired = (await api('/sessions', 'POST', { username: 'bob', password: 'bob-updated-password' }, undefined, 201)).token;
      await sleep(5); await api('/me', 'GET', undefined, expired, 401);
      await configure(v => { v.access.sessionHours = 12; });
    });
    await t.test('vault ownership, provisioning retry, device secret storage', async () => {
      vault = await api('/vaults', 'POST', { name: 'notes' }, alice, 201);
      otherVault = await api('/vaults', 'POST', { name: 'other' }, bob, 201);
      await api('/vaults', 'PUT', {}, alice, 404); await api('/admin/vaults', 'PUT', {}, admin, 404);
      assert.equal(vault.state, 'ready');
      await api(`/vaults/${vault.id}`, 'GET', undefined, bob, 404);
      device = await enroll(vault);
      const response = await fetch(url + `/sync/${otherVault.id}`, { headers: { authorization: basic(device) } });
      assert.equal(response.status, 403); await response.arrayBuffer();
      const original = config.couch.url; config.couch.url = 'http://127.0.0.1:1';
      await api('/vaults', 'POST', { name: 'retry' }, alice, 502);
      const failed = (await api('/vaults', 'GET', undefined, alice)).find(v => v.name === 'retry');
      assert.equal(failed.state, 'failed'); config.couch.url = original;
      assert.equal((await api(`/vaults/${failed.id}/provision`, 'POST', {}, alice)).state, 'ready');
      const db = new DatabaseSync(config.database);
      assert.notEqual(db.prepare('SELECT secret_hash FROM devices WHERE id=?').get(device.id).secret_hash, device.password);
      assert(!JSON.stringify(db.prepare('SELECT * FROM sessions').all()).includes(alice));
      db.close();
    });
    await t.test('CouchDB revisions, partial failures, local docs, restricted service user', async () => {
      const doc = await sync('/h:document', 'PUT', chunk('one'), device, 201);
      const bulk = await sync('/_bulk_docs', 'POST', { docs: [{ _id: 'h:document', ...chunk('conflict') }, { _id: 'h:created', ...chunk('ok') }] }, device, 201);
      assert.equal(bulk[0].error, 'conflict'); assert.equal(bulk[1].ok, true);
      const revision = '2-01234567890123456789012345678901';
      await sync('/_bulk_docs', 'POST', { new_edits: false, docs: [{ _id: 'h:document', _rev: revision,
        _revisions: { start: 2, ids: [revision.slice(2), doc.rev.slice(2)] }, ...chunk('replicated') }] }, device, 201);
      assert.equal((await sync('/h:document?rev=' + revision)).data, '%=replicated');
      await sync('/_local/checkpoint', 'PUT', { sequence: 'opaque-sequence' }, device, 201);
      assert.equal((await sync('/_local/checkpoint')).sequence, 'opaque-sequence');
      const response = await fetch(config.couch.url + '/_users/_all_docs', { headers: {
        authorization: `Basic ${Buffer.from(`${config.couch.syncUser}:${config.couch.syncPassword}`).toString('base64')}`,
      } });
      assert.equal(response.status, 401); await response.arrayBuffer();
      const invalid = await sync('/_bulk_docs', 'POST', { docs: [{ _id: '_design/escape', views: {} }] }, device, 201);
      assert.equal(invalid[0].error, 'forbidden');
    });
    await t.test('encrypted document policy', async () => {
      const meta = { type: 'plain', path: '/\\:encrypted', mtime: 0, ctime: 0, size: 0, children: [], eden: {} };
      const write = (docs, extra = {}) => sync('/_bulk_docs', 'POST', { docs, ...extra }, device, 201);
      const accepted = await write([
        { _id: 'h:policy-chunk', ...chunk('x') },
        { _id: 'f:policy-meta', ...meta },
        { _id: 'f:policy-eden', ...meta, eden: { 'h:++encrypted-hkdf': { data: '%=eden', epoch: 999999 } } },
        { _id: 'f:policy-deleted', ...meta, deleted: true },
        { _id: 'obsydian_livesync_version', type: 'versioninfo', version: 12, used_features: [] },
      ]);
      assert.deepEqual(accepted.map(r => r.ok), [true, true, true, true, true]);
      const rejected = await write([
        { _id: 'h:plain', type: 'leaf', data: 'plain text' },
        { _id: 'h:mixed-ok-1', ...chunk('a') },
        { _id: 'h:unmarked', type: 'leaf', data: '%=x' },
        { _id: 'notes/明文.md', type: 'plain', path: 'notes/明文.md', mtime: 1, ctime: 1, size: 3, children: ['h:a'] },
        { _id: 'f:clear-path', ...meta, path: 'notes/明文.md' },
        { _id: 'f:times', ...meta, mtime: 1700000000000 },
        { _id: 'f:size', ...meta, size: 12 },
        { _id: 'f:children', ...meta, children: ['h:a'] },
        { _id: 'f:eden', ...meta, eden: { note: { data: 'plain' } } },
        { _id: 'i:f:hidden', ...meta },
        { _id: 'notes/秘密.md', _deleted: true },
        { _id: 'h:attached', ...chunk('a'), _attachments: { 'a.txt': { content_type: 'text/plain', data: 'cGxhaW4=' } } },
        { _id: 'h:mixed-ok-2', ...chunk('b') },
      ]);
      assert.deepEqual(rejected.map(r => r.error ?? r.id), ['forbidden', 'h:mixed-ok-1', ...Array(10).fill('forbidden'), 'h:mixed-ok-2']);
      assert.equal(rejected[3].id, 'notes/明文.md'); assert.match(rejected[3].reason, /only encrypted/);
      const replicated = await write([{ _id: 'h:replicated', _rev: '1-abc', ...chunk('r') }, { _id: 'h:replicated-plain', _rev: '1-abc', type: 'leaf', data: 'x' }], { new_edits: false });
      assert.deepEqual(replicated.map(r => `${r.id}:${r.error}`), ['h:replicated-plain:forbidden']);
      assert.deepEqual(await write([{ _id: 'h:only-plain', type: 'leaf', data: 'x' }]).then(r => r.map(e => e.error)), ['forbidden']);
      assert.equal((await sync('/h:put-plain', 'PUT', { type: 'leaf', data: 'x' }, device, 403)).error, 'forbidden');
      await sync('/h:put-ok', 'PUT', chunk('p'), device, 201);
      const removed = await sync('/h:policy-chunk', 'GET');
      await write([{ _id: 'h:policy-chunk', _rev: removed._rev, _deleted: true }]);
      await sync('/h:policy-chunk', 'GET', undefined, device, 404);
      const ids = (await sync('/_all_docs')).rows.map(row => row.id);
      assert.deepEqual(ids.filter(id => !/^(h:|f:|obsydian_livesync_version$)/.test(id) && !['created', 'document'].includes(id)), []);
      assert(!ids.some(id => ['h:plain', 'h:unmarked', 'h:replicated-plain', 'h:only-plain', 'h:put-plain', 'h:attached'].includes(id)));
      await configure(v => { v.access.writeMegabytes = 64 / 1024 / 1024; });
      await sync('/h:large', 'PUT', chunk('x'.repeat(100)), device, 413);
      await configure(v => { v.access.writeMegabytes = 64; });
    });
    await t.test('home overview: own vaults, last synchronisation, no note names without Tabularius, server summary', async () => {
      await sync('', 'GET');
      const home = await api('/home', 'GET', undefined, alice);
      const mine = home.vaults.find(v => v.id === vault.id);
      assert(mine); assert(!home.vaults.some(v => v.id === otherVault.id));
      assert.equal(mine.state, 'ready'); assert.equal(mine.locked, false); assert.equal(mine.tabularius, false);
      assert.deepEqual(mine.recent, []); assert.equal(typeof mine.notes, 'number'); assert(mine.size > 0);
      assert(mine.devices.find(d => d.name === 'desktop').lastSeenAt > Date.now() - 60_000);
      assert.equal(home.server, null);
      const listed = await api(`/vaults/${vault.id}/devices`, 'GET', undefined, alice);
      assert(listed.find(d => d.id === device.id).lastSeenAt > 0);
      const overview = await api('/home', 'GET', undefined, admin);
      assert.equal(overview.server.storage, true); assert.equal(typeof overview.server.uptimeSeconds, 'number');
      assert(!overview.vaults.some(v => v.id === vault.id));
    });
    await t.test('route boundary, raw encoded paths, CORS', async () => {
      for (const path of ['/_security', '/_users', '/_design/escape', '/_config', '/_local/a/b']) await sync(path, 'GET', undefined, device, 403);
      await sync('', 'PUT', {}, device, 403); await sync('', 'DELETE', undefined, device, 403);
      for (const path of ['/%2e%2e/_users', '/%252e%252e', '/%5c_users', '/%ZZ']) {
        const status = await new Promise((resolve, reject) => {
          const req = request(url, { path: `/sync/${vault.id}${path}`, headers: { authorization: basic(device) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
          req.on('error', reject); req.end();
        });
        assert.equal(status, 400);
      }
      let response = await fetch(url + `/sync/${vault.id}`, { method: 'OPTIONS', headers: { origin: 'app://obsidian.md', 'access-control-request-method': 'POST' } });
      assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), 'app://obsidian.md');
      await sync('', 'GET', undefined, device, 403, { origin: 'https://unknown.invalid' });
      response = await fetch(url + `/sync/${vault.id}`, { headers: { authorization: basic(device), origin: 'app://obsidian.md', cookie: 'AuthSession=fake' } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), 'app://obsidian.md'); assert.equal(response.headers.get('set-cookie'), null); await response.arrayBuffer();
    });
    await t.test('one application page for every module, its policy, caching and removed pages', async () => {
      const page = await (await fetch(url + '/app/app.html')).text();
      for (const path of ['/', '/home', '/notes/', '/notes/?vault=x&path=a.md', '/tabularius/', '/tabularius/vaults/x', '/admin/', '/admin/vaults/x', '/account/', '/account/kindle']) {
        const response = await fetch(url + path);
        assert.equal(response.status, 200, path);
        assert.equal(await response.text(), page, path);
        assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'.*worker-src 'self' blob:/, path);
        assert.equal(response.headers.get('cache-control'), 'no-store', path);
      }
      // The cached copy of the page used offline keeps the same policy.
      assert.match((await fetch(url + '/app/app.html')).headers.get('content-security-policy'), /worker-src 'self' blob:/);
      let response = await fetch(url + '/sw.js');
      assert.equal(response.headers.get('cache-control'), 'no-cache'); assert.doesNotMatch(response.headers.get('content-security-policy'), /wasm/); await response.arrayBuffer();
      const offline = await (await fetch(url + '/app/offline.json')).json();
      assert(offline.includes('/notes/assets/notes-module.js') && offline.includes('/notes/assets/notes-module.css'));
      response = await fetch(url + '/notes/assets/notes-module.js');
      assert.equal(response.headers.get('cache-control'), 'no-cache'); assert.match(response.headers.get('content-type'), /javascript/); await response.arrayBuffer();
      const hashed = offline.find(path => !path.includes('notes-module.'));
      assert.equal((await fetch(url + hashed)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
      for (const path of ['/index.html', '/home.html', '/tabularius.html', '/admin.css', '/notes/assets/missing.js']) {
        response = await fetch(url + path); await response.arrayBuffer();
        assert.equal(response.status, 404, path);
      }
      assert.equal((await fetch(url + '/', { method: 'POST' })).status, 404);
    });
    const stream = async (credentials = device, feed = 'continuous') => {
      const controller = new AbortController();
      const response = await fetch(url + `/sync/${vault.id}/_changes?feed=${feed}&since=now&heartbeat=100`, { headers: { authorization: basic(credentials) }, signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      const ended = (async () => { try { while (!(await reader.read()).done) { /* Drain heartbeats. */ } } catch { /* Socket cancellation is expected. */ } })();
      return { controller, ended };
    };
    await t.test('streaming, cancellation, deadline, device revoke and expiry', async () => {
      const first = await stream(); assert.equal((await metrics()).activeProxyConnections, 1);
      first.controller.abort(); await first.ended; await until(async () => (await metrics()).activeProxyConnections === 0);
      await configure(v => { v.access.streamMinutes = 350 / 60_000; });
      const deadline = await stream(); await deadline.ended;
      await until(async () => (await metrics()).activeProxyConnections === 0);
      await configure(v => { v.access.streamMinutes = 20_000 / 60_000; });
      for (const feed of ['continuous', 'longpoll']) {
        const revoked = await enroll(vault); const connection = await stream(revoked, feed);
        await api(`/vaults/${vault.id}/devices/${revoked.id}`, 'DELETE', undefined, alice);
        await connection.ended; await sync('', 'GET', undefined, revoked, 401);
      }
      await configure(v => { v.access.deviceDays = 5 / 86_400_000; });
      const expired = await enroll(vault); await sleep(10);
      await sync('', 'GET', undefined, expired, 401);
      // Renewal: the secret stays and the expiry restarts from now; revoked or expired devices cannot renew.
      const renew = credentials => fetch(url + '/api/v1/devices/current/renew', { method: 'POST', headers: { authorization: basic(credentials) } });
      assert.equal((await renew(expired)).status, 401);
      await configure(v => { v.access.deviceDays = 60_000 / 86_400_000; });
      const short = await enroll(vault);
      await configure(v => { v.access.deviceDays = 30; });
      const before = Date.now(); const renewed = await renew(short);
      assert.equal(renewed.status, 200);
      const { expiresAt } = await renewed.json();
      assert(expiresAt >= before + 2_592_000_000 && expiresAt <= Date.now() + 2_592_000_000);
      assert.equal((await api(`/vaults/${vault.id}/devices`, 'GET', undefined, alice)).find(d => d.id === short.id).expiresAt, expiresAt);
      await sync('', 'GET', undefined, short);
      await api(`/vaults/${vault.id}/devices/${short.id}`, 'DELETE', undefined, alice);
      assert.equal((await renew(short)).status, 401);
      assert((await api('/admin/audit', 'GET', undefined, admin)).some(e => e.action === 'device.renew' && e.targetId === short.id));
    });
    await t.test('persistent sessions and devices after restart; initial password not reset', async () => {
      await gateway.close(); gateway = await createGateway(config); url = await gateway.listen();
      await api('/me', 'GET', undefined, alice); await sync('');
      await api('/sessions', 'POST', { username: 'admin', password }, undefined, 401);
      assert.equal((await api(`/vaults/${vault.id}`, 'GET', undefined, alice)).state, 'ready');
    });
    await t.test('browser cookie sessions, CSRF, administrator routes and audit', async () => {
      const response = await fetch(url + '/api/v1/web-session', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-updated-password' }) });
      assert.equal(response.status, 201);
      const web = await response.json();
      assert.equal('token' in web, false);
      const setCookie = response.headers.get('set-cookie');
      assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Path=\/api\/v1/);
      const cookie = setCookie.split(';')[0];
      const current = await fetch(url + '/api/v1/web-session', { headers: { cookie } });
      assert.equal(current.status, 200); assert.equal((await current.json()).csrf, web.csrf);
      for (const headers of [{ origin: url }, { origin: 'https://unknown.invalid', 'x-csrf-token': web.csrf }]) {
        const denied = await fetch(url + '/api/v1/users', { method: 'POST', headers: { ...headers, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'forged', password }) });
        assert.equal(denied.status, 403); await denied.arrayBuffer();
      }
      await api('/admin/vaults', 'GET', undefined, alice, 403);
      await api('/admin/overview', 'GET', undefined, alice, 403);
      await api('/admin/audit', 'GET', undefined, alice, 403);
      const created = await api('/admin/vaults', 'POST', { ownerId: userId, name: 'managed' }, admin, 201);
      const owned = await api(`/vaults/${created.id}`, 'GET', undefined, alice);
      assert.equal(owned.name, 'managed');
      await api(`/admin/vaults/${created.id}/devices`, 'POST', { name: 'not-owner' }, admin, 404);
      const usage = await api(`/admin/vaults/${created.id}/usage`, 'GET', undefined, admin);
      assert.equal(typeof usage.diskBytes, 'number');
      const overview = await api('/admin/overview', 'GET', undefined, admin);
      assert.equal(overview.users, 3); assert(overview.vaults >= 4);
      const revoked = await enroll(vault); const connection = await stream(revoked);
      await api(`/admin/vaults/${vault.id}/devices/${revoked.id}`, 'DELETE', undefined, admin);
      await connection.ended; await sync('', 'GET', undefined, revoked, 401);
      const events = await api('/admin/audit', 'GET', undefined, admin);
      assert(events.some(e => e.action === 'device.revoke' && e.targetId === revoked.id));
      assert(events.some(e => e.action === 'vault.create' && e.targetId === created.id));
      for (const secret of [password, revoked.password, admin, web.csrf]) assert(!JSON.stringify(events).includes(secret));
      // Records older than the retention period are removed when the gateway starts and on each cleanup run.
      const store = new DatabaseSync(config.database);
      store.prepare('INSERT INTO audit_events(occurred_at,actor_id,action,target_id) VALUES(?,?,?,?)').run(Date.now() - 400 * 86_400_000, 'old', 'user.create', 'expired-record');
      store.close();
      await gateway.close(); gateway = await createGateway(config); url = await gateway.listen();
      const retained = await api('/admin/audit', 'GET', undefined, admin);
      assert(retained.some(e => e.targetId === created.id)); assert(!retained.some(e => e.targetId === 'expired-record'));
      const ended = await fetch(url + '/api/v1/web-session', { method: 'DELETE', headers: { cookie, origin: url, 'x-csrf-token': web.csrf } });
      assert.equal(ended.status, 200); assert.match(ended.headers.get('set-cookie'), /Max-Age=0/); await ended.arrayBuffer();
      const denied = await fetch(url + '/api/v1/web-session', { headers: { cookie } }); assert.equal(denied.status, 401); await denied.arrayBuffer();
      config.publicUrl = 'https://notes.example.test';
      const secure = await fetch(url + '/api/v1/web-session', { method: 'POST', headers: { origin: config.publicUrl, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-updated-password' }) });
      assert.equal(secure.status, 201); assert.match(secure.headers.get('set-cookie'), /; Secure/); await secure.arrayBuffer();
      // Several entrances: each one can log in and write with its CSRF token, an unlisted one cannot.
      config.publicUrl = 'https://notes.example.test, https://notes.example.test:10000,https://notes.public.test';
      for (const origin of ['https://notes.example.test:10000', 'https://notes.public.test']) {
        const login = await fetch(url + '/api/v1/web-session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-updated-password' }) });
        assert.equal(login.status, 201); assert.match(login.headers.get('set-cookie'), /; Secure/);
        const { csrf } = await login.json(); const cookie = login.headers.get('set-cookie').split(';')[0];
        const created = await fetch(url + '/api/v1/vaults', { method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: `entrance-${new URL(origin).host}` }) });
        assert.equal(created.status, 201); await created.arrayBuffer();
      }
      const unlisted = await fetch(url + '/api/v1/web-session', { method: 'POST', headers: { origin: 'https://other.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-updated-password' }) });
      assert.equal(unlisted.status, 403); await unlisted.arrayBuffer();
      config.publicUrl = 'https://notes.example.test,http://plain.example.test';
      const mixed = await fetch(url + '/api/v1/web-session', { method: 'POST', headers: { origin: 'http://plain.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-updated-password' }) });
      assert.equal(mixed.status, 201); assert.doesNotMatch(mixed.headers.get('set-cookie'), /; Secure/); await mixed.arrayBuffer();
      delete config.publicUrl;
    });
    await t.test('vault rebuild window, database switch, isolation, revert and retired databases', async () => {
      const rv = await api('/vaults', 'POST', { name: 'rebuild-me' }, alice, 201);
      const r1 = await enroll(rv), r2 = await enroll(rv);
      const vs = async (path, method = 'GET', data, credentials = r1, expected = 200) => {
        const response = await fetch(`${url}/sync/${rv.id}${path}`, { method, headers: { authorization: basic(credentials), 'content-type': 'application/json' },
          body: data === undefined ? undefined : JSON.stringify(data) });
        const text = await response.text(); assert.equal(response.status, expected, `${method} ${path}: ${text}`); return text ? JSON.parse(text) : undefined;
      };
      const couchAdmin = path => fetch(config.couch.url + path, { headers: { authorization: `Basic ${Buffer.from(`baseline:${password}`).toString('base64')}` } });
      const arm = (deviceId, confirm = 'rebuild-me', session = alice, expected = 200) => api(`/vaults/${rv.id}/rebuild`, 'POST', { deviceId, confirm }, session, expected);
      const original = `tab_${rv.id.replaceAll('-', '')}`;
      const milestone = '/_local/obsydian_livesync_milestone';
      await vs('/h:doc', 'PUT', chunk('1'), r1, 201);

      await vs('/', 'DELETE', undefined, r1, 403); await vs('/', 'PUT', undefined, r1, 403);
      await arm(r1.id, 'wrong', alice, 400);
      await arm(r1.id, 'rebuild-me', bob, 404);
      await arm(device.id, 'rebuild-me', alice, 404);
      await configure(v => { v.access.rebuildMinutes = 1 / 60_000; });
      await arm(r1.id); await sleep(5); await vs('/', 'DELETE', undefined, r1, 403);
      await configure(v => { v.access.rebuildMinutes = 15; });

      const armed = await arm(r1.id);
      assert.equal(armed.rebuild.deviceId, r1.id); assert.equal(armed.rebuild.started, null); assert(armed.rebuild.until > Date.now());
      await vs('/', 'DELETE', undefined, r2, 403);
      // The upstream rebuild sequence: lock the old milestone, delete, recreate, write new parameters and milestone.
      await vs(milestone, 'PUT', { locked: true, accepted_nodes: ['r1'] }, r1, 201);
      const controller = new AbortController();
      const live = await fetch(`${url}/sync/${rv.id}/_changes?feed=continuous&since=now&heartbeat=100`, { headers: { authorization: basic(r2) }, signal: controller.signal });
      const reader = live.body.getReader(); await reader.read();
      const ended = (async () => { try { while (!(await reader.read()).done) { /* Drain heartbeats. */ } } catch { /* Cancelled by the switch. */ } })();
      await vs('/', 'DELETE', undefined, r1, 200);
      await ended;
      assert((await api(`/vaults/${rv.id}`, 'GET', undefined, alice)).rebuild.started > 0);
      await api(`/vaults/${rv.id}/rebuild/lock`, 'DELETE', undefined, alice, 409);
      await vs('/', 'PUT', undefined, r1, 412);
      await vs('/h:doc', 'GET', undefined, r2, 409);
      await vs('/h:doc', 'GET', undefined, r1, 404);
      await vs('/_local/obsidian_livesync_sync_parameters', 'PUT', { salt: 'first-attempt' }, r1, 201);
      await vs('/', 'DELETE', undefined, r1, 200);
      await vs('/_local/obsidian_livesync_sync_parameters', 'PUT', { salt: 'new' }, r1, 201);
      await vs(milestone, 'PUT', { locked: true, accepted_nodes: ['r1'] }, r1, 201);
      assert.equal((await api(`/vaults/${rv.id}`, 'GET', undefined, alice)).rebuild, null);
      await vs('/h:doc2', 'PUT', chunk('2'), r1, 201);
      assert.equal((await vs(milestone, 'GET', undefined, r2)).locked, true);
      await vs('/h:doc2', 'GET', undefined, r2);
      // The owner lifts the rebuild lock from the console once the other devices have fetched.
      assert.equal((await api(`/vaults/${rv.id}/rebuild/lock`, 'GET', undefined, alice)).locked, true);
      await api(`/vaults/${rv.id}/rebuild/lock`, 'GET', undefined, bob, 404);
      await api(`/vaults/${rv.id}/rebuild/lock`, 'DELETE', undefined, alice);
      assert.equal((await vs(milestone, 'GET', undefined, r2)).locked, false);
      assert.equal((await api(`/vaults/${rv.id}/rebuild/lock`, 'GET', undefined, alice)).locked, false);

      let retired = await api(`/vaults/${rv.id}/databases`, 'GET', undefined, alice);
      assert.equal(retired.length, 2); assert.equal(retired[1].name, original); assert.deepEqual(retired.map(r => r.partial), [true, false]);
      assert.equal(typeof retired[0].diskBytes, 'number');
      assert.equal((await (await couchAdmin(`/${original}/h:doc`)).json()).data, '%=1');
      await api(`/vaults/${rv.id}/databases`, 'GET', undefined, bob, 404);

      await api(`/vaults/${rv.id}/rebuild/revert`, 'POST', { confirm: 'wrong' }, alice, 400);
      await api(`/vaults/${rv.id}/rebuild/revert`, 'POST', { confirm: 'rebuild-me' }, alice);
      assert.equal((await vs('/h:doc', 'GET', undefined, r2)).data, '%=1');
      assert.equal((await vs(milestone, 'GET', undefined, r2)).locked, false);
      retired = await api(`/vaults/${rv.id}/databases`, 'GET', undefined, alice);
      assert.equal(retired.length, 2); assert(!retired.some(r => r.name === original));
      await api(`/vaults/${rv.id}/databases/${original}`, 'DELETE', undefined, alice, 404);
      for (const { name } of retired) {
        await api(`/vaults/${rv.id}/databases/${name}`, 'DELETE', undefined, alice);
        assert.equal((await couchAdmin(`/${name}`)).status, 404);
      }
      assert.deepEqual(await api(`/vaults/${rv.id}/databases`, 'GET', undefined, alice), []);
      await api(`/vaults/${rv.id}/rebuild/revert`, 'POST', { confirm: 'rebuild-me' }, alice, 409);

      await arm(r1.id);
      assert.equal((await api(`/vaults/${rv.id}/rebuild`, 'DELETE', undefined, alice)).rebuild, null);
      await vs('/', 'DELETE', undefined, r1, 403);
      await api(`/vaults/${rv.id}/devices/${r2.id}`, 'DELETE', undefined, alice);
      await arm(r2.id, 'rebuild-me', alice, 404);
      const actions = (await api('/admin/audit', 'GET', undefined, admin)).filter(e => e.targetId === rv.id).map(e => e.action);
      for (const action of ['vault.rebuild-arm', 'vault.rebuild-switch', 'vault.rebuild-complete', 'vault.rebuild-revert', 'vault.database-delete', 'vault.rebuild-end']) assert(actions.includes(action), action);
    });
    await t.test('send to Kindle through SMTP', async () => {
      // A minimal EPUB prefix: an uncompressed `mimetype` entry first, as OCF requires.
      const epub = (tail = 64) => {
        const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(10, 4);
        header.writeUInt32LE(20, 18); header.writeUInt32LE(20, 22); header.writeUInt16LE(8, 26);
        return Buffer.concat([header, Buffer.from('mimetypeapplication/epub+zip'), randomBytes(tail)]);
      };
      const send = (data, name = encodeURIComponent('读书笔记.epub'), credentials = device) => fetch(url + '/api/v1/kindle/send', { method: 'POST',
        headers: { authorization: basic(credentials), 'content-type': 'application/epub+zip', 'x-tabularium-filename': name }, body: data });
      const status = async () => (await fetch(url + '/api/v1/kindle/status', { headers: { authorization: basic(device) } })).json();
      assert.equal((await status()).configured, false);
      assert.equal((await send(epub())).status, 503);

      const sink = await startSmtpSink();
      try {
        // Without a secret key the password comes from the startup configuration; the rest from the stored settings.
        config.smtp = { host: '127.0.0.1', port: sink.port, security: 'none', user: sink.user, password: sink.password, from: 'tabularium@example.test' };
        await configure(v => { v.mail = { host: '127.0.0.1', port: sink.port, security: 'none', user: sink.user, from: 'tabularium@example.test', password: null, hint: '' }; });
        assert.equal((await send(epub())).status, 409);
        await api('/me/kindle', 'PUT', { address: 'someone@gmail.com' }, alice, 400);
        assert.equal((await api('/me/kindle', 'PUT', { address: ' Alice@Kindle.com ' }, alice)).address, 'alice@kindle.com');
        const settings = await api('/me/kindle', 'GET', undefined, alice);
        assert.deepEqual([settings.configured, settings.from, settings.domains, settings.sentToday], [true, 'tabularium@example.test', ['kindle.com', 'free.kindle.com'], 0]);

        let response = await send(Buffer.from('plain text, not an EPUB'));
        assert.equal(response.status, 400); await response.arrayBuffer();
        const book = epub(4096);
        response = await send(book);
        assert.equal(response.status, 200, await response.text());
        const mail = parseMessage(sink.messages.at(-1).raw);
        assert.deepEqual([sink.messages.at(-1).to, mail.to, mail.from, mail.subject, mail.fileName, mail.type],
          ['alice@kindle.com', 'alice@kindle.com', 'tabularium@example.test', '读书笔记', '读书笔记.epub', 'application/epub+zip']);
        assert(mail.data.equals(book));

        await api('/me/kindle/test', 'POST', {}, alice);
        const test = parseMessage(sink.messages.at(-1).raw);
        assert.equal(test.fileName, 'Tabularium test.txt'); assert.match(test.data.toString(), /Tabularium/);

        await configure(v => { v.kindle.maxMegabytes = 2048 / 1024 / 1024; });
        response = await send(epub(4096)); assert.equal(response.status, 413); await response.arrayBuffer();
        await configure(v => { v.kindle.maxMegabytes = 50; v.kindle.daily = 2; });
        response = await send(epub()); assert.equal(response.status, 429); await response.arrayBuffer();
        await configure(v => { v.kindle.daily = 30; });

        sink.rejectRecipients = true;
        response = await send(epub());
        assert.equal(response.status, 502); assert.match((await response.json()).error, /550/);
        sink.rejectRecipients = false;
        await configure(v => { v.mail.port = 1; });
        response = await send(epub()); assert.equal(response.status, 502); await response.arrayBuffer();

        const deliveries = await api('/me/kindle/deliveries', 'GET', undefined, alice);
        assert.deepEqual(deliveries.map(d => d.status), ['failed', 'failed', 'sent', 'sent']);
        assert.deepEqual([deliveries[3].fileName, deliveries[3].size], ['读书笔记.epub', book.length]);
        assert(!JSON.stringify(deliveries).includes(book.subarray(60, 80).toString('base64')));
        assert.deepEqual(await status(), { configured: true, address: 'alice@kindle.com', dailyLimit: 30, remaining: 28 });
        await api('/me/kindle', 'PUT', { address: '' }, alice);
        assert.equal((await status()).address, null);
      } finally {
        delete config.smtp;
        await configure(v => { v.mail = null; });
        await sink.close();
      }
    });
    await t.test('shares: owner and device routes, public access, password, expiry, revoke, administrator, switch', async () => {
      // The upload format: name length, name, data length, data for each file.
      const bundle = files => Buffer.concat(Object.entries(files).flatMap(([name, data]) => {
        const head = Buffer.alloc(2); head.writeUInt16BE(name.length);
        const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
        return [head, Buffer.from(name, 'latin1'), size, Buffer.from(data)];
      }));
      const put = (share, files, credentials = device) => fetch(`${url}/api/v1/shares/${share.id}/content`, { method: 'PUT',
        headers: { authorization: basic(credentials), 'content-type': 'application/octet-stream' }, body: bundle(files) });
      const visit = (path, extra = {}) => fetch(`${url}/api/v1/public/shares/${path}`, { headers: extra });
      const encrypted = await api('/shares', 'POST', { vaultId: vault.id, slug: 'alice-note', mode: 'encrypted', sealed: 'sealed-by-client', expiresAt: null }, alice, 201);
      assert.equal(encrypted.state, 'active'); assert.equal(encrypted.size, 0);
      await api('/shares', 'POST', { vaultId: vault.id, slug: 'ALICE-NOTE', mode: 'encrypted', sealed: 'x' }, alice, 409);
      await api('/shares', 'POST', { vaultId: vault.id, slug: 'a/b', mode: 'encrypted', sealed: 'x' }, alice, 400);
      await api('/shares', 'POST', { vaultId: vault.id, mode: 'plain', sealed: 'x' }, alice, 400);
      await api('/shares', 'POST', { vaultId: otherVault.id, mode: 'encrypted', sealed: 'x' }, alice, 404);
      const random = await api('/shares', 'POST', { vaultId: vault.id, mode: 'encrypted', sealed: 'x' }, alice, 201);
      assert.match(random.slug, /^[A-Za-z0-9]{10}$/);
      // The device of the vault replaces the content and lists the vault's shares.
      let response = await put(encrypted, { manifest: 'cipher-manifest', n1: 'cipher-note' });
      assert.equal(response.status, 200); assert.equal((await response.json()).size, 'cipher-manifest'.length + 'cipher-note'.length);
      response = await put(encrypted, { n1: 'no manifest' }); assert.equal(response.status, 400); await response.arrayBuffer();
      const listed = await (await fetch(`${url}/api/v1/shares`, { headers: { authorization: basic(device) } })).json();
      assert.deepEqual(listed.shares.map(share => share.slug).sort(), ['alice-note', random.slug].sort());
      assert.equal(listed.maxBytes, 52_428_800);
      // Another account sees nothing of it.
      await api(`/shares/${encrypted.id}`, 'PATCH', { expiresAt: null }, bob, 404);
      await api(`/shares/${encrypted.id}`, 'DELETE', undefined, bob, 404);
      assert.deepEqual((await api('/shares', 'GET', undefined, bob)).shares, []);
      const bobDevice = await enroll(otherVault, bob);
      response = await put(encrypted, { manifest: 'x' }, bobDevice); assert.equal(response.status, 404); await response.arrayBuffer();
      // Anyone with the address reads the ciphertext; the page and the API ask search engines not to index it.
      response = await visit('alice-note');
      assert.equal(response.status, 200); assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      const meta = await response.json();
      assert.deepEqual({ ...meta, files: meta.files.sort() }, { mode: 'encrypted', password: false, updatedAt: meta.updatedAt, files: ['manifest', 'n1'] });
      response = await visit('alice-note/files/n1');
      assert.equal(await response.text(), 'cipher-note'); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.match(response.headers.get('content-security-policy'), /sandbox/);
      response = await visit('missing'); assert.equal(response.status, 404); await response.arrayBuffer();
      response = await fetch(`${url}/s/alice-note`);
      assert.match(await response.text(), /share-viewer\.js/);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.match(response.headers.get('content-security-policy'), /script-src 'self';.*form-action 'none'/);
      // Scripts are the page's own only; styles may be inline, for the diagrams Mermaid draws.
      assert.doesNotMatch(response.headers.get('content-security-policy').replace("style-src 'self' 'unsafe-inline'", ''), /unsafe|wasm/);
      assert.equal((await api('/shares', 'GET', undefined, alice)).shares.find(share => share.id === encrypted.id).views, 1);
      // Size limit.
      await configure(v => { v.shares.maxMegabytes = 10 / 1024 / 1024; });
      response = await put(encrypted, { manifest: 'more than ten bytes' }); assert.equal(response.status, 413); await response.arrayBuffer();
      await configure(v => { v.shares.maxMegabytes = 50; });
      // A public page with a password: the server checks it and hands out an access token for the files.
      const page = await api('/shares', 'POST', { vaultId: vault.id, slug: '公开页', mode: 'public', sealed: 'x', password: 'open sesame', indexable: true }, alice, 201);
      assert.equal(page.password, true);
      assert.equal((await put(page, { manifest: '{"title":"plain"}' })).status, 200);
      response = await visit(encodeURIComponent('公开页')); assert.equal(response.status, 401); await response.arrayBuffer();
      response = await visit(encodeURIComponent('公开页'), { 'x-share-password': encodeURIComponent('wrong') }); assert.equal(response.status, 403); await response.arrayBuffer();
      response = await visit(encodeURIComponent('公开页'), { 'x-share-password': encodeURIComponent('open sesame') });
      assert.equal(response.status, 200); assert.equal(response.headers.get('x-robots-tag'), null);
      const { access } = await response.json();
      response = await visit(`${encodeURIComponent('公开页')}/files/manifest`); assert.equal(response.status, 401); await response.arrayBuffer();
      response = await visit(`${encodeURIComponent('公开页')}/files/manifest`, { 'x-share-access': access });
      assert.equal(await response.text(), '{"title":"plain"}');
      assert.equal((await fetch(`${url}/s/${encodeURIComponent('公开页')}`)).headers.get('x-robots-tag'), null);
      const database = new DatabaseSync(config.database);
      assert.notEqual(database.prepare('SELECT password_hash FROM shares WHERE id=?').get(page.id).password_hash, 'open sesame');
      // Expiry: the link answers 410 and the files are gone.
      await api('/shares', 'POST', { vaultId: vault.id, mode: 'encrypted', sealed: 'x', expiresAt: Date.now() - 1 }, alice, 400);
      const brief = await api('/shares', 'POST', { vaultId: vault.id, slug: 'brief', mode: 'encrypted', sealed: 'x', expiresAt: Date.now() + 1500 }, alice, 201);
      assert.equal((await put(brief, { manifest: 'm' })).status, 200);
      await sleep(1600);
      response = await visit('brief'); assert.equal(response.status, 410); await response.arrayBuffer();
      assert.equal(database.prepare('SELECT count(*) AS n FROM share_files WHERE share_id=?').get(brief.id).n, 0);
      response = await put(brief, { manifest: 'm' }); assert.equal(response.status, 410); await response.arrayBuffer();
      // Revocation by the owner; the address can then be taken again.
      await api(`/shares/${encrypted.id}`, 'PATCH', { expiresAt: Date.now() + 86_400_000, sealed: 'resealed' }, alice);
      await api(`/shares/${encrypted.id}`, 'DELETE', undefined, alice);
      response = await visit('alice-note'); assert.equal(response.status, 410); await response.arrayBuffer();
      assert.equal(database.prepare('SELECT count(*) AS n FROM share_files WHERE share_id=?').get(encrypted.id).n, 0);
      const again = await api('/shares', 'POST', { vaultId: vault.id, slug: 'alice-note', mode: 'encrypted', sealed: 'x' }, alice, 201);
      // The administrator lists metadata only and can revoke.
      const all = await api('/admin/shares', 'GET', undefined, admin);
      const row = all.find(share => share.id === again.id);
      assert.equal(row.owner, 'alice'); assert.equal(row.vault, 'notes'); assert.equal(row.sealed, undefined);
      await api('/admin/shares', 'GET', undefined, alice, 403);
      await api(`/admin/shares/${again.id}`, 'DELETE', undefined, admin);
      assert.equal((await api('/shares', 'GET', undefined, alice)).shares.find(share => share.id === again.id).state, 'revoked');
      assert(database.prepare("SELECT count(*) AS n FROM audit_events WHERE action='share.revoke'").get().n >= 2);
      database.close();
      // Sharing turned off by the administrator's configuration.
      await configure(v => { v.shares.enabled = false; });
      await api('/shares', 'GET', undefined, alice, 403);
      response = await visit(random.slug); assert.equal(response.status, 403); await response.arrayBuffer();
      await configure(v => { v.shares.enabled = true; });
    });
    await t.test('colour themes: built-in, custom recipe kept on the account', async () => {
      await api('/me/theme', 'PUT', { theme: 'custom' }, alice, 400);
      await api('/me/theme', 'PUT', { theme: 'custom', recipe: { accent: 'red', tint: 10, side: 'light' } }, alice, 400);
      await api('/me/theme', 'PUT', { theme: 'custom', recipe: { accent: '#3366CC', tint: 50, side: 'light' } }, alice, 400);
      await api('/me/theme', 'PUT', { theme: 'custom', recipe: { accent: '#3366CC', tint: 18, side: 'dark' } }, alice);
      assert.deepEqual(await api('/me', 'GET', undefined, alice).then(me => [me.theme, me.recipe]), ['custom', { accent: '#3366cc', tint: 18, side: 'dark' }]);
      await api('/me/theme', 'PUT', { theme: 'lavender' }, alice);
      assert.deepEqual(await api('/me', 'GET', undefined, alice).then(me => [me.theme, me.recipe.accent]), ['lavender', '#3366cc']);
      await api('/me/theme', 'PUT', { theme: 'neon' }, alice, 400);
    });
    await t.test('limits and account disable cancel active replication', async () => {
      const limited = await enroll(vault);
      await configure(v => { v.access.syncPerMinute = 1; });
      await sync('', 'GET', undefined, limited); await sync('', 'GET', undefined, limited, 429);
      await configure(v => { v.access.syncPerMinute = 2400; });
      const connection = await stream();
      await api(`/users/${userId}`, 'PATCH', { disabled: true }, admin);
      await connection.ended;
      await api('/me', 'GET', undefined, alice, 401); await sync('', 'GET', undefined, device, 401);
      // Logins are limited per account, and ten times looser per address.
      await configure(v => { v.access.loginPerMinute = 1; });
      await api('/sessions', 'POST', { username: 'missing', password }, undefined, 401);
      await api('/sessions', 'POST', { username: 'missing', password }, undefined, 429);
      for (let i = 0; i < 8; i++) await api('/sessions', 'POST', { username: `missing-${i}`, password }, undefined, 401);
      await api('/sessions', 'POST', { username: 'another', password }, undefined, 429);
    });
  } finally {
    if (gateway) await gateway.close();
    await compose('down', '-v');
    await rm(directory, { recursive: true });
  }
});
