import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../dist/store.js';
import { createBackups } from '../dist/backup/index.js';
import { listPoints } from '../dist/backup/format.js';
import { nextRun, previousRun } from '../dist/backup/schedule.js';
import { chainOf, importCouch } from '../../../deploy/backup/scheduled.ts';
const exec = promisify(execFile);

test('backup schedule: weekdays, month ends and time zones', () => {
  const plan = { frequency: 'daily', weekday: 0, monthDay: 1, time: '03:30', timezone: 'Asia/Shanghai' };
  // 2026-10-31 20:00 UTC is 1 November 04:00 in Shanghai: the next run is 2 November 03:30 there, 1 November 19:30 UTC.
  assert.equal(new Date(nextRun(Date.UTC(2026, 9, 31, 20), plan)).toISOString(), '2026-11-01T19:30:00.000Z');
  assert.equal(new Date(previousRun(Date.UTC(2026, 9, 31, 20), plan)).toISOString(), '2026-10-31T19:30:00.000Z');
  // Weekly on Sunday (1 November 2026 is a Sunday).
  assert.equal(new Date(nextRun(Date.UTC(2026, 9, 28), { ...plan, frequency: 'weekly', weekday: 0, timezone: 'UTC' })).toISOString(), '2026-11-01T03:30:00.000Z');
  // Monthly on the 31st: February has 28 days in 2027.
  assert.equal(new Date(nextRun(Date.UTC(2027, 1, 1), { ...plan, frequency: 'monthly', monthDay: 31, timezone: 'UTC' })).toISOString(), '2027-02-28T03:30:00.000Z');
  // Daylight saving: 02:30 does not exist in Berlin on 29 March 2026; the run is at 03:30 local, 01:30 UTC.
  assert.equal(new Date(nextRun(Date.UTC(2026, 2, 28, 12), { ...plan, time: '02:30', timezone: 'Europe/Berlin' })).toISOString(), '2026-03-29T01:30:00.000Z');
  // After the change, 03:30 in Berlin is 01:30 UTC (summer time).
  assert.equal(new Date(nextRun(Date.UTC(2026, 3, 1), { ...plan, timezone: 'Europe/Berlin' })).toISOString(), '2026-04-01T01:30:00.000Z');
});

