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
  if (version === 4) {
    // Tabularius: vaults with the AI curator enabled, their search index and conversations.
    db.exec(`
    BEGIN;
    CREATE TABLE tabularius_vaults (
      vault_id TEXT PRIMARY KEY REFERENCES vaults(id), device_id TEXT NOT NULL REFERENCES devices(id),
      device_secret BLOB NOT NULL, passphrase BLOB NOT NULL, tweaks TEXT NOT NULL, enabled_at INTEGER NOT NULL,
      excluded TEXT NOT NULL DEFAULT '', masks TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE tabularius_files (
      vault_id TEXT NOT NULL, path TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(vault_id, path)
    ) STRICT;
    CREATE TABLE tabularius_chunks (
      id INTEGER PRIMARY KEY, vault_id TEXT NOT NULL, path TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB
    ) STRICT;
    CREATE INDEX tabularius_chunks_path ON tabularius_chunks(vault_id, path);
    CREATE VIRTUAL TABLE tabularius_fts USING fts5(text, content='tabularius_chunks', content_rowid='id', tokenize='trigram');
    CREATE TRIGGER tabularius_chunks_ai AFTER INSERT ON tabularius_chunks BEGIN
      INSERT INTO tabularius_fts(rowid, text) VALUES (new.id, new.heading || char(10) || new.text);
    END;
    CREATE TRIGGER tabularius_chunks_ad AFTER DELETE ON tabularius_chunks BEGIN
      INSERT INTO tabularius_fts(tabularius_fts, rowid, text) VALUES ('delete', old.id, old.heading || char(10) || old.text);
    END;
    CREATE TABLE tabularius_conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL REFERENCES vaults(id),
      title TEXT NOT NULL, system TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX tabularius_conversations_user ON tabularius_conversations(user_id, vault_id, updated_at);
    CREATE TABLE tabularius_messages (
      id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES tabularius_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')), parts TEXT NOT NULL, native TEXT, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX tabularius_messages_conversation ON tabularius_messages(conversation_id, id);
    PRAGMA user_version=5;
    COMMIT;
  `);
    version = 5;
  }
  if (version === 5) {
    // Tabularius change proposals: one row per file, with the source's hash and text at proposal time.
    db.exec(`
    BEGIN;
    CREATE TABLE tabularius_proposals (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES tabularius_conversations(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL,
      vault_id TEXT NOT NULL REFERENCES vaults(id), user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','applied','discarded')), error TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
    ) STRICT;
    CREATE INDEX tabularius_proposals_user ON tabularius_proposals(user_id, vault_id, created_at);
    CREATE TABLE tabularius_changes (
      proposal_id TEXT NOT NULL REFERENCES tabularius_proposals(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
      op TEXT NOT NULL CHECK(op IN ('create','edit','move','delete')), path TEXT NOT NULL, to_path TEXT, hash TEXT, before TEXT, after TEXT,
      automatic INTEGER NOT NULL, PRIMARY KEY(proposal_id, seq)
    ) STRICT;
    PRAGMA user_version=6;
    COMMIT;
  `);
    version = 6;
  }
  if (version === 6) {
    // Tabularius: the administrator's knowledge base switch, and the embedding model the index was built with.
    db.exec(`
    BEGIN;
    ALTER TABLE tabularius_vaults ADD COLUMN knowledge INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tabularius_vaults ADD COLUMN embedding_model TEXT;
    PRAGMA user_version=7;
    COMMIT;
  `);
    version = 7;
  }
  if (version === 7) {
    // Tabularius: web access, the permission mode and model parameters, per vault.
    db.exec(`
    BEGIN;
    ALTER TABLE tabularius_vaults ADD COLUMN web INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tabularius_vaults ADD COLUMN mode TEXT NOT NULL DEFAULT 'read-only' CHECK(mode IN ('read-only','restricted','full'));
    ALTER TABLE tabularius_vaults ADD COLUMN params TEXT NOT NULL DEFAULT '';
    PRAGMA user_version=8;
    COMMIT;
  `);
    version = 8;
  }
  if (version !== 8) throw new Error(`Unsupported database schema: ${version}`);
  return db;
}
