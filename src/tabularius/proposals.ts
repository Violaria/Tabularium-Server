import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { applyMaskedEdit, REDACTED, type Filter } from './filter.js';
import { repairLinks } from './links.js';

/**
 * One file of a proposal. `hash` is the source file's SHA-256 when the proposal was made; `before` its text (Markdown only)
 * and `after` the text to write (null for a delete, or a move of an unchanged or non-Markdown file).
 */
export interface Change { op: 'create' | 'edit' | 'move' | 'delete'; path: string; to: string | null; hash: string | null; before: string | null; after: string | null; automatic: boolean }
export class ProposalError extends Error {}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const isNote = (path: string) => path.endsWith('.md');

/** All files of the working copy as vault paths; hidden files and folders (LiveSync's own, .obsidian) are skipped. */
export async function files(root: string) {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (!path.split('/').some(part => part.startsWith('.'))) found.push(path);
  }
  return new Set(found.sort());
}

function vaultPath(value: unknown) {
  if (typeof value !== 'string') throw new ProposalError('path must be a string');
  const path = value.trim().replace(/^\/+|\/+$/g, '');
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new ProposalError(`invalid path "${value}"`);
  return path;
}

/**
 * Checks a batch from the model against the working copy and turns it into per-file changes, with link repairs for moves.
 * Throws a ProposalError listing every invalid change.
 */
export async function build(root: string, filter: Filter, input: Record<string, unknown>) {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ProposalError('title must be a non-empty string');
  if (!Array.isArray(input.changes) || !input.changes.length) throw new ProposalError('changes must be a non-empty array');
  const before = await files(root);
  const texts = new Map<string, string>();
  const text = async (path: string) => texts.get(path) ?? texts.set(path, await readFile(join(root, path), 'utf8')).get(path)!;
  const under = (folder: string) => [...before].filter(path => path.startsWith(`${folder}/`));
  const exists = (path: string) => before.has(path) || under(path).length > 0;
  const touched = new Set<string>();
  const touch = (path: string) => {
    if (touched.has(path)) throw new ProposalError(`${path} appears in more than one change`);
    if (filter.excluded(path)) throw new ProposalError(`${path} is excluded from Tabularius`);
    touched.add(path);
  };
  const changes: Change[] = [];
  const errors: string[] = [];

  for (const [i, raw] of (input.changes as Record<string, unknown>[]).entries()) {
    try {
      if (typeof raw !== 'object' || raw === null) throw new ProposalError('change must be an object');
      if (raw.op === 'create') {
        const path = vaultPath(raw.path);
        if (!isNote(path)) throw new ProposalError('only .md notes can be created');
        if (exists(path) || touched.has(path)) throw new ProposalError(`${path} already exists`);
        if (typeof raw.content !== 'string') throw new ProposalError('content must be a string');
        if (raw.content.includes(REDACTED)) throw new ProposalError(`a new note cannot contain ${REDACTED}`);
        touch(path);
        changes.push({ op: 'create', path, to: null, hash: null, before: null, after: raw.content, automatic: false });
      } else if (raw.op === 'edit') {
        const path = vaultPath(raw.path);
        if (!isNote(path) || !before.has(path)) throw new ProposalError(`no note ${path}`);
        if (!Array.isArray(raw.edits) || !raw.edits.length) throw new ProposalError('edits must be a non-empty array');
        touch(path);
        const original = await text(path);
        let result = original;
        for (const [j, edit] of (raw.edits as { old?: unknown; new?: unknown }[]).entries()) {
          if (typeof edit?.old !== 'string' || typeof edit.new !== 'string') throw new ProposalError(`edits[${j}] needs old and new strings`);
          try { result = applyMaskedEdit(filter, result, edit.old, edit.new); } catch (error) { throw new ProposalError(`edits[${j}]: ${(error as Error).message}`); }
        }
        changes.push({ op: 'edit', path, to: null, hash: sha256(Buffer.from(original)), before: original, after: result, automatic: false });
      } else if (raw.op === 'move') {
        const from = vaultPath(raw.from); const to = vaultPath(raw.to);
        if (from === to || to.startsWith(`${from}/`)) throw new ProposalError(`cannot move ${from} to ${to}`);
        if (exists(to) || touched.has(to)) throw new ProposalError(`${to} already exists`);
        const pairs = before.has(from) ? [[from, to]] : under(from).map(path => [path, to + path.slice(from.length)]);
        if (!pairs.length) throw new ProposalError(`no file or folder ${from}`);
        if (before.has(from) && posix.extname(from) !== posix.extname(to)) throw new ProposalError('a move keeps the file extension');
        for (const [source, target] of pairs) {
          touch(source); touch(target);
          const data = await readFile(join(root, source));
          changes.push({ op: 'move', path: source, to: target, hash: sha256(data), before: isNote(source) ? data.toString('utf8') : null, after: null, automatic: false });
        }
      } else if (raw.op === 'delete') {
        const path = vaultPath(raw.path);
        const targets = before.has(path) ? [path] : under(path);
        if (!targets.length) throw new ProposalError(`no file or folder ${path}`);
        for (const target of targets) {
          touch(target);
          const data = await readFile(join(root, target));
          changes.push({ op: 'delete', path: target, to: null, hash: sha256(data), before: isNote(target) ? data.toString('utf8') : null, after: null, automatic: false });
        }
      } else throw new ProposalError('op must be create, edit, move or delete');
    } catch (error) {
      if (!(error instanceof ProposalError)) throw error;
      errors.push(`changes[${i}]: ${error.message}`);
    }
  }
  if (errors.length) throw new ProposalError(errors.join('\n'));

  // Links to moved files, and relative links inside moved notes, are rewritten in every note that remains.
  const moves = new Map(changes.flatMap(change => change.op === 'move' ? [[change.path, change.to!]] : []));
  let repaired = 0;
  if (moves.size) {
    const removed = new Set(changes.flatMap(change => change.op === 'move' || change.op === 'delete' ? [change.path] : []));
    const after = new Set([...before].filter(path => !removed.has(path)));
    for (const change of changes) if (change.op === 'create' || change.op === 'move') after.add(change.to ?? change.path);
    const byPath = new Map(changes.map(change => [change.path, change]));
    for (const path of before) {
      if (!isNote(path) || removed.has(path) && !moves.has(path)) continue;
      const change = byPath.get(path);
      const current = change?.after ?? await text(path);
      const updated = repairLinks(current, path, moves.get(path) ?? path, moves, before, after);
      if (updated === current) continue;
      if (change) change.after = updated;
      else {
        changes.push({ op: 'edit', path, to: null, hash: sha256(Buffer.from(current)), before: current, after: updated, automatic: true });
        repaired++;
      }
    }
  }
  return { title: input.title.trim().slice(0, 200), summary: typeof input.summary === 'string' ? input.summary.trim() : '', changes, repaired };
}

