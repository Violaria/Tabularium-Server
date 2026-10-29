import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../dist/store.js';

const schema1 = `
  CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,must_change_password INTEGER NOT NULL DEFAULT 1) STRICT;
  CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL) STRICT;
  CREATE TABLE vaults(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,database_name TEXT NOT NULL UNIQUE,state TEXT NOT NULL) STRICT;
  CREATE TABLE devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),vault_id TEXT NOT NULL REFERENCES vaults(id),name TEXT NOT NULL,secret_hash TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL) STRICT;
  INSERT INTO users VALUES('u','legacy','salt:hash','user',0,0);
  INSERT INTO sessions VALUES('session-hash','u',9999999999999);
  INSERT INTO vaults VALUES('v','u','notes','tab_legacy','ready');
  INSERT INTO devices VALUES('d','u','v','desktop','secret-hash',0,9999999999999);
`;
const schema2 = `
  CREATE TABLE audit_events(id INTEGER PRIMARY KEY,occurred_at INTEGER NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL) STRICT;
  INSERT INTO audit_events(occurred_at,actor_id,action,target_id) VALUES(1,'u','device.issue','d');
`;
const queries = {
  users: 'SELECT id,username,password_hash,role,disabled,must_change_password FROM users', sessions: 'SELECT * FROM sessions', devices: 'SELECT * FROM devices',
  vaults: 'SELECT id,owner_id,name,database_name,state FROM vaults',
};

for (const version of [1, 2]) {
  test(`schema ${version} migrates to the current schema without changing existing records`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tabularium-upgrade-'));
    const path = join(dir, `schema${version}.sqlite`);
    const legacy = new DatabaseSync(path);
    legacy.exec(schema1 + (version === 2 ? schema2 : '') + `PRAGMA user_version=${version};`);
    const read = db => Object.fromEntries(Object.entries(queries).map(([table, sql]) => [table, db.prepare(sql).all()]));
    const before = read(legacy);
    const audit = version === 2 ? legacy.prepare('SELECT * FROM audit_events').all() : [];
    legacy.close();
    try {
      const upgraded = openStore(path);
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(upgraded.prepare('SELECT kindle_address FROM users').get().kindle_address, null);
      assert.equal(upgraded.prepare('SELECT count(*) AS n FROM kindle_deliveries').get().n, 0);
      assert.deepEqual(read(upgraded), before);
      assert.deepEqual(upgraded.prepare('SELECT * FROM audit_events').all(), audit);
      assert.deepEqual({ ...upgraded.prepare('SELECT rebuild_device,rebuild_until,rebuild_started FROM vaults').get() },
        { rebuild_device: null, rebuild_until: null, rebuild_started: null });
      assert.equal(upgraded.prepare('SELECT count(*) AS n FROM retired_databases').get().n, 0);
      upgraded.prepare('INSERT INTO audit_events(occurred_at,actor_id,action,target_id) VALUES(?,?,?,?)').run(Date.now(), 'u', 'device.revoke', 'd');
      upgraded.close();
      const reopened = openStore(path);
      assert.equal(reopened.prepare('SELECT action FROM audit_events ORDER BY id DESC').get().action, 'device.revoke');
      reopened.close();
    } finally { await rm(dir, { recursive: true }); }
  });
}
