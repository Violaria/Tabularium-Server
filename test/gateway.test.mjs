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
      config.sessionMs = 1;
      const expired = (await api('/sessions', 'POST', { username: 'bob', password: 'bob-updated-password' }, undefined, 201)).token;
      await sleep(5); await api('/me', 'GET', undefined, expired, 401); delete config.sessionMs;
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
      config.writeLimit = 64; await sync('/h:large', 'PUT', chunk('x'.repeat(100)), device, 413); delete config.writeLimit;
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
      config.streamMs = 350; const deadline = await stream(); await deadline.ended;
      await until(async () => (await metrics()).activeProxyConnections === 0); config.streamMs = 20_000;
      for (const feed of ['continuous', 'longpoll']) {
        const revoked = await enroll(vault); const connection = await stream(revoked, feed);
        await api(`/vaults/${vault.id}/devices/${revoked.id}`, 'DELETE', undefined, alice);
        await connection.ended; await sync('', 'GET', undefined, revoked, 401);
      }
      config.deviceMs = 5; const expired = await enroll(vault); await sleep(10);
      await sync('', 'GET', undefined, expired, 401); delete config.deviceMs;
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
      await gateway.close(); gateway = await createGateway(config); url = await gateway.listen();
      assert((await api('/admin/audit', 'GET', undefined, admin)).some(e => e.targetId === created.id));
      const ended = await fetch(url + '/api/v1/web-session', { method: 'DELETE', headers: { cookie, origin: url, 'x-csrf-token': web.csrf } });
      assert.equal(ended.status, 200); assert.match(ended.headers.get('set-cookie'), /Max-Age=0/); await ended.arrayBuffer();
      const denied = await fetch(url + '/api/v1/web-session', { headers: { cookie } }); assert.equal(denied.status, 401); await denied.arrayBuffer();
      config.publicUrl = 'https://notes.example.test';
      const secure = await fetch(url + '/api/v1/web-session', { method: 'POST', headers: { origin: config.publicUrl, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-updated-password' }) });
      assert.equal(secure.status, 201); assert.match(secure.headers.get('set-cookie'), /; Secure/); await secure.arrayBuffer(); delete config.publicUrl;
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
      config.rebuildMs = 1; await arm(r1.id); await sleep(5); await vs('/', 'DELETE', undefined, r1, 403); delete config.rebuildMs;

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
    await t.test('limits and account disable cancel active replication', async () => {
      const limited = await enroll(vault); config.syncLimit = 1; await sync('', 'GET', undefined, limited); await sync('', 'GET', undefined, limited, 429); config.syncLimit = 2400;
      const connection = await stream();
      await api(`/users/${userId}`, 'PATCH', { disabled: true }, admin);
      await connection.ended;
      await api('/me', 'GET', undefined, alice, 401); await sync('', 'GET', undefined, device, 401);
      config.loginLimit = 1;
      await api('/sessions', 'POST', { username: 'missing', password }, undefined, 429);
    });
  } finally {
    if (gateway) await gateway.close();
    await compose('down', '-v');
    await rm(directory, { recursive: true });
  }
});