/**
 * Writes a proposal into the working copy after checking that every source is unchanged and every target is free.
 * The error lists the problems one per line as `missing|changed|exists<TAB>path`.
 */
export async function apply(root: string, changes: Change[]) {
  const current = await files(root);
  const problems: string[] = [];
  for (const change of changes) {
    if (change.hash) {
      const data = current.has(change.path) ? await readFile(join(root, change.path)) : undefined;
      if (!data) problems.push(`missing\t${change.path}`);
      else if (sha256(data) !== change.hash) problems.push(`changed\t${change.path}`);
    }
    const target = change.op === 'create' ? change.path : change.to;
    if (target && current.has(target)) problems.push(`exists\t${target}`);
  }
  if (problems.length) throw new ProposalError(problems.join('\n'));
  const emptied = new Set<string>();
  for (const change of changes) {
    const source = join(root, change.path);
    if (change.op === 'create' || change.op === 'edit') {
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, change.after!);
    } else if (change.op === 'move') {
      // Written anew rather than renamed: a rename keeps the old modification time.
      const target = join(root, change.to!);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, change.after ?? await readFile(source));
      await unlink(source);
      emptied.add(posix.dirname(change.path));
    } else {
      await unlink(source);
      emptied.add(posix.dirname(change.path));
    }
  }
  // Folders left empty are removed, deepest first; empty folders do not sync anyway.
  for (const folder of [...emptied].sort((a, b) => b.length - a.length)) {
    for (let path = folder; path !== '.'; path = posix.dirname(path)) {
      try { await rmdir(join(root, path)); } catch { break; }
    }
  }
}