test('scheduled backups: full and incremental points, restore with deletions and conflicts, retention by chain', { timeout: 180_000 }, async t => {
  const runId = `backup-${Date.now()}`;
  const password = randomBytes(24).toString('hex');
  const compose = (...args) => exec('docker', ['compose', '-f', resolve('../../deploy/test/compose.yaml'), '-p', runId, ...args], {
    env: { ...process.env, BASELINE_PASSWORD: password }, timeout: 90_000,
  });
  const temp = await mkdtemp(join(tmpdir(), 'tabularium-backup-'));
  let backups;
  try {
    await compose('up', '-d', '--wait');
    const port = (await compose('port', 'couchdb', '5984')).stdout.trim();
    const config = { url: `http://${port}`, adminUser: 'baseline', adminPassword: password, syncUser: 'tabularium', syncPassword: 'x' };
    const authorization = `Basic ${Buffer.from(`baseline:${password}`).toString('base64')}`;
    const couch = async (path, method = 'GET', body) => {
      const response = await fetch(`${config.url}${path}`, { method, headers: { authorization, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
      return response.json();
    };
    const db = openStore(join(temp, 'app.sqlite'));
    // A plaintext search chunk, which must not reach the backup.
    db.prepare("INSERT INTO tabularius_chunks(vault_id, path, heading, text) VALUES('v', 'a.md', '', 'plain text of a note')").run();
    const directory = join(temp, 'backups');
    await (await import('node:fs/promises')).mkdir(directory);
    const failures = [];
    backups = createBackups({ db, couch: config, directory, version: 'test', onFailure: error => failures.push(error) });

    await couch('/tab_a', 'PUT');
    const a = await couch('/tab_a/a', 'PUT', { v: 1 });
    await couch('/tab_a/b', 'PUT', { v: 1 });
    await couch('/tab_a/_local/checkpoint', 'PUT', { seq: 1 });
    await couch('/tab_a/_security', 'PUT', { admins: { names: [], roles: [] }, members: { names: ['tabularium'], roles: [] } });
    backups.update({ enabled: false, frequency: 'daily', weekday: 1, monthDay: 1, time: '03:30', timezone: 'UTC', keep: 3, fullEvery: 3 });

    const first = await backups.run();
    assert.equal(first.ok, true, first.error ?? '');
    assert.equal(first.type, 'full');

    // An edit, a deletion, a conflicting branch and a new database.
    await couch('/tab_a/a', 'PUT', { _rev: a.rev, v: 2 });
    const b = await couch('/tab_a/b');
    await couch(`/tab_a/b?rev=${b._rev}`, 'DELETE');
    await couch('/tab_a/_bulk_docs', 'POST', { new_edits: false, docs: [{ _id: 'a', _rev: '2-ffffffffffffffffffffffffffffffff', v: 'branch', _revisions: { start: 2, ids: ['ffffffffffffffffffffffffffffffff', a.rev.split('-')[1]] } }] });
    await couch('/tab_b', 'PUT');
    await couch('/tab_b/c', 'PUT', { v: 1 });
    const second = await backups.run();
    assert.equal(second.ok, true, second.error ?? '');
    assert.equal(second.type, 'incremental');
    assert.equal(second.chain, first.chain);

    // The snapshot has no search index.
    const point = (await listPoints(directory)).at(-1);
    const snapshot = join(temp, 'snapshot.sqlite');
    await (await import('node:stream/promises')).pipeline(createReadStream(join(directory, point.id, 'app.sqlite.gz')), createGunzip(), (await import('node:fs')).createWriteStream(snapshot));
    const copy = new DatabaseSync(snapshot);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM tabularius_chunks').get().n, 0);
    copy.close();

    // Restoring the second point into fresh databases of another CouchDB name space gives the same documents.
    const chain = await chainOf(directory, point.id);
    assert.deepEqual(chain.map(p => p.type), ['full', 'incremental']);
    const renamed = chain.map(p => ({ ...p, databases: Object.fromEntries(Object.entries(p.databases)) }));
    await couch('/tab_a', 'DELETE'); await couch('/tab_b', 'DELETE');
    const restored = await importCouch((path, method, body) => couch(path, method, body), directory, renamed);
    assert.deepEqual(Object.keys(restored).sort(), ['tab_a', 'tab_b']);
    const docA = await couch('/tab_a/a?conflicts=true');
    assert.equal(docA._conflicts.length, 1);
    const other = await couch(`/tab_a/a?rev=${docA._conflicts[0]}`);
    assert.deepEqual([docA.v, other.v].sort(), [2, 'branch'].sort());
    await assert.rejects(couch('/tab_a/b'), /404/);
    assert.equal((await couch('/tab_a/b?rev=' + (await couch('/tab_a/_changes?style=all_docs')).results.find(r => r.id === 'b').changes[0].rev))._deleted, true);
    assert.equal((await couch('/tab_a/_local/checkpoint')).seq, 1);
    assert.deepEqual((await couch('/tab_a/_security')).members.names, ['tabularium']);
    assert.equal((await couch('/tab_b/c')).v, 1);

    // Retention: with keep 3 and a new chain every 3 points, the first chain goes only when none of its points is kept.
    await backups.run(); // third point, end of the first chain
    await backups.run(); // full, second chain
    assert.equal((await listPoints(directory)).length, 4);
    await backups.run();
    await backups.run(); // second chain complete: the first chain has no kept point now
    const left = await listPoints(directory);
    assert.deepEqual(left.map(p => p.type), ['full', 'incremental', 'incremental']);
    assert.equal(new Set(left.map(p => p.chain)).size, 1);
    assert.deepEqual(failures, []);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.partial')), false);
  } finally {
    await backups?.close();
    await compose('down', '-v').catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
});
