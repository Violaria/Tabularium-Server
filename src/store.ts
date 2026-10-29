import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(await derive(password, salt, 64) as Buffer, Buffer.from(hash, 'hex'));
}
export interface User { id: string; username: string; password_hash: string; role: string; disabled: number; must_change_password: number; kindle_address: string | null }
export interface Vault {
  id: string; owner_id: string; name: string; database_name: string; state: string;
  rebuild_device: string | null; rebuild_until: number | null; rebuild_started: number | null;
}
export interface Device { id: string; user_id: string; vault_id: string; secret_hash: string; name: string; revoked: number; expires_at: number }

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  let version = db.prepare('PRAGMA user_version').get()!.user_version;
  if (version === 0) {
    db.exec(`
    BEGIN;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0,
      must_change_password INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      database_name TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('provisioning','ready','failed'))
    ) STRICT;
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL REFERENCES vaults(id),
      name TEXT NOT NULL, secret_hash TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE INDEX devices_vault ON devices(vault_id);
    PRAGMA user_version=1;
    COMMIT;
  `);
    version = 1;
  }
  if (version === 1) {
    db.exec(`
    BEGIN;
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY, occurred_at INTEGER NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, target_id TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version=2;
    COMMIT;
  `);
    version = 2;
  }
  if (version === 2) {
    db.exec(`
    BEGIN;
    ALTER TABLE vaults ADD COLUMN rebuild_device TEXT REFERENCES devices(id);
    ALTER TABLE vaults ADD COLUMN rebuild_until INTEGER;
    ALTER TABLE vaults ADD COLUMN rebuild_started INTEGER;
    CREATE TABLE retired_databases (
      database_name TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), retired_at INTEGER NOT NULL,
      partial INTEGER NOT NULL
    ) STRICT;
    PRAGMA user_version=3;
    COMMIT;
  `);
    version = 3;
  }
  if (version === 3) {
    db.exec(`
    BEGIN;
    ALTER TABLE users ADD COLUMN kindle_address TEXT;
    CREATE TABLE kindle_deliveries (
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), device_id TEXT,
      occurred_at INTEGER NOT NULL, file_name TEXT NOT NULL, size INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent','failed')), error TEXT
    ) STRICT;
    CREATE INDEX kindle_deliveries_user ON kindle_deliveries(user_id, occurred_at);
    PRAGMA user_version=4;
    COMMIT;
  `);
    version = 4;
  }
  if (version !== 4) throw new Error(`Unsupported database schema: ${version}`);
  return db;
}
