import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fail, field } from './http.js';

interface Deps {
  db: DatabaseSync;
  audit(actorId: string, action: string, targetId: string): void;
  disconnect(deviceId: string): void;
}
/** What a client reports about itself: its stable ID and which of its installations this credential belongs to. */
export interface ClientReport { id: string; installation: string; name: string }

export function clientReport(data: Record<string, unknown>, name: string): ClientReport | undefined {
  if (data.machine === undefined || data.machine === null) return undefined;
  return { id: field(data.machine as Record<string, unknown>, 'id'), installation: field(data, 'installation'), name };
}

/**
 * A client is one Obsidian or one browser profile of an account; its credentials stay per vault. Its ID only groups
 * the account's own devices and gives no access, so it is taken as the client reports it.
 */
export function createMachines({ db, audit, disconnect }: Deps) {
  function machineFor(userId: string, report: ClientReport) {
    const known = db.prepare('SELECT id, name FROM machines WHERE user_id=? AND client_id=?').get(userId, report.id) as { id: string; name: string } | undefined;
    if (known) return known;
    const taken = new Set((db.prepare('SELECT name FROM machines WHERE user_id=?').all(userId) as { name: string }[]).map(row => row.name));
    let name = report.name;
    for (let n = 2; taken.has(name); n++) name = `${report.name} ${n}`;
    const id = randomUUID();
    db.prepare('INSERT INTO machines(id,user_id,client_id,name,created_at) VALUES(?,?,?,?,?)').run(id, userId, report.id, name, Date.now());
    return { id, name };
  }

  /** A client without credentials is not listed anywhere, so nobody could remove it. */
  const dropEmpty = () => db.prepare('DELETE FROM machines WHERE id NOT IN (SELECT machine_id FROM devices WHERE machine_id IS NOT NULL)').run();

  /** Puts a credential under its client; other credentials of the same installation are replaced by it. */
  function attach(device: { id: string; user_id: string; vault_id: string }, report: ClientReport) {
    db.exec('BEGIN IMMEDIATE');
    const machine = machineFor(device.user_id, report);
    const replaced = (db.prepare('SELECT id FROM devices WHERE machine_id=? AND installation=? AND revoked=0 AND id<>?').all(machine.id, report.installation, device.id) as { id: string }[]).map(row => row.id);
    db.prepare('UPDATE devices SET machine_id=?, installation=? WHERE id=?').run(machine.id, report.installation, device.id);
    for (const id of replaced) {
      db.prepare('UPDATE vaults SET rebuild_device=? WHERE rebuild_device=? AND id=?').run(device.id, id, device.vault_id);
      db.prepare('UPDATE vaults SET rebuild_device=NULL, rebuild_until=NULL, rebuild_started=NULL WHERE rebuild_device=?').run(id);
      db.prepare('DELETE FROM devices WHERE id=?').run(id);
      audit(device.user_id, 'device.replace', id);
    }
    dropEmpty();
    db.exec('COMMIT');
    for (const id of replaced) disconnect(id);
    return machine;
  }

  /** The account's clients that can still synchronise, most recently used first. */
  function list(userId: string) {
    const rows = db.prepare(`SELECT m.id AS machineId, m.name, m.created_at AS createdAt, d.id, d.vault_id AS vaultId, v.name AS vaultName, d.expires_at AS expiresAt, d.last_seen_at AS lastSeenAt
      FROM machines m JOIN devices d ON d.machine_id=m.id AND d.revoked=0 AND d.expires_at>? JOIN vaults v ON v.id=d.vault_id
      WHERE m.user_id=? ORDER BY v.name`).all(Date.now(), userId) as { machineId: string; name: string; createdAt: number; id: string; vaultId: string; vaultName: string; expiresAt: number; lastSeenAt: number | null }[];
    const machines = new Map<string, { id: string; name: string; createdAt: number; lastSeenAt: number | null; devices: { id: string; vaultId: string; vaultName: string; expiresAt: number; lastSeenAt: number | null }[] }>();
    for (const { machineId, name, createdAt, ...device } of rows) {
      const machine = machines.get(machineId) ?? { id: machineId, name, createdAt, lastSeenAt: null, devices: [] };
      machine.devices.push(device);
      machine.lastSeenAt = Math.max(machine.lastSeenAt ?? 0, device.lastSeenAt ?? 0) || null;
      machines.set(machineId, machine);
    }
    return [...machines.values()].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  }

  const owned = (id: string, userId: string) => {
    if (!db.prepare('SELECT 1 FROM machines WHERE id=? AND user_id=?').get(id, userId)) fail(404, 'Device not found');
  };
  function rename(id: string, userId: string, value: string) {
    owned(id, userId);
    const name = value.trim();
    if (!name) fail(400, 'Invalid name');
    db.prepare('UPDATE machines SET name=? WHERE id=?').run(name, id);
    audit(userId, 'machine.rename', id);
  }
  /** Revokes every credential of a client and forgets it; signing in from it again makes a new one. */
  function remove(id: string, userId: string) {
    owned(id, userId);
    const devices = (db.prepare('SELECT id FROM devices WHERE machine_id=?').all(id) as { id: string }[]).map(row => row.id);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE vaults SET rebuild_device=NULL, rebuild_until=NULL, rebuild_started=NULL WHERE rebuild_device IN (SELECT id FROM devices WHERE machine_id=?)').run(id);
    db.prepare('DELETE FROM devices WHERE machine_id=?').run(id);
    db.prepare('DELETE FROM machines WHERE id=?').run(id);
    audit(userId, 'machine.revoke', id);
    db.exec('COMMIT');
    for (const device of devices) disconnect(device);
  }
  return { attach, list, rename, remove, dropEmpty };
}
