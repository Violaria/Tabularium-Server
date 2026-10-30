import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { cosine, type Embedder } from './search.js';

export interface Memory { id: string; content: string; createdAt: number; updatedAt: number }
interface Row { id: string; content: string; embedding: Uint8Array | null; created_at: number; updated_at: number }

const MAX_LENGTH = 2000;
const view = (row: Row): Memory => ({ id: row.id, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at });
const vector = (blob: Uint8Array) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);

export class MemoryError extends Error {}

/** A user's memories: facts and preferences Tabularius keeps across conversations and vaults. */
export function createMemories(db: DatabaseSync, embedder?: Embedder) {
  const rows = (userId: string) => db.prepare('SELECT * FROM tabularius_memories WHERE user_id=? ORDER BY updated_at DESC').all(userId) as unknown as Row[];
  const get = (userId: string, id: string) => db.prepare('SELECT * FROM tabularius_memories WHERE id=? AND user_id=?').get(id, userId) as unknown as Row | undefined;
  const embed = async (content: string) => embedder ? new Uint8Array((await embedder.embed([content]))[0].buffer) : null;
  function check(content: unknown) {
    if (typeof content !== 'string' || !content.trim()) throw new MemoryError('content must be a non-empty string');
    if (content.length > MAX_LENGTH) throw new MemoryError(`a memory holds at most ${MAX_LENGTH} characters`);
    return content.trim();
  }
  return {
    list: (userId: string) => rows(userId).map(view),
    async add(userId: string, content: unknown) {
      const text = check(content);
      const id = randomUUID(); const now = Date.now();
      db.prepare('INSERT INTO tabularius_memories VALUES(?,?,?,?,?,?)').run(id, userId, text, await embed(text), now, now);
      return view(get(userId, id)!);
    },
    async update(userId: string, id: string, content: unknown) {
      const text = check(content);
      if (!get(userId, id)) return undefined;
      db.prepare('UPDATE tabularius_memories SET content=?, embedding=?, updated_at=? WHERE id=?').run(text, await embed(text), Date.now(), id);
      return view(get(userId, id)!);
    },
    remove(userId: string, id: string) {
      return db.prepare('DELETE FROM tabularius_memories WHERE id=? AND user_id=?').run(id, userId).changes > 0;
    },
    /** The memories most related to a text: by embedding when there is one, otherwise the most recently updated. */
    async relevant(userId: string, text: string, limit: number) {
      const all = rows(userId);
      if (!embedder || !text.trim() || all.length <= limit) return all.slice(0, embedder ? limit : limit * 2).map(view);
      const [target] = await embedder.embed([text]);
      return all.filter(row => row.embedding && row.embedding.byteLength === target.length * 4)
        .map(row => ({ row, score: cosine(target, vector(row.embedding!)) })).sort((a, b) => b.score - a.score).slice(0, limit).map(entry => view(entry.row));
    },
  };
}
export type Memories = ReturnType<typeof createMemories>;
