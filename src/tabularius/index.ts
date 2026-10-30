import { randomUUID } from 'node:crypto';
import { structuredPatch } from 'diff';
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
import { apply, build, ProposalError, type Change } from './proposals.js';
import { forget, notes, search, update, type Embedder } from './search.js';

export interface TabulariusConfig { key: Buffer; root: string; cli: string; provider: Provider; embedder?: Embedder }
interface Row { vault_id: string; device_id: string; device_secret: Uint8Array; passphrase: Uint8Array; tweaks: string; enabled_at: number; excluded: string; masks: string }
interface Proposal { id: string; conversation_id: string; call_id: string; vault_id: string; user_id: string; title: string; summary: string; status: 'pending' | 'applied' | 'discarded'; error: string | null; created_at: number; decided_at: number | null }
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
  { name: 'propose_changes', description: 'Proposes one batch of changes to the vault for the user to review. Nothing changes until the user applies the proposal. ' +
    'Ops: create a new note (path, content); edit a note (path, edits: replace each old text, copied exactly from the note as read_note returned it and occurring once, with new text; keep [REDACTED] where the value must stay); ' +
    'move or rename a file or folder (from, to); delete a file or folder (path). Each path may appear in one change only. Links to moved files are repaired automatically. ' +
    'If the result reports errors, nothing was saved: fix them and propose again.',
    parameters: { type: 'object', properties: {
      title: { type: 'string', description: 'Short title of the proposal, in the user\'s language' },
      summary: { type: 'string', description: 'What the proposal changes and why, in a few sentences' },
      changes: { type: 'array', items: { type: 'object', properties: {
        op: { type: 'string', enum: ['create', 'edit', 'move', 'delete'] },
        path: { type: 'string', description: 'create, edit, delete: vault path' },
        content: { type: 'string', description: 'create: the full note' },
        edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] }, description: 'edit: replacements applied in order' },
        from: { type: 'string', description: 'move: current path' },
        to: { type: 'string', description: 'move: new path' },
      }, required: ['op'] } },
    }, required: ['title', 'summary', 'changes'] } },
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
  async function runTool(conversation: Conversation, filter: Filter, call: Extract<Part, { type: 'tool_call' }>, read: Set<string>,
    send: (event: string, data: unknown) => void): Promise<string> {
    const vaultId = conversation.vault_id;
    const root = clients.working(vaultId);
    if (call.name === 'propose_changes') {
      let built;
      try { built = await build(root, filter, call.input); } catch (error) {
        if (error instanceof ProposalError) return `Error: the proposal was not saved.\n${error.message}`;
        throw error;
      }
      const id = randomUUID();
      db.exec('BEGIN');
      db.prepare('INSERT INTO tabularius_proposals(id,conversation_id,call_id,vault_id,user_id,title,summary,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, conversation.id, call.id, vaultId, conversation.user_id, built.title, built.summary, 'pending', Date.now());
      const insert = db.prepare('INSERT INTO tabularius_changes VALUES(?,?,?,?,?,?,?,?,?)');
      built.changes.forEach((c, i) => insert.run(id, i, c.op, c.path, c.to, c.hash, c.before, c.after, Number(c.automatic)));
      db.exec('COMMIT');
      send('proposal', { id, title: built.title, status: 'pending', files: built.changes.length });
      const own = built.changes.filter(c => !c.automatic).map(c => `${c.op} ${c.path}${c.to ? ` -> ${c.to}` : ''}`);
      return `Proposal saved for review: ${built.title}\n${own.join('\n')}` +
        (built.repaired ? `\nLinks to moved files are also updated in ${built.repaired} other note(s).` : '') +
        '\nIt takes effect only when the user applies it.';
    }
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
        for (const call of calls) send('tool', { name: call.name, input: call.name === 'propose_changes' ? {} : call.input });
        const results: Part[] = round >= MAX_TOOL_ROUNDS
          ? calls.map(call => ({ type: 'tool_result', id: call.id, content: 'Tool limit reached for this answer. Answer with what you have found.' }))
          : await Promise.all(calls.map(async call => ({ type: 'tool_result' as const, id: call.id,
            content: await runTool(conversation, filter, call, read, send).catch((error: Error) => `Error: ${error.message.slice(0, 300)}`) })));
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
  /** The visible transcript: user questions, assistant text, and the tools used in between, with proposals by tool call. */
  function transcript(conversationId: string) {
    const proposals = new Map((db.prepare('SELECT call_id, id, title, status FROM tabularius_proposals WHERE conversation_id=?').all(conversationId) as { call_id: string; id: string; title: string; status: string }[])
      .map(p => [p.call_id, { id: p.id, title: p.title, status: p.status }]));
    return loadMessages(conversationId).flatMap(message => {
      if (message.role === 'user') {
        const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
        return text ? [{ role: 'user', text }] : [];
      }
      return [{ role: 'assistant', text: message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join(''),
        tools: message.parts.flatMap(part => part.type === 'tool_call'
          ? [{ name: part.name, input: part.name === 'propose_changes' ? {} : part.input, ...(proposals.has(part.id) ? { proposal: proposals.get(part.id) } : {}) }] : []) }];
    });
  }

  function proposalFor(id: string, user: User) {
    const proposal = db.prepare('SELECT * FROM tabularius_proposals WHERE id=? AND user_id=?').get(id, user.id) as unknown as Proposal | undefined;
    if (!proposal) fail(404, 'Proposal not found');
    return proposal!;
  }
  const changesOf = (id: string) => (db.prepare('SELECT op, path, to_path AS "to", hash, before, after, automatic FROM tabularius_changes WHERE proposal_id=? ORDER BY seq').all(id) as unknown as (Omit<Change, 'automatic'> & { automatic: number })[])
    .map(c => ({ ...c, automatic: Boolean(c.automatic) }));
  const summaryOf = (p: Proposal) => ({ id: p.id, conversationId: p.conversation_id, title: p.title, summary: p.summary, status: p.status, error: p.error, createdAt: p.created_at, decidedAt: p.decided_at });

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
    proposals(vaultId: string, user: User) {
      return (db.prepare('SELECT * FROM tabularius_proposals WHERE vault_id=? AND user_id=? ORDER BY created_at DESC').all(vaultId, user.id) as unknown as Proposal[]).map(summaryOf);
    },
    /** A proposal with a unified diff per file; the user sees the notes as they are, without masking. */
    proposal(id: string, user: User) {
      const proposal = proposalFor(id, user);
      return { ...summaryOf(proposal), vaultId: proposal.vault_id, files: changesOf(id).map(c => ({
        op: c.op, path: c.path, to: c.to, automatic: c.automatic, binary: c.before === null && c.op !== 'create',
        hunks: c.after === null && c.op === 'move' || c.before === null && c.op !== 'create' ? []
          : structuredPatch(c.path, c.to ?? c.path, c.before ?? '', c.after ?? '', '', '', { context: 3 }).hunks,
      })) };
    },
    /** Writes a pending proposal into the working copy; the hosted client then syncs it like any local edit. */
    async apply(id: string, user: User) {
      const proposal = proposalFor(id, user);
      if (proposal.status !== 'pending') fail(409, 'Proposal is not pending');
      if (!row(proposal.vault_id)) fail(404, 'Tabularius is not enabled for this vault');
      const client = clients.state(proposal.vault_id);
      if (!client?.running || !client.replicated) fail(409, 'The hosted client is not in sync');
      try { await apply(clients.working(proposal.vault_id), changesOf(id)); } catch (error) {
        db.prepare('UPDATE tabularius_proposals SET error=? WHERE id=?').run((error as Error).message.slice(0, 2000), id);
        if (!(error instanceof ProposalError)) throw error;
        fail(409, 'Proposal cannot be applied');
      }
      db.prepare("UPDATE tabularius_proposals SET status='applied', error=NULL, decided_at=? WHERE id=?").run(Date.now(), id);
      void reindex(proposal.vault_id);
      return summaryOf(proposalFor(id, user));
    },
    discard(id: string, user: User) {
      const proposal = proposalFor(id, user);
      if (proposal.status !== 'pending') fail(409, 'Proposal is not pending');
      db.prepare("UPDATE tabularius_proposals SET status='discarded', decided_at=? WHERE id=?").run(Date.now(), id);
      return summaryOf(proposalFor(id, user));
    },
    remove_conversation(id: string, user: User) {
      conversationFor(id, user);
      db.prepare('DELETE FROM tabularius_conversations WHERE id=?').run(id);
    },
  };
}
export type Tabularius = ReturnType<typeof createTabularius>;
