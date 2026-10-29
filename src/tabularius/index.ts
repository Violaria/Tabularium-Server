import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Couch } from '../couch.js';
import { digest, token, type User, type Vault } from '../store.js';
import { createClients, inspect, open, seal, WrongPassphrase } from './client.js';
import { checkMasks, createFilter, type Filter } from './filter.js';
import { BUILT_IN, VAULT_RULES } from './prompt.js';
import { ProviderError, type Message, type Part, type Provider, type Tool } from './providers.js';
import { forget, notes, search, update, type Embedder } from './search.js';

export interface TabulariusConfig { key: Buffer; root: string; cli: string; provider: Provider; embedder?: Embedder }
interface Row { vault_id: string; device_id: string; device_secret: Uint8Array; passphrase: Uint8Array; tweaks: string; enabled_at: number; excluded: string; masks: string }
interface Conversation { id: string; user_id: string; vault_id: string; title: string; system: string; created_at: number; updated_at: number }

const RENEW_BEFORE_MS = 15 * 86_400_000;
const MAX_TOOL_ROUNDS = 8;
const READ_LIMIT = 40_000;
const TOOLS: Tool[] = [
  { name: 'search_notes', description: 'Full-text and semantic search over the vault. Returns matching note paths, the heading of each matching section and a snippet. Search several phrasings when the first finds nothing.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words or a phrase to look for, in the language of the notes' } }, required: ['query'] } },
  { name: 'read_note', description: 'Reads one note in full by its vault path, as returned by search_notes or list_notes.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Vault path, e.g. folder/note.md' } }, required: ['path'] } },
  { name: 'list_notes', description: 'Lists the notes and subfolders directly inside a folder. Use an empty string for the vault root.',
    parameters: { type: 'object', properties: { folder: { type: 'string', description: 'Folder path without trailing slash; empty for the root' } }, required: ['folder'] } },
];

/**
 * The AI curator. `fail` raises the gateway's HTTP errors; `cancel` drops proxied sync connections of a revoked device.
 * Every vault row has a running CLI daemon while the server is up.
 */
