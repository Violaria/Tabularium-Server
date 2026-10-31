// Writing one backup point without stopping the server: an online snapshot of the application database (without the
// Tabularius search index, which holds note text) and the CouchDB databases as revision trees.
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, type Gzip } from 'node:zlib';
import { backup, DatabaseSync } from 'node:sqlite';
import { basic, type CouchConfig } from '../couch.js';
import type { DatabaseExport } from './format.js';

const BATCH = 500;
/** File names for a database's export: CouchDB names may contain characters that are not safe in file names. */
export const databaseFile = (name: string, kind: 'docs' | 'local' | 'security') =>
  `couch/${encodeURIComponent(name)}.${kind === 'docs' ? 'ndjson.gz' : `${kind}.json`}`;

async function couch(config: CouchConfig, path: string, body?: unknown) {
  const response = await fetch(`${config.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(300_000),
    headers: { authorization: basic(config.adminUser, config.adminPassword), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`CouchDB ${path.split('?')[0]}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function write(stream: Gzip, line: string) {
  if (!stream.write(line)) await new Promise(resolve => stream.once('drain', resolve));
}

/** The application databases (not CouchDB's own `_users` and `_replicator`). */
export async function databases(config: CouchConfig) {
  const response = await fetch(`${config.url}/_all_dbs`, { headers: { authorization: basic(config.adminUser, config.adminPassword) }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`CouchDB _all_dbs: ${response.status}`);
  return (await response.json() as string[]).filter(name => !name.startsWith('_'));
}

/**
 * Every leaf revision changed since `since` ('0' for all), with its revision history, so deleted documents and conflict
 * branches are kept; then the `_local` documents and the security object, which are small and written whole each time.
 */
export async function exportDatabase(config: CouchConfig, name: string, since: string, directory: string): Promise<DatabaseExport> {
  const db = `/${encodeURIComponent(name)}`;
  const gzip = createGzip();
  const done = pipeline(gzip, createWriteStream(join(directory, databaseFile(name, 'docs')), { mode: 0o600 }));
  let seq = since;
  let revisions = 0;
  try {
    for (;;) {
      const changes = await couch(config, `${db}/_changes?style=all_docs&limit=${BATCH}&since=${encodeURIComponent(seq)}`) as
        { results: { id: string; changes: { rev: string }[] }[]; last_seq: string };
      if (changes.results.length) {
        const docs = changes.results.flatMap(change => change.changes.map(({ rev }) => ({ id: change.id, rev })));
        const fetched = await couch(config, `${db}/_bulk_get?revs=true&attachments=true`, { docs }) as
          { results: { id: string; docs: ({ ok: Record<string, unknown> } | { error: { error: string; reason: string } })[] }[] };
        for (const result of fetched.results) {
          for (const item of result.docs) {
            if (!('ok' in item)) throw new Error(`CouchDB ${name}/${result.id}: ${item.error.error} ${item.error.reason}`);
            await write(gzip, `${JSON.stringify(item.ok)}\n`);
            revisions++;
          }
        }
      }
      seq = changes.last_seq;
      if (changes.results.length < BATCH) break;
    }
  } catch (error) {
    // The file is removed with the partial point; the stream is closed so no handle is left open.
    gzip.destroy();
    await done.catch(() => {});
    throw error;
  }
  gzip.end();
  await done;
  const local = (await couch(config, `${db}/_local_docs?include_docs=true`) as { rows: { doc: Record<string, unknown> }[] }).rows.map(row => row.doc);
  await writeFile(join(directory, databaseFile(name, 'local')), JSON.stringify(local), { mode: 0o600 });
  await writeFile(join(directory, databaseFile(name, 'security')), JSON.stringify(await couch(config, `${db}/_security`)), { mode: 0o600 });
  return { since, lastSeq: seq, revisions, local: local.length };
}

/** An online copy of the application database without the search index and sessions, compressed. */
export async function snapshotSqlite(db: DatabaseSync, directory: string) {
  const copy = join(directory, 'app.sqlite');
  await backup(db, copy);
  const snapshot = new DatabaseSync(copy);
  // The index is rebuilt from the notes after a restore; sessions are not restored.
  snapshot.exec('DELETE FROM tabularius_chunks; DELETE FROM tabularius_files; DELETE FROM sessions; VACUUM;');
  const schema = (snapshot.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  snapshot.close();
  await pipeline(createReadStream(copy), createGzip(), createWriteStream(`${copy}.gz`, { mode: 0o600 }));
  await rm(copy);
  return schema;
}
