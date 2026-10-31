// Scheduled online backups: settings (edited by administrators on the web), the timer, one run at a time, chains of a
// full point and incremental points, retention by whole chains, and the history of runs.
import type { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CouchConfig } from '../couch.js';
import { databases, exportDatabase, snapshotSqlite } from './export.js';
import { FORMAT, listPoints, sha256, verifyPoint, type DatabaseExport, type PointManifest } from './format.js';
import { nextRun, previousRun, validTimezone, type Plan } from './schedule.js';

export interface BackupSettings extends Plan {
  enabled: boolean;
  /** Backup points kept; whole chains are removed once none of their points is among the newest `keep`. */
  keep: number;
  /** A new chain starts after this many points. */
  fullEvery: number;
  /** When the schedule was last switched on: times missed before it are not made up. */
  enabledAt: number;
}
export interface BackupRun { id: string; trigger: 'scheduled' | 'manual'; type: 'full' | 'incremental' | null; chain: string | null; startedAt: number; finishedAt: number | null; size: number | null; ok: boolean | null; error: string | null }
export class BackupError extends Error {}

const defaultTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const stamp = (time: number) => new Date(time).toISOString().replace(/[-:]/g, '');
const MAX_TIMEOUT = 2 ** 31 - 1;

async function filesOf(directory: string, base = directory): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await filesOf(path, base)); else out.push(relative(base, path));
  }
  return out.sort();
}

