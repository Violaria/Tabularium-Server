// Scheduled backups on disk: one directory per backup point, `<id>/manifest.json` with the files it lists. A chain starts
// with a full point; each incremental point holds what changed in CouchDB since the previous point of its chain. A point is
// written as `<id>.partial` and renamed once its files are verified.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const FORMAT = 'tabularium-scheduled-1';

export interface DatabaseExport {
  /** The changes feed position the export started from ('0' for everything) and reached. */
  since: string; lastSeq: string;
  /** Leaf revisions written (documents, deleted ones and conflict branches), and `_local` documents. */
  revisions: number; local: number;
}
export interface PointManifest {
  format: typeof FORMAT; id: string; type: 'full' | 'incremental'; chain: string; previous: string | null;
  createdAt: string; finishedAt: string; server: { version: string; schema: number };
  /** CouchDB databases as exported; a database new since the previous point is exported from the start. */
  databases: Record<string, DatabaseExport>;
  files: { name: string; size: number; sha256: string }[];
}

export async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Reads a point's manifest and checks every file's size and checksum; throws on the first difference. */
export async function verifyPoint(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as PointManifest;
  if (manifest.format !== FORMAT) throw new Error(`${directory}: not a scheduled backup point`);
  for (const file of manifest.files) {
    const path = join(directory, file.name);
    if ((await stat(path)).size !== file.size || await sha256(path) !== file.sha256) throw new Error(`${directory}: ${file.name} does not match the manifest`);
  }
  return manifest;
}

/** The published points in a backup directory, oldest first; partial directories and other files are skipped. */
export async function listPoints(root: string) {
  const points: PointManifest[] = [];
  for (const name of (await readdir(root).catch(() => [])).sort()) {
    if (name.endsWith('.partial')) continue;
    const text = await readFile(join(root, name, 'manifest.json'), 'utf8').catch(() => undefined);
    // A damaged manifest is not a point: the next backup starts a new chain, and restores refuse it.
    let manifest: PointManifest | undefined;
    try { manifest = text ? JSON.parse(text) as PointManifest : undefined; } catch { manifest = undefined; }
    if (manifest?.format === FORMAT && manifest.id === name) points.push(manifest);
  }
  return points;
}
