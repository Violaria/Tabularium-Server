import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Filter } from './filter.js';

export interface Chunk { heading: string; text: string }
export interface Hit { path: string; heading: string; snippet: string }
export interface Embedder { model: string; embed(texts: string[]): Promise<Float32Array[]> }

const CHUNK = 1500;

/** Splits a note at its headings, then packs paragraphs of long sections into pieces of about 1,500 characters. */
export function chunk(markdown: string): Chunk[] {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  const sections: { trail: string[]; lines: string[] }[] = [{ trail: [], lines: [] }];
  let trail: string[] = [];
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      trail = [...trail.slice(0, heading[1].length - 1), heading[2].trim()];
      sections.push({ trail, lines: [] });
    } else sections.at(-1)!.lines.push(line);
  }
  const chunks: Chunk[] = [];
  for (const { trail: path, lines } of sections) {
    const heading = path.filter(Boolean).join(' > ');
    let piece = '';
    for (const paragraph of lines.join('\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)) {
      if (piece && piece.length + paragraph.length > CHUNK) { chunks.push({ heading, text: piece }); piece = ''; }
      piece = piece ? `${piece}\n\n${paragraph}` : paragraph;
      while (piece.length > CHUNK * 2) { chunks.push({ heading, text: piece.slice(0, CHUNK) }); piece = piece.slice(CHUNK); }
    }
    if (piece || (heading && !lines.join('').trim())) chunks.push({ heading, text: piece });
  }
  return chunks.filter(c => c.text || c.heading);
}

/** Markdown files of the working copy, as vault paths with `/` separators; LiveSync's own folders are skipped. */
export async function notes(root: string) {
  const files: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (path.split('/').some(part => part.startsWith('.'))) continue;
    files.push(path);
  }
  return files.sort();
}

/** Brings the index of one vault up to date with its working copy; returns the number of notes reindexed. */
export async function update(db: DatabaseSync, vaultId: string, root: string, filter: Filter, embedder?: Embedder) {
  const known = new Map((db.prepare('SELECT path, mtime, size FROM tabularius_files WHERE vault_id=?').all(vaultId) as { path: string; mtime: number; size: number }[])
    .map(row => [row.path, row]));
  const present = new Set<string>();
  let changed = 0;
  for (const path of await notes(root)) {
    if (filter.excluded(path)) continue;
    present.add(path);
    const info = await stat(join(root, path));
    const previous = known.get(path);
    if (previous && previous.mtime === Math.floor(info.mtimeMs) && previous.size === info.size) continue;
    const pieces = chunk(await readFile(join(root, path), 'utf8'));
    const vectors = embedder && pieces.length ? await embedder.embed(pieces.map(p => filter.mask(`${path}\n${p.heading}\n${p.text}`))) : [];
    db.exec('BEGIN');
    db.prepare('DELETE FROM tabularius_chunks WHERE vault_id=? AND path=?').run(vaultId, path);
    const insert = db.prepare('INSERT INTO tabularius_chunks(vault_id, path, heading, text, embedding) VALUES(?,?,?,?,?)');
    pieces.forEach((piece, i) => insert.run(vaultId, path, piece.heading, piece.text, vectors[i] ? new Uint8Array(vectors[i].buffer) : null));
    db.prepare('INSERT OR REPLACE INTO tabularius_files VALUES(?,?,?,?)').run(vaultId, path, Math.floor(info.mtimeMs), info.size);
    db.exec('COMMIT');
    changed++;
  }
  for (const path of known.keys()) {
    if (present.has(path)) continue;
    db.prepare('DELETE FROM tabularius_chunks WHERE vault_id=? AND path=?').run(vaultId, path);
    db.prepare('DELETE FROM tabularius_files WHERE vault_id=? AND path=?').run(vaultId, path);
    changed++;
  }
  return changed;
}

export function forget(db: DatabaseSync, vaultId: string) {
  db.prepare('DELETE FROM tabularius_chunks WHERE vault_id=?').run(vaultId);
  db.prepare('DELETE FROM tabularius_files WHERE vault_id=?').run(vaultId);
}

interface Row { id: number; path: string; heading: string; text: string }

/** Full-text and, with an embedder, vector search over one vault, merged by reciprocal rank. */
export async function search(db: DatabaseSync, vaultId: string, query: string, embedder?: Embedder, limit = 8): Promise<Hit[]> {
  const ranked: Row[][] = [];
  const terms = query.split(/\s+/).filter(Boolean);
  // The trigram tokenizer needs three characters; shorter terms fall back to a substring scan.
  if (terms.length && terms.every(term => [...term].length >= 3)) {
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    ranked.push(db.prepare(`SELECT c.id, c.path, c.heading, c.text FROM tabularius_fts f JOIN tabularius_chunks c ON c.id=f.rowid
      WHERE tabularius_fts MATCH ? AND c.vault_id=? ORDER BY bm25(tabularius_fts) LIMIT 20`).all(match, vaultId) as unknown as Row[]);
  } else if (terms.length) {
    const like = terms.map(() => '(c.text LIKE ? OR c.heading LIKE ? OR c.path LIKE ?)').join(' OR ');
    ranked.push(db.prepare(`SELECT c.id, c.path, c.heading, c.text FROM tabularius_chunks c WHERE c.vault_id=? AND (${like}) LIMIT 20`)
      .all(vaultId, ...terms.flatMap(term => Array(3).fill(`%${term}%`))) as unknown as Row[]);
  }
  ranked.push(db.prepare('SELECT c.id, c.path, c.heading, c.text FROM tabularius_chunks c WHERE c.vault_id=? AND c.path LIKE ? LIMIT 20')
    .all(vaultId, `%${query.trim()}%`) as unknown as Row[]);
  if (embedder) {
    const [target] = await embedder.embed([query]);
    const scored = (db.prepare('SELECT id, path, heading, text, embedding FROM tabularius_chunks WHERE vault_id=? AND embedding IS NOT NULL').all(vaultId) as unknown as (Row & { embedding: Uint8Array })[])
      .map(row => ({ row, score: cosine(target, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)) }))
      .sort((a, b) => b.score - a.score).slice(0, 20);
    ranked.push(scored.map(s => s.row));
  }
  const scores = new Map<number, { row: Row; score: number }>();
  for (const list of ranked) list.forEach((row, rank) => {
    const entry = scores.get(row.id) ?? { row, score: 0 };
    entry.score += 1 / (60 + rank);
    scores.set(row.id, entry);
  });
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ row }) => ({ path: row.path, heading: row.heading, snippet: row.text.slice(0, 600) }));
}

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
}
