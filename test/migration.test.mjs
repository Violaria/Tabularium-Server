import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../dist/store.js';

test('schema 1 migrates without changing accounts, sessions, vaults or devices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabularium-upgrade-'));
  const path = join(dir, 'schema1.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,must_change_password INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL) STRICT;
    CREATE TABLE vaults(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,database_name TEXT NOT NULL UNIQUE,state TEXT NOT NULL) STRICT;
    CREATE TABLE devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),vault_id TEXT NOT NULL REFERENCES vaults(id),name TEXT NOT NULL,secret_hash TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL) STRICT;
    INSERT INTO users VALUES('u','legacy','salt:hash','user',0,0);
    INSERT INTO sessions VALUES('session-hash','u',9999999999999);
    INSERT INTO vaults VALUES('v','u','notes','tab_legacy','ready');
    INSERT INTO devices VALUES('d','u','v','desktop','secret-hash',0,9999999999999);
    PRAGMA user_version=1;
  `);
  const tables = ['users', 'sessions', 'vaults', 'devices'];
  const before = tables.map(table => legacy.prepare(`SELECT * FROM ${table}`).all()); legacy.close();
  try {
    const upgraded = openStore(path);
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual(tables.map(table => upgraded.prepare(`SELECT * FROM ${table}`).all()), before);
    upgraded.prepare('INSERT INTO audit_events(occurred_at,actor_id,action,target_id) VALUES(?,?,?,?)').run(Date.now(), 'u', 'device.revoke', 'd');
    upgraded.close();
    const reopened = openStore(path);
    assert.equal(reopened.prepare('SELECT action FROM audit_events').get().action, 'device.revoke');
    reopened.close();
  } finally { await rm(dir, { recursive: true }); }
});