export function createTabularius(db: DatabaseSync, couch: Couch, config: TabulariusConfig, deviceMs: number,
  fail: (status: number, message: string) => never, cancel: (deviceId: string) => void) {
  let syncUrl = '';
  const clients = createClients(config.root, config.cli, () => syncUrl);
  const indexing = new Map<string, Promise<unknown>>();
  const indexErrors = new Map<string, string>();
  const row = (vaultId: string) => db.prepare('SELECT * FROM tabularius_vaults WHERE vault_id=?').get(vaultId) as unknown as Row | undefined;
  const filterOf = (r: Row) => createFilter(r.excluded, r.masks);

  /** Serialises index updates per vault; a call during an update waits for it and runs again. */
  function reindex(vaultId: string) {
    const next = (indexing.get(vaultId) ?? Promise.resolve()).then(async () => {
      const current = row(vaultId);
      if (!current) return;
      try { await update(db, vaultId, clients.working(vaultId), filterOf(current), config.embedder); indexErrors.delete(vaultId); }
      catch (error) { indexErrors.set(vaultId, (error as Error).message.slice(0, 300)); }
    });
    indexing.set(vaultId, next);
    return next;
  }
  function renew() {
    const soon = Date.now() + RENEW_BEFORE_MS;
    db.prepare(`UPDATE devices SET expires_at=? WHERE revoked=0 AND expires_at<? AND id IN (SELECT device_id FROM tabularius_vaults)`).run(Date.now() + deviceMs, soon);
  }
  const timer = setInterval(() => {
    renew();
    for (const { vault_id } of db.prepare('SELECT vault_id FROM tabularius_vaults').all() as { vault_id: string }[]) void reindex(vault_id);
  }, 15_000);
  timer.unref();

  const hosted = (r: Row) => ({ vaultId: r.vault_id, deviceId: r.device_id, secret: open(config.key, r.device_secret), passphrase: open(config.key, r.passphrase), tweaks: JSON.parse(r.tweaks) });

  /** The rules apply from the first index, so notes excluded here never leave the server. */
  async function enable(vault: Vault, user: User, passphrase: string, excluded: string, masks: string) {
    if (row(vault.id)) fail(409, 'Tabularius is already enabled for this vault');
    if (vault.state !== 'ready') fail(409, 'Vault is not ready');
    try { checkMasks(masks); } catch { fail(400, 'Invalid mask pattern'); }
    let tweaks;
    try { tweaks = await inspect(couch, vault.database_name, passphrase); } catch (error) {
      if (error instanceof WrongPassphrase) fail(400, 'Wrong passphrase');
      throw error;
    }
    const deviceId = randomUUID(); const secret = token();
    db.exec('BEGIN');
    db.prepare('INSERT INTO devices(id,user_id,vault_id,name,secret_hash,expires_at) VALUES(?,?,?,?,?,?)').run(deviceId, user.id, vault.id, 'Tabularius', digest(secret), Date.now() + deviceMs);
    db.prepare('INSERT INTO tabularius_vaults(vault_id,device_id,device_secret,passphrase,tweaks,enabled_at,excluded,masks) VALUES(?,?,?,?,?,?,?,?)')
      .run(vault.id, deviceId, seal(config.key, secret), seal(config.key, passphrase), JSON.stringify(tweaks), Date.now(), excluded, masks);
    db.exec('COMMIT');
    await clients.start(hosted(row(vault.id)!));
  }
  async function disable(vaultId: string) {
    const current = row(vaultId);
    if (!current) fail(404, 'Tabularius is not enabled for this vault');
    await clients.stop(vaultId);
    db.exec('BEGIN');
    db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(current!.device_id);
    db.prepare('DELETE FROM tabularius_messages WHERE conversation_id IN (SELECT id FROM tabularius_conversations WHERE vault_id=?)').run(vaultId);
    db.prepare('DELETE FROM tabularius_conversations WHERE vault_id=?').run(vaultId);
    forget(db, vaultId);
    db.prepare('DELETE FROM tabularius_vaults WHERE vault_id=?').run(vaultId);
    db.exec('COMMIT');
    cancel(current!.device_id);
    await indexing.get(vaultId);
    forget(db, vaultId);
    indexing.delete(vaultId); indexErrors.delete(vaultId);
    await clients.remove(vaultId);
  }
  function status(vault: Vault) {
    const current = row(vault.id);
    if (!current) return { id: vault.id, name: vault.name, enabled: false };
    const client = clients.state(vault.id);
    const device = db.prepare('SELECT revoked, expires_at FROM devices WHERE id=?').get(current.device_id) as { revoked: number; expires_at: number };
    const counts = db.prepare('SELECT (SELECT count(*) FROM tabularius_files WHERE vault_id=?) AS notes, (SELECT count(*) FROM tabularius_chunks WHERE vault_id=?) AS chunks').get(vault.id, vault.id) as { notes: number; chunks: number };
    return { id: vault.id, name: vault.name, enabled: true, enabledAt: current.enabled_at, excluded: current.excluded, masks: current.masks,
      running: Boolean(client?.running), replicated: Boolean(client?.replicated), restarts: client?.restarts ?? 0, deviceRevoked: Boolean(device.revoked),
      indexError: indexErrors.get(vault.id) ?? null, log: client?.log.slice(-8) ?? [], ...counts };
  }

  // Tools: read-only access to the working copy, filtered and masked before anything leaves the server.
  function notePath(filter: Filter, value: unknown) {
    const path = typeof value === 'string' ? value.trim().replace(/^\/+/, '') : '';
    if (!path || path.split('/').some(part => part === '..' || part === '.' || part.startsWith('.')) || !path.endsWith('.md') || filter.excluded(path)) return undefined;
    return path;
  }
  async function runTool(vaultId: string, filter: Filter, call: Extract<Part, { type: 'tool_call' }>, read: Set<string>): Promise<string> {
    const root = clients.working(vaultId);
    if (call.name === 'search_notes') {
      if (typeof call.input.query !== 'string' || !call.input.query.trim()) return 'Error: query must be a non-empty string.';
      await reindex(vaultId);
      const hits = (await search(db, vaultId, call.input.query, config.embedder)).filter(hit => !filter.excluded(hit.path));
      if (!hits.length) return 'No matching notes.';
      return filter.mask(hits.map(hit => `[[${hit.path}]]${hit.heading ? ` > ${hit.heading}` : ''}\n${hit.snippet}`).join('\n\n---\n\n'));
    }
    if (call.name === 'read_note') {
      const path = notePath(filter, call.input.path);
      if (!path) return 'Error: no such note.';
      let text;
      try { text = await readFile(join(root, path), 'utf8'); } catch { return 'Error: no such note.'; }
      read.add(path);
      return filter.mask(text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n\n[Truncated: the note has ${text.length} characters.]` : text);
    }
    if (call.name === 'list_notes') {
      const folder = typeof call.input.folder === 'string' ? call.input.folder.trim().replace(/^\/+|\/+$/g, '') : '';
      const prefix = folder ? `${folder}/` : '';
      const entries = new Set<string>();
      for (const path of await notes(root)) {
        if (!path.startsWith(prefix) || filter.excluded(path)) continue;
        const rest = path.slice(prefix.length);
        entries.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
      }
      return entries.size ? [...entries].sort().join('\n') : 'Empty or no such folder.';
    }
    return `Error: unknown tool ${call.name}.`;
  }

  const loadMessages = (conversationId: string) => (db.prepare('SELECT role, parts, native FROM tabularius_messages WHERE conversation_id=? ORDER BY id').all(conversationId) as { role: Message['role']; parts: string; native: string | null }[])
    .map(m => ({ role: m.role, parts: JSON.parse(m.parts), ...(m.native ? { native: JSON.parse(m.native) } : {}) }) as Message);
  function append(conversationId: string, message: Message) {
    db.prepare('INSERT INTO tabularius_messages(conversation_id, role, parts, native, created_at) VALUES(?,?,?,?,?)')
      .run(conversationId, message.role, JSON.stringify(message.parts), message.native ? JSON.stringify(message.native) : null, Date.now());
    db.prepare('UPDATE tabularius_conversations SET updated_at=? WHERE id=?').run(Date.now(), conversationId);
  }
  async function systemFor(vaultId: string, filter: Filter) {
    if (filter.excluded('Tabularius.md')) return BUILT_IN;
    try { return BUILT_IN + VAULT_RULES(filter.mask(await readFile(join(clients.working(vaultId), 'Tabularius.md'), 'utf8'))); }
    catch { return BUILT_IN; }
  }

  /** Runs one user message through the model and its tool calls, streaming server-sent events. */
  async function converse(res: ServerResponse, conversation: Conversation, text: string) {
    const current = row(conversation.vault_id)!;
    const filter = filterOf(current);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    send('conversation', { id: conversation.id, title: conversation.title });
    append(conversation.id, { role: 'user', parts: [{ type: 'text', text }] });
    const read = new Set<string>();
    try {
      for (let round = 0; ; round++) {
        const turn = await config.provider.turn(conversation.system, TOOLS, loadMessages(conversation.id), delta => send('text', { text: delta }));
        append(conversation.id, { role: 'assistant', ...turn });
        const calls = turn.parts.filter((part): part is Extract<Part, { type: 'tool_call' }> => part.type === 'tool_call');
        if (!calls.length) break;
        for (const call of calls) send('tool', { name: call.name, input: call.input });
        const results: Part[] = round >= MAX_TOOL_ROUNDS
          ? calls.map(call => ({ type: 'tool_result', id: call.id, content: 'Tool limit reached for this answer. Answer with what you have found.' }))
          : await Promise.all(calls.map(async call => ({ type: 'tool_result' as const, id: call.id,
            content: await runTool(conversation.vault_id, filter, call, read).catch((error: Error) => `Error: ${error.message.slice(0, 300)}`) })));
        append(conversation.id, { role: 'user', parts: results });
        // A closed page stops the answer after the current round; the transcript stays complete.
        if (round > MAX_TOOL_ROUNDS || res.destroyed) break;
      }
      send('done', { read: [...read] });
    } catch (error) {
      send('error', { message: error instanceof ProviderError ? error.message : 'Tabularius failed' });
      if (!(error instanceof ProviderError)) console.error('Tabularius conversation failed:', (error as Error).message);
    }
    res.end();
  }

  function conversationFor(id: string, user: User) {
    const conversation = db.prepare('SELECT * FROM tabularius_conversations WHERE id=? AND user_id=?').get(id, user.id) as unknown as Conversation | undefined;
    if (!conversation) fail(404, 'Conversation not found');
    return conversation!;
  }
  /** The visible transcript: user questions, assistant text, and the tools used in between. */
  function transcript(conversationId: string) {
    return loadMessages(conversationId).flatMap(message => {
      if (message.role === 'user') {
        const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
        return text ? [{ role: 'user', text }] : [];
      }
      return [{ role: 'assistant', text: message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join(''),
        tools: message.parts.flatMap(part => part.type === 'tool_call' ? [{ name: part.name, input: part.input }] : []) }];
    });
  }

  return {
    provider: config.provider,
    embeddings: Boolean(config.embedder),
    async start(url: string) {
      syncUrl = url;
      renew();
      for (const r of db.prepare('SELECT * FROM tabularius_vaults').all() as unknown as Row[]) await clients.start(hosted(r));
    },
    async close() {
      clearInterval(timer);
      for (const { vault_id } of db.prepare('SELECT vault_id FROM tabularius_vaults').all() as { vault_id: string }[]) await clients.stop(vault_id);
      await Promise.all(indexing.values());
    },
    status, enable, disable, reindex,
    rules(vaultId: string, excluded: string, masks: string) {
      if (!row(vaultId)) fail(404, 'Tabularius is not enabled for this vault');
      try { checkMasks(masks); } catch { fail(400, 'Invalid mask pattern'); }
      db.prepare('UPDATE tabularius_vaults SET excluded=?, masks=? WHERE vault_id=?').run(excluded, masks, vaultId);
      // Newly excluded notes leave the index at once; the next update indexes notes no longer excluded.
      const filter = createFilter(excluded, masks);
      for (const { path } of db.prepare('SELECT path FROM tabularius_files WHERE vault_id=?').all(vaultId) as { path: string }[]) {
        if (!filter.excluded(path)) continue;
        db.prepare('DELETE FROM tabularius_chunks WHERE vault_id=? AND path=?').run(vaultId, path);
        db.prepare('DELETE FROM tabularius_files WHERE vault_id=? AND path=?').run(vaultId, path);
      }
      void reindex(vaultId);
    },
    conversations(vaultId: string, user: User) {
      return db.prepare('SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM tabularius_conversations WHERE vault_id=? AND user_id=? ORDER BY updated_at DESC').all(vaultId, user.id);
    },
    conversation(id: string, user: User) {
      const conversation = conversationFor(id, user);
      return { id, vaultId: conversation.vault_id, title: conversation.title, messages: transcript(id) };
    },
    async start_conversation(res: ServerResponse, vaultId: string, user: User, text: string) {
      const current = row(vaultId);
      if (!current) fail(404, 'Tabularius is not enabled for this vault');
      const conversation: Conversation = { id: randomUUID(), user_id: user.id, vault_id: vaultId, title: text.replace(/\s+/g, ' ').trim().slice(0, 60),
        system: await systemFor(vaultId, filterOf(current!)), created_at: Date.now(), updated_at: Date.now() };
      db.prepare('INSERT INTO tabularius_conversations VALUES(?,?,?,?,?,?,?)').run(conversation.id, user.id, vaultId, conversation.title, conversation.system, conversation.created_at, conversation.updated_at);
      await converse(res, conversation, text);
    },
    async continue_conversation(res: ServerResponse, id: string, user: User, text: string) {
      const conversation = conversationFor(id, user);
      if (!row(conversation.vault_id)) fail(404, 'Tabularius is not enabled for this vault');
      await converse(res, conversation, text);
    },
    remove_conversation(id: string, user: User) {
      conversationFor(id, user);
      db.prepare('DELETE FROM tabularius_conversations WHERE id=?').run(id);
    },
  };
}
export type Tabularius = ReturnType<typeof createTabularius>;