export function createBackups(options: { db: DatabaseSync; couch: CouchConfig; directory: string | undefined; version: string; onFailure: (error: string) => void }) {
  const { db, directory } = options;
  const read = () => {
    const row = db.prepare("SELECT value FROM server_settings WHERE key='backups'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) as BackupSettings
      // Nothing is chosen on the administrator's behalf: no time and no number of points until they are set.
      : { enabled: false, frequency: 'daily', weekday: 1, monthDay: 1, time: '', timezone: defaultTimezone(), keep: 0, fullEvery: 7, enabledAt: 0 } satisfies BackupSettings;
  };
  const write = (settings: BackupSettings) =>
    db.prepare("INSERT INTO server_settings(key, value) VALUES('backups', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(settings));
  const runs = () => (db.prepare('SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 50').all() as Record<string, unknown>[]).map(row => ({
    id: row.id, trigger: row.trigger, type: row.type, chain: row.chain, startedAt: row.started_at, finishedAt: row.finished_at, size: row.size,
    ok: row.ok === null ? null : Boolean(row.ok), error: row.error,
  }) as BackupRun);

  let running: Promise<BackupRun> | undefined;
  let timer: NodeJS.Timeout | undefined;

  /** Removes partial points and every chain none of whose points is among the newest `keep`. */
  async function prune(keep: number) {
    if (!directory) return;
    for (const name of await readdir(directory)) if (name.endsWith('.partial')) await rm(join(directory, name), { recursive: true, force: true });
    const points = await listPoints(directory);
    const kept = new Set(points.slice(-keep).map(point => point.chain));
    for (const point of points) if (!kept.has(point.chain)) await rm(join(directory, point.id), { recursive: true, force: true });
  }

  async function backupNow(directory: string, trigger: BackupRun['trigger']): Promise<BackupRun> {
    const settings = read();
    const startedAt = Date.now();
    const id = stamp(startedAt);
    db.prepare('INSERT INTO backup_runs(id, trigger, started_at) VALUES(?, ?, ?)').run(id, trigger, startedAt);
    const partial = join(directory, `${id}.partial`);
    try {
      await mkdir(join(partial, 'couch'), { recursive: true, mode: 0o700 });
      const points = await listPoints(directory);
      const last = points.at(-1);
      // A new chain after `fullEvery` points, and whenever any point of the current chain cannot be trusted.
      const chain = last ? points.filter(point => point.chain === last.chain) : [];
      const intact = async () => {
        for (const point of chain) if (!await verifyPoint(join(directory, point.id)).then(() => true, () => false)) return false;
        return chain[0]?.type === 'full';
      };
      const previous = last && chain.length < settings.fullEvery && await intact() ? last : undefined;
      const schema = await snapshotSqlite(db, partial);
      const exported: Record<string, DatabaseExport> = {};
      for (const name of await databases(options.couch)) {
        exported[name] = await exportDatabase(options.couch, name, previous?.databases[name]?.lastSeq ?? '0', partial);
      }
      const files = [];
      for (const name of await filesOf(partial)) files.push({ name, size: (await stat(join(partial, name))).size, sha256: await sha256(join(partial, name)) });
      const manifest: PointManifest = {
        format: FORMAT, id, type: previous ? 'incremental' : 'full', chain: previous?.chain ?? id, previous: previous?.id ?? null,
        createdAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
        server: { version: options.version, schema }, databases: exported, files,
      };
      await writeFile(join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await verifyPoint(partial);
      await rename(partial, join(directory, id));
      const size = files.reduce((sum, file) => sum + file.size, 0);
      db.prepare('UPDATE backup_runs SET type=?, chain=?, finished_at=?, size=?, ok=1 WHERE id=?').run(manifest.type, manifest.chain, Date.now(), size, id);
      if (settings.keep > 0) await prune(settings.keep);
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await rm(partial, { recursive: true, force: true });
      db.prepare('UPDATE backup_runs SET finished_at=?, ok=0, error=? WHERE id=?').run(Date.now(), message, id);
      options.onFailure(message);
    }
    return runs().find(run => run.id === id)!;
  }

  /** One run at a time; a run asked for while one is going waits for nothing and reports it. */
  function start(trigger: BackupRun['trigger']) {
    if (!directory) throw new BackupError('Backups are not set up on this server');
    if (running) throw new BackupError('A backup is already running');
    running = backupNow(directory, trigger).finally(() => { running = undefined; });
    return running;
  }

  /** Sets the timer for the next scheduled time; a time missed while the server was down is made up once at start. */
  function schedule(makeUp = false) {
    clearTimeout(timer);
    const settings = read();
    if (!directory || !settings.enabled) return;
    const now = Date.now();
    if (makeUp) {
      const missed = previousRun(now, settings);
      const last = db.prepare('SELECT max(started_at) AS at FROM backup_runs').get() as { at: number | null };
      if (missed > settings.enabledAt && missed > (last.at ?? 0)) void start('scheduled').catch(() => {});
    }
    const at = nextRun(now, settings);
    timer = setTimeout(() => {
      if (Date.now() >= at && !running) void start('scheduled').catch(() => {});
      schedule();
    }, Math.min(at - now, MAX_TIMEOUT));
    timer.unref();
  }
  schedule(true);

  return {
    /** What the backups page shows. */
    async view() {
      const settings = read();
      const free = directory ? await statfs(directory).then(s => s.bavail * s.bsize, () => null) : null;
      const points = directory ? await listPoints(directory) : [];
      return {
        available: Boolean(directory), directory: directory ?? null, settings, running: Boolean(running), free,
        next: directory && settings.enabled ? nextRun(Date.now(), settings) : null,
        points: points.map(point => ({ id: point.id, type: point.type, chain: point.chain, createdAt: point.createdAt, size: point.files.reduce((sum, file) => sum + file.size, 0) })).reverse(),
        runs: runs(),
      };
    },
    update(data: Record<string, unknown>) {
      const current = read();
      const next = { ...current } as BackupSettings;
      if (typeof data.enabled !== 'boolean' || !['daily', 'weekly', 'monthly'].includes(data.frequency as string)
        || !Number.isInteger(data.weekday) || (data.weekday as number) < 0 || (data.weekday as number) > 6
        || !Number.isInteger(data.monthDay) || (data.monthDay as number) < 1 || (data.monthDay as number) > 31
        || typeof data.time !== 'string' || (data.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time))
        || typeof data.timezone !== 'string' || !validTimezone(data.timezone)
        || !Number.isInteger(data.keep) || (data.keep as number) < 0 || (data.keep as number) > 1000
        || !Number.isInteger(data.fullEvery) || (data.fullEvery as number) < 1 || (data.fullEvery as number) > 365) throw new BackupError('Invalid backup settings');
      if (data.enabled && (!data.time || !data.keep)) throw new BackupError('Set the time and the number of backups to keep first');
      Object.assign(next, { enabled: data.enabled, frequency: data.frequency, weekday: data.weekday, monthDay: data.monthDay, time: data.time,
        timezone: data.timezone, keep: data.keep, fullEvery: data.fullEvery });
      if (data.enabled && !current.enabled) next.enabledAt = Date.now();
      write(next);
      schedule();
    },
    run: () => start('manual'),
    /** The latest run's failure, until a run succeeds. */
    lastFailure() {
      const last = db.prepare('SELECT started_at AS at, ok, error FROM backup_runs WHERE ok IS NOT NULL ORDER BY started_at DESC LIMIT 1').get() as { at: number; ok: number; error: string } | undefined;
      return last && !last.ok ? { at: last.at, error: last.error } : null;
    },
    close() { clearTimeout(timer); return running; },
  };
}
export type Backups = ReturnType<typeof createBackups>;
