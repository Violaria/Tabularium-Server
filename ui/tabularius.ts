// Tabularius: enable the AI curator for a vault, set what it may send, and talk to it about the notes.
import { formatDate, hasMessage, serverError, t } from './i18n.js';
import { api, ApiError, bytes, confirmAction, escape, message, notesStyles, run, state, tip } from './core.js';
import { FormError, paramForm, paramLabel, PROVIDER_NAMES, type Params, type ProviderName, type Rule } from './params.js';
interface VaultStatus {
  id: string; name: string; enabled: boolean; enabledAt?: number; excluded?: string; masks?: string; running?: boolean; replicated?: boolean;
  deviceRevoked?: boolean; knowledge?: boolean; web?: boolean; mode?: Mode; prompt?: string; recipe?: string | null; indexError?: string | null; notes?: number; chunks?: number; log?: string[];
}
type Mode = 'read-only' | 'restricted' | 'full';
/** A recipe: a model with parameters and a prompt, set up by an administrator. */
interface RecipeView { id: string; name: string; model: string; modelName: string; vision: boolean; provider: ProviderName; params: Params; prompt: string }
interface Overview { recipes: RecipeView[]; defaultRecipe: string; rules: Record<ProviderName, Record<string, Rule>>;
  embeddings: boolean; knowledge: boolean; web: boolean; admin: boolean; modes: Mode[]; vaults: VaultStatus[]; attachmentMegabytes: number }
/** The open conversation's recipe, extra prompt, adjusted parameters and web search, or what a new conversation will start with. */
interface ChatSettings { recipe: string; prompt: string; params: Partial<Record<ProviderName, Params>>; web: boolean }
/** A file sent with a message. */
interface AttachmentRef { id: string; name: string; kind: 'image' | 'text' }
/** A file in the box, before sending: uploading (no id yet), ready, or refused with the reason. */
interface Pending { key: number; name: string; size: number; image: boolean; preview?: string; id?: string; kind?: 'image' | 'text'; error?: string }
interface Summary { id: string; title: string; updatedAt: number }
interface ProposalRef { id: string; title: string; status: string; files?: number }
interface ToolUse { name: string; input: Record<string, unknown>; proposal?: ProposalRef }
interface ProposalSummary { id: string; conversationId: string; title: string; summary: string; status: string; error: string | null; createdAt: number; decidedAt: number | null }
interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
interface ProposalFile { op: 'create' | 'edit' | 'move' | 'delete'; path: string; to: string | null; automatic: boolean; binary: boolean; hunks: Hunk[] }
interface ProposalDetail extends ProposalSummary { vaultId: string; files: ProposalFile[] }
interface Source { url: string; title: string }
interface Approval { id: string; host: string; command: string; approved?: boolean }
interface Entry { role: 'user' | 'assistant'; text: string; attachments?: AttachmentRef[]; tools?: ToolUse[]; read?: string[]; sources?: Source[]; approvals?: Approval[]; error?: string }
interface Host { id: string; name: string; address: string; port: number; username: string; policy: 'allowed' | 'authorize' | 'forbidden'; commands: string; fingerprint: string | null; publicKey: string }
interface CommandRecord { id: string; host: string | null; user: string | null; command: string; mode: string; status: string; exitCode: number | null; reason: string | null; createdAt: number }

/** The content area of the shell this module draws into. */
let app: HTMLElement;
let overview: Overview | undefined;
let vaultId = new URLSearchParams(location.search).get('vault') ?? '';
let view: 'chat' | 'settings' | 'proposals' | 'proposal' | 'memories' = 'chat';
interface MemoryItem { id: string; content: string; createdAt: number; updatedAt: number }
let memories: MemoryItem[] = [];
let proposals: ProposalSummary[] = [];
let proposal: ProposalDetail | undefined;
let conversations: Summary[] = [];
let conversationId: string | undefined;
let entries: Entry[] = [];
let busy = false;
let chat: ChatSettings = { recipe: '', prompt: '', params: {}, web: false };
let pending: Pending[] = [];
let pendingKey = 0;
const recipeOf = (id: string | null | undefined) => overview!.recipes.find(recipe => recipe.id === id);
/** A new conversation starts with the vault's default recipe, else the server's. */
function newChat() {
  chat = { recipe: recipeOf(vault()?.recipe)?.id ?? overview!.defaultRecipe, prompt: '', params: {}, web: false };
}
/** Recipes as select options with their model's name; `empty` adds a first option with the value ''. */
const recipeOptions = (selected: string, empty?: string) => (empty === undefined ? '' : `<option value="" ${selected ? '' : 'selected'}>${escape(empty)}</option>`)
  + overview!.recipes.map(recipe => `<option value="${escape(recipe.id)}" ${recipe.id === selected ? 'selected' : ''}>${escape(recipe.name)}</option>`).join('');

const vault = () => overview?.vaults.find(v => v.id === vaultId);

function form(id: string, action: (data: FormData) => Promise<void>) {
  document.querySelector<HTMLFormElement>(`#${id}`)?.addEventListener('submit', event => {
    event.preventDefault();
    const target = event.currentTarget as HTMLFormElement;
    const submit = target.querySelector<HTMLButtonElement>('button[type=submit]')!; submit.disabled = true;
    void run(() => action(new FormData(target))).finally(() => { submit.disabled = false; });
  });
}

/** The renderer web notes uses, built with it (answer-markdown.js), so answers read like notes. */
interface AnswerModule {
  renderAnswer(text: string, cite: (path: string) => string, copy: string): string;
  renderDiagrams(root: ParentNode): Promise<void>;
  copyCode(event: MouseEvent, copied: string): boolean;
}
let answers: AnswerModule;
/** Answer text as markdown; [[note]] citations link to the note in web notes. */
const render = (text: string) =>
  answers.renderAnswer(text, path => `/notes/?vault=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}`, t('notes.copyCode'));
function toolLabel(tool: ToolUse) {
  const value = (key: string) => escape(String(tool.input[key] ?? ''));
  if (tool.name === 'search_notes') return t('tabularius.toolSearch', { query: value('query') });
  if (tool.name === 'read_note') return t('tabularius.toolRead', { path: value('path') });
  if (tool.name === 'list_notes') return t('tabularius.toolList', { folder: value('folder') || '/' });
  if (tool.name === 'search_knowledge_base') return t('tabularius.toolKnowledge', { query: value('question') });
  if (tool.name === 'list_hosts') return t('tabularius.toolHosts');
  if (tool.name === 'run_command') return t('tabularius.toolCommand', { host: value('host'), command: value('command') });
  if (tool.name === 'run_sandbox') return t('tabularius.toolSandbox', { image: value('image'), command: value('command') });
  if (tool.name === 'search_memories') return t('tabularius.toolMemorySearch', { query: value('query') });
  if (tool.name === 'add_memory' || tool.name === 'update_memory') return t('tabularius.toolMemoryWrite', { content: value('content') });
  if (tool.name === 'delete_memory') return t('tabularius.toolMemoryDelete');
  if (tool.name === 'search_conversations') return t('tabularius.toolConversations', { query: value('query') });
  if (tool.name === 'read_conversation') return t('tabularius.toolConversation');
  if (tool.name === 'web_search') return t('tabularius.toolWebSearch', { query: value('query') });
  if (tool.name === 'web_fetch' || tool.name === 'fetch_url') return t('tabularius.toolWebFetch', { url: value('url') });
  if (tool.name === 'propose_changes') return tool.proposal
    ? `<button class="proposal-link" data-proposal="${escape(tool.proposal.id)}">${t('tabularius.toolPropose', { title: escape(tool.proposal.title) })}</button> ${statusBadge(tool.proposal.status)}`
    : t('tabularius.toolProposeFailed');
  return escape(tool.name);
}
/** A status or problem name from the server: its text when the catalogue has one, else the name as sent. */
const named = (key: string, value: string) => hasMessage(key) ? t(key as 'tabularius.status.pending') : escape(value);
const statusBadge = (status: string) => `<span class="badge${status === 'pending' ? ' warn' : status === 'discarded' ? ' off' : ''}">${named(`tabularius.status.${status}`, status)}</span>`;
/** Approvals already answered in this page: a redraw of the streaming answer keeps their buttons off. */
const answered = new Set<string>();
function entryHtml(entry: Entry) {
  if (entry.role === 'user') return `<div class="turn user">${entry.attachments?.length ? `<div class="sent-attachments">${entry.attachments.map(sentAttachment).join('')}</div>` : ''}${entry.text ? `<p>${escape(entry.text).replace(/\n/g, '<br>')}</p>` : ''}</div>`;
  const tools = (entry.tools ?? []).map(tool => `<li>${toolLabel(tool)}</li>`).join('');
  const read = entry.read?.length ? `<div class="read"><small>${t('tabularius.readNotes')}</small>${render(entry.read.map(path => `[[${path}]]`).join('  '))}</div>` : '';
  const web = (entry.sources ?? []).filter(source => /^https?:/.test(source.url));
  const sources = web.length ? `<div class="read"><small>${t('tabularius.sources')}</small><ol class="sources">${web.map(source =>
    `<li><a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${escape(source.title || source.url)}</a></li>`).join('')}</ol></div>` : '';
  const approvals = (entry.approvals ?? []).map(a => `<div class="notice approval"><p>${t('tabularius.approvalAsk', { host: escape(a.host) })}</p><pre class="mono">${escape(a.command)}</pre>
    ${a.approved === undefined ? `<div class="actions"><button class="primary" data-approve="${escape(a.id)}" ${answered.has(a.id) ? 'disabled' : ''}>${t('tabularius.approve')}</button><button data-deny="${escape(a.id)}" ${answered.has(a.id) ? 'disabled' : ''}>${t('tabularius.deny')}</button></div>`
      : `<span class="badge${a.approved ? '' : ' warn'}">${a.approved ? t('tabularius.approved') : t('tabularius.denied')}</span>`}</div>`).join('');
  return `<div class="turn assistant">${tools ? `<ul class="tools">${tools}</ul>` : ''}${approvals}<div class="answer md-body">${render(entry.text)}</div>${entry.error ? `<p class="notice error">${escape(entry.error)}</p>` : ''}${read}${sources}</div>`;
}

async function load() {
  overview = await api<Overview>('/tabularius');
  if (!overview.vaults.some(v => v.id === vaultId)) vaultId = overview.vaults.find(v => v.enabled)?.id ?? overview.vaults[0]?.id ?? '';
  await openVault();
}
async function openVault() {
  conversationId = undefined; entries = []; newChat();
  conversations = vault()?.enabled ? await api<Summary[]>(`/tabularius/vaults/${encodeURIComponent(vaultId)}/conversations`) : [];
  draw();
}
async function refresh() {
  overview = await api<Overview>('/tabularius');
  draw();
}

let drawnView = '';
function shell(content: string) {
  // A redraw of the same view (after saving a setting) keeps where the page was scrolled to.
  const key = `${view}|${vaultId}|${conversationId ?? ''}`;
  const kept = key === drawnView ? { main: app.querySelector('.assist-main')?.scrollTop ?? 0, list: app.querySelector('.pane-list')?.scrollTop ?? 0, page: window.scrollY } : undefined;
  drawnView = key;
  const current = vault();
  const options = overview!.vaults.map(v => `<option value="${escape(v.id)}" ${v.id === vaultId ? 'selected' : ''}>${v.enabled ? escape(v.name) : t('tabularius.vaultOff', { name: escape(v.name) })}</option>`).join('');
  const list = conversations.map(c => `<button class="conversation" data-id="${escape(c.id)}" ${c.id === conversationId && view === 'chat' ? 'aria-current="page"' : ''}><span>${escape(c.title)}</span><small>${formatDate(c.updatedAt)}</small></button>`).join('');
  app.innerHTML = `<div class="pane assist"><aside><div class="pane-head">${overview!.vaults.length ? `<select id="vault" aria-label="${t('tabularius.vault')}">${options}</select>` : ''}${current?.enabled ? `<button id="new" class="primary">${t('tabularius.newChat')}</button>` : ''}</div>
    ${current?.enabled ? `<nav class="pane-list" aria-label="${t('tabularius.conversations')}">${list || `<small class="pane-empty">${t('tabularius.noConversations')}</small>`}</nav><nav class="pane-foot"><button id="proposals" ${view.startsWith('proposal') ? 'aria-current="page"' : ''}>${t('tabularius.proposals')}</button><button id="memories" ${view === 'memories' ? 'aria-current="page"' : ''}>${t('tabularius.memories')}</button><button id="settings" ${view === 'settings' ? 'aria-current="page"' : ''}>${t('tabularius.settings')}</button></nav>` : ''}</aside>
    <section class="assist-main">${content}</section></div>`;
  if (kept) {
    app.querySelector('.assist-main')!.scrollTop = kept.main;
    const list = app.querySelector('.pane-list');
    if (list) list.scrollTop = kept.list;
    window.scrollTo(0, kept.page);
  }
  document.getElementById('vault')?.addEventListener('change', event => { vaultId = (event.target as HTMLSelectElement).value; view = 'chat'; void run(openVault); });
  document.getElementById('new')?.addEventListener('click', () => { view = 'chat'; conversationId = undefined; entries = []; newChat(); draw(); });
  document.getElementById('settings')?.addEventListener('click', () => { view = 'settings'; void run(async () => { await loadHosts(); await refresh(); }); });
  document.getElementById('proposals')?.addEventListener('click', () => void run(showProposals));
  document.getElementById('memories')?.addEventListener('click', () => void run(showMemories));
  for (const item of app.querySelectorAll<HTMLButtonElement>('[data-proposal]')) item.addEventListener('click', () => void run(() => showProposal(item.dataset.proposal!)));
  for (const item of app.querySelectorAll<HTMLButtonElement>('.conversation')) item.addEventListener('click', () => void run(() => openConversation(item.dataset.id!)));
}
async function openConversation(id: string) {
  const loaded = await api<{ id: string; messages: Entry[] } & ChatSettings>(`/tabularius/conversations/${encodeURIComponent(id)}`);
  view = 'chat'; conversationId = loaded.id; entries = loaded.messages; chat = { recipe: loaded.recipe, prompt: loaded.prompt, params: loaded.params ?? {}, web: loaded.web }; draw();
}
/** Saves the conversation's settings, or keeps them for the first message of a new conversation. */
async function saveChat(next: Partial<ChatSettings>) {
  const before = recipeOf(chat.recipe);
  chat = { ...chat, ...next };
  if (conversationId) {
    const saved = await api<ChatSettings>(`/tabularius/conversations/${encodeURIComponent(conversationId)}`, 'PATCH', next);
    chat = { recipe: saved.recipe, prompt: saved.prompt, params: saved.params ?? {}, web: saved.web };
  }
  // Adjustments made for another provider do not travel with a switch of recipe.
  const after = recipeOf(chat.recipe);
  if (next.recipe && before && after && before.provider !== after.provider) {
    const left = Object.keys(chat.params[before.provider] ?? {});
    if (left.length) message(t('tabularius.paramsNotApplied', { names: left.map(paramLabel).join(', '), model: after.modelName }));
  }
}
/** The conversation settings dialog: an extra prompt, and adjustments to the recipe's parameters for this conversation. */
/** Web search can be switched on for a conversation when the server has web access and the vault allows it. */
const webAllowed = () => Boolean(overview?.web && vault()?.web);

const ATTACH_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.8h5.2l3 3v9c0 .4-.3.7-.7.7H4c-.4 0-.7-.3-.7-.7V2.5c0-.4.3-.7.7-.7z"/><path d="M9 1.8v3.2h3.2"/></svg>';
const MAX_FILES = 10;
/** Pictures go to the model at up to this many pixels on their long side. */
const LONG_SIDE = 1568;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** An image no larger than LONG_SIDE: kept when it already fits, else redrawn (PNG stays PNG, others become JPEG). */
async function shrink(file: File): Promise<{ blob: Blob; name: string }> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(t('tabularius.imageUnreadable')); }
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && IMAGE_TYPES.includes(file.type)) { bitmap.close(); return { blob: file, name: file.name }; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = file.type === 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error(t('tabularius.imageUnreadable'))), png ? 'image/png' : 'image/jpeg', 0.85));
  return { blob, name: png ? file.name : file.name.replace(/\.[^.]*$/, '') + '.jpg' };
}
/** Uploads one file for the next message; the card shows its progress, and the reason when it is refused. */
async function upload(item: Pending, file: File) {
  try {
    let blob: Blob = file;
    if (item.image) {
      if (!recipeOf(chat.recipe)?.vision) throw new Error(t('tabularius.noVision'));
      const shrunk = await shrink(file);
      blob = shrunk.blob; item.name = shrunk.name; item.size = blob.size; item.preview = URL.createObjectURL(blob);
      drawPending();
    }
    if (blob.size > overview!.attachmentMegabytes * 1048576) throw new Error(t('tabularius.attachmentTooLarge', { size: overview!.attachmentMegabytes }));
    const response = await fetch(`/api/v1/tabularius/vaults/${encodeURIComponent(vaultId)}/attachments`, {
      method: 'POST', credentials: 'same-origin', body: blob,
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(item.name), 'x-csrf-token': state.session!.csrf },
    });
    const data = await response.json() as { id?: string; kind?: 'image' | 'text'; error?: string };
    if (!response.ok) throw new Error(response.status === 413 ? t('tabularius.attachmentTooLarge', { size: overview!.attachmentMegabytes }) : serverError(data.error ?? ''));
    item.id = data.id; item.kind = data.kind;
  } catch (error) {
    item.error = error instanceof Error ? error.message : String(error);
  }
  drawPending();
}
function addFiles(files: File[]) {
  for (const file of files) {
    if (pending.length >= MAX_FILES) { message(t('tabularius.tooManyAttachments', { count: MAX_FILES }), true); break; }
    const item: Pending = { key: ++pendingKey, name: file.name || 'image.png', size: file.size, image: file.type.startsWith('image/') };
    pending.push(item);
    void upload(item, file);
  }
  drawPending();
}
function dropPending(key: number) {
  const item = pending.find(entry => entry.key === key);
  if (item?.preview) URL.revokeObjectURL(item.preview);
  pending = pending.filter(entry => entry.key !== key);
  drawPending();
}
const pendingHtml = () => pending.map(item => `<div class="attachment${item.error ? ' failed' : item.id ? '' : ' loading'}" title="${escape(item.error ?? item.name)}">
  ${item.preview ? `<img src="${item.preview}" alt="">` : `<span class="attachment-icon">${FILE_ICON}</span>`}<span class="attachment-text"><span class="attachment-name">${escape(item.name)}</span>
  <small>${item.error ? escape(item.error) : item.id ? bytes(item.size) : t('tabularius.uploading')}</small></span>
  <button type="button" class="attachment-remove" data-remove="${item.key}" aria-label="${t('tabularius.removeAttachment')}" title="${t('tabularius.removeAttachment')}">×</button></div>`).join('');
/** Redraws only the cards, so typing in the box is not disturbed while files upload. */
function drawPending() {
  const box = document.getElementById('attachments');
  if (box) box.innerHTML = pendingHtml();
}
/** A sent file on its message: images as pictures, other files by name; both open from the server. */
const sentAttachment = (item: AttachmentRef) => {
  const href = `/api/v1/tabularius/attachments/${encodeURIComponent(item.id)}`;
  return item.kind === 'image'
    ? `<a class="sent-image" href="${href}" target="_blank" rel="noopener" title="${escape(item.name)}"><img src="${href}" alt="${escape(item.name)}" loading="lazy"></a>`
    : `<a class="attachment" href="${href}" target="_blank" rel="noopener"><span class="attachment-icon">${FILE_ICON}</span><span class="attachment-text"><span class="attachment-name">${escape(item.name)}</span></span></a>`;
};

function chatSettings() {
  const recipe = recipeOf(chat.recipe);
  const provider = recipe?.provider;
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog chat-settings';
  dialog.innerHTML = `<form method="dialog" class="stack"><h2>${t('tabularius.chatSettings')}</h2>
    ${webAllowed() ? `<label class="check"><input type="checkbox" name="web" ${chat.web ? 'checked' : ''}> ${t('tabularius.webSearch')}${tip(t('tabularius.webSearchHint'))}</label>` : ''}
    <label><span>${t('tabularius.chatPrompt')}${tip(t('tabularius.chatPromptHint'))}</span><textarea name="prompt" rows="4">${escape(chat.prompt)}</textarea></label>
    <h3>${t('tabularius.paramsFor', { recipe: escape(recipe?.name ?? ''), model: escape(recipe?.modelName ?? '') })}${tip(t('tabularius.paramsForHint'))}</h3><div class="chat-params"></div>
    <div class="buttons"><button type="button" data-cancel>${t('dialog.cancel')}</button><button type="submit" class="primary">${t('common.save')}</button></div></form>`;
  document.body.append(dialog);
  const read = provider ? paramForm(dialog.querySelector<HTMLElement>('.chat-params')!, provider, overview!.rules[provider], recipe!.params, chat.params[provider] ?? {}) : () => ({});
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.addEventListener('cancel', close);
  dialog.querySelector('[data-cancel]')!.addEventListener('click', close);
  dialog.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault();
    let params: Params;
    try { params = read(); } catch (error) { if (error instanceof FormError) { message(error.message, true); return; } throw error; }
    void run(async () => {
      const form = new FormData(dialog.querySelector('form')!);
      await saveChat({ prompt: String(form.get('prompt')), params: { ...chat.params, ...(provider ? { [provider]: params } : {}) }, ...(webAllowed() ? { web: form.get('web') === 'on' } : {}) });
      close(); draw(); message(t('tabularius.saved'));
    });
  });
  dialog.showModal();
}

function draw() {
  document.title = `Tabularius · ${vault()?.name ?? 'Tabularium'}`;
  const current = vault();
  if (!current) { shell(`<div class="card empty">${t('tabularius.noVaults')}</div>`); return; }
  if (!current.enabled) { drawEnable(current); return; }
  if (view === 'settings') { drawSettings(current); return; }
  if (view === 'proposals') { drawProposals(); return; }
  if (view === 'memories') { drawMemories(); return; }
  if (view === 'proposal' && proposal) { drawProposal(proposal); return; }
  drawChat(current);
}

const rulesFields = (excluded: string, masks: string) => `
  <label><span>${t('tabularius.excluded')}${tip(t('tabularius.excludedHint'))}</span><textarea name="excluded" rows="4" spellcheck="false">${escape(excluded)}</textarea></label>
  <label><span>${t('tabularius.masks')}${tip(t('tabularius.masksHint'))}</span><textarea name="masks" rows="3" spellcheck="false">${escape(masks)}</textarea></label>`;

function drawEnable(current: VaultStatus) {
  shell(`<header class="page-head"><div><p class="eyebrow">Tabularius</p><h1>${t('tabularius.enableTitle', { name: escape(current.name) })}</h1></div></header>
    <div class="card"><p>${t('tabularius.enableWarning', { provider: escape(recipeOf(overview!.defaultRecipe)?.modelName ?? t('tabularius.noModel')) })}</p>
    <form id="enable" class="stack"><label class="check"><input type="checkbox" name="confirm" required> ${t('tabularius.enableConfirm')}</label>
    <label>${t('tabularius.passphrase')}<input name="passphrase" type="password" data-bwignore data-1p-ignore data-lpignore="true" autocomplete="off" required></label>
    ${rulesFields('', '')}
    <button class="primary" type="submit">${t('tabularius.enable')}</button></form></div>`);
  form('enable', async data => {
    message(t('tabularius.enabling'));
    await api(`/tabularius/vaults/${encodeURIComponent(vaultId)}`, 'POST', { passphrase: data.get('passphrase'), confirm: data.get('confirm') === 'on', excluded: data.get('excluded'), masks: data.get('masks') });
    await refresh(); await openVault();
  });
}

/** The hosted client's state as a small indicator: a coloured dot, the state, and what is indexed. */
function syncPill(current: VaultStatus) {
  const [kind, label] = current.deviceRevoked ? ['warn', t('tabularius.revoked')]
    : !current.running ? ['warn', t('tabularius.stopped')]
      : current.indexError ? ['warn', t('tabularius.ready')]
        : current.replicated ? ['ok', t('tabularius.ready')] : ['busy', t('tabularius.syncing')];
  const counts = t('tabularius.counts', { notes: current.notes ?? 0, chunks: current.chunks ?? 0 });
  return `<span class="sync-pill ${kind}" role="status" title="${escape(current.indexError ? t('tabularius.indexError', { error: current.indexError }) : counts)}"><span class="dot" aria-hidden="true"></span><strong>${escape(label)}</strong><span class="sep" aria-hidden="true"></span><span>${escape(counts)}</span></span>`;
}
const GEAR_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/><circle cx="10" cy="10" r="5.3"/></svg>';
const SEND_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M4.5 9.5 10 4l5.5 5.5"/></svg>';

function statusText(current: VaultStatus) {
  if (current.deviceRevoked) return `<span class="badge warn">${t('tabularius.revoked')}</span>`;
  const state = !current.running ? `<span class="badge warn">${t('tabularius.stopped')}</span>`
    : current.replicated ? `<span class="badge">${t('tabularius.ready')}</span>` : `<span class="badge off">${t('tabularius.syncing')}</span>`;
  return `${state} <small>${t('tabularius.counts', { notes: current.notes ?? 0, chunks: current.chunks ?? 0 })}</small>${current.indexError ? `<p class="notice error">${t('tabularius.indexError', { error: escape(current.indexError) })}</p>` : ''}`;
}

let isAdmin = false;
let hosts: Host[] = [];
let commandLog: CommandRecord[] = [];
const policyField = (policy: Host['policy']) => `<label>${t('tabularius.hostPolicy')}<select name="policy">${(['allowed', 'authorize', 'forbidden'] as const).map(p =>
  `<option value="${p}" ${p === policy ? 'selected' : ''}>${t(`tabularius.policy.${p}`)}</option>`).join('')}</select></label>`;
function hostHtml(host: Host) {
  return `<form class="host stack" data-host="${escape(host.id)}"><h3>${escape(host.name)} <small>${escape(`${host.username}@${host.address}:${host.port}`)}</small></h3>
    <p><small>${host.fingerprint ? t('tabularius.hostFingerprint', { fingerprint: escape(host.fingerprint) }) : t('tabularius.hostUnchecked')}</small></p>
    <label>${t('tabularius.hostPublicKey')}<input readonly value="${escape(host.publicKey)}" class="mono"></label>
    ${policyField(host.policy)}<label>${t('tabularius.hostCommands')}<textarea name="commands" rows="2" spellcheck="false">${escape(host.commands)}</textarea></label>
    <div class="actions"><button type="submit">${t('common.save')}</button><button type="button" data-check>${t('tabularius.checkHost')}</button><button type="button" class="danger" data-remove>${t('tabularius.removeHost')}</button></div></form>`;
}
async function loadHosts() {
  try { [hosts, commandLog] = await Promise.all([api<Host[]>('/tabularius/hosts'), api<CommandRecord[]>('/tabularius/commands')]); isAdmin = true; }
  catch (error) { if (!(error instanceof ApiError && error.status === 403)) throw error; isAdmin = false; hosts = []; commandLog = []; }
}
function drawSettings(current: VaultStatus) {
  shell(`<header class="page-head"><div><p class="eyebrow">Tabularius</p><h1>${escape(current.name)}</h1><p>${statusText(current)}</p></div><button id="reload">${t('common.refresh')}</button></header>
    <div class="card"><h2>${t('tabularius.rules')}</h2><form id="rules" class="stack">
      ${rulesFields(current.excluded ?? '', current.masks ?? '')}
      <button class="primary" type="submit">${t('common.save')}</button></form></div>
    <div class="card"><h2>${t('tabularius.modeTitle')}${tip(t('tabularius.modeDesc'))}</h2>
      <label>${t('tabularius.mode')}<select id="mode">${(['read-only', 'restricted', 'full'] as Mode[]).map(mode =>
        `<option value="${mode}" ${current.mode === mode ? 'selected' : ''} ${overview!.modes.includes(mode) ? '' : 'disabled'}>${t(`tabularius.mode.${mode}`)}</option>`).join('')}</select></label>
      ${overview!.web ? `<label class="check"><input type="checkbox" id="web" ${current.web ? 'checked' : ''}> ${t('tabularius.webEnable')}${tip(t('tabularius.webDesc'))}</label>` : ''}</div>
    ${isAdmin ? `<div class="card" id="hosts-card"><h2>${t('tabularius.hosts')}${tip(t('tabularius.hostsDesc'))}</h2>${hosts.map(hostHtml).join('')}
      <form id="add-host" class="stack"><h3>${t('tabularius.addHost')}</h3><div class="inline-form"><label>${t('tabularius.hostName')}<input name="name" required></label><label>${t('tabularius.hostAddress')}<input name="address" required></label>
        <label>${t('tabularius.hostPort')}<input name="port" type="number" value="22" min="1" max="65535"></label><label>${t('tabularius.hostUser')}<input name="username" required></label></div>
        ${policyField('allowed')}<label><span>${t('tabularius.hostCommands')}${tip(t('tabularius.hostCommandsHint'))}</span><textarea name="commands" rows="3" spellcheck="false"></textarea></label>
        <button class="primary" type="submit">${t('tabularius.addHost')}</button></form>
      ${commandLog.length ? `<details><summary>${t('tabularius.commandLog')}</summary><table><tbody>${commandLog.slice(0, 30).map(c => `<tr><td>${formatDate(c.createdAt)}</td><td>${escape(c.host ?? '')}</td><td><code>${escape(c.command)}</code></td><td>${escape(c.status)}${c.exitCode !== null ? ` (${c.exitCode})` : ''}${c.reason ? ` · ${escape(c.reason)}` : ''}</td></tr>`).join('')}</tbody></table></details>` : ''}</div>` : ''}
    <div class="card"><h2>${t('tabularius.promptTitle')}${tip(t('tabularius.promptDesc'))}</h2><form id="vault-prompt" class="stack"><textarea name="prompt" rows="8" spellcheck="false">${escape(current.prompt ?? '')}</textarea>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button><button type="button" id="import-prompt">${t('tabularius.importPrompt')}</button></div></form>
      <details id="preview"><summary>${t('tabularius.preview')}${tip(t('tabularius.previewHint'))}</summary><div class="preview-body"></div></details></div>
    <div class="card"><div class="card-head"><h2>${t('tabularius.recipeTitle')}${tip(t('tabularius.recipeDesc'))}</h2>${overview!.admin ? `<a class="button" href="/admin/ai" data-route>${t('tabularius.manageRecipes')}</a>` : ''}</div>
      <label>${t('tabularius.vaultRecipe')}<select id="vault-recipe">${recipeOptions(recipeOf(current.recipe)?.id ?? '', t('tabularius.followServer'))}</select></label></div>
    ${overview!.knowledge ? `<div class="card"><div class="card-head"><h2>${t('tabularius.knowledge')}${tip(t('tabularius.knowledgeDesc'))}</h2><a class="button" href="/admin/ai" data-route>${t('tabularius.knowledgeSettings')}</a></div>
      <label class="check"><input type="checkbox" id="knowledge" ${current.knowledge ? 'checked' : ''}> ${t('tabularius.knowledgeEnable')}</label></div>` : ''}
    <div class="card"><h2>${t('tabularius.about')}</h2><dl class="details"><dt>${t('tabularius.recipe')}</dt><dd>${escape(((recipe) => recipe ? `${recipe.name} · ${PROVIDER_NAMES[recipe.provider]} ${recipe.modelName}` : t('tabularius.noModel'))(recipeOf(current.recipe) ?? recipeOf(overview!.defaultRecipe)))}</dd>
      <dt>${t('tabularius.embeddings')}</dt><dd>${overview!.embeddings ? t('tabularius.embeddingsOn') : t('tabularius.embeddingsOff')}</dd>
      <dt>${t('tabularius.enabledAt')}</dt><dd>${formatDate(current.enabledAt!)}</dd></dl>
      ${current.log?.length ? `<details><summary>${t('tabularius.log')}</summary><pre class="mono">${escape(current.log.join('\n'))}</pre></details>` : ''}</div>
    <div class="card"><h2>${t('tabularius.disable')}${tip(t('tabularius.disableDesc'))}</h2><button id="disable" class="danger">${t('tabularius.disable')}</button></div>`);
  document.getElementById('reload')!.addEventListener('click', () => void run(refresh));
  document.getElementById('mode')!.addEventListener('change', event => void run(async () => {
    const select = event.target as HTMLSelectElement;
    if (select.value === 'full' && !await confirmAction({ title: t('tabularius.mode.full'), body: t('tabularius.confirmFull'), action: t('tabularius.mode.full'), danger: true })) { select.value = current.mode ?? 'read-only'; return; }
    await api(`/tabularius/vaults/${encodeURIComponent(vaultId)}/mode`, 'PUT', { mode: select.value });
    await refresh(); message(t('tabularius.saved'));
  }));
  document.getElementById('web')?.addEventListener('change', event => void run(async () => {
    await api(`/tabularius/vaults/${encodeURIComponent(vaultId)}/web`, 'PUT', { enabled: (event.target as HTMLInputElement).checked });
    await refresh(); message(t('tabularius.saved'));
  }));
  form('add-host', async data => {
    await api('/tabularius/hosts', 'POST', { name: data.get('name'), address: data.get('address'), port: Number(data.get('port')), username: data.get('username'), policy: data.get('policy'), commands: data.get('commands') });
    await loadHosts(); draw(); message(t('tabularius.hostAdded'));
  });
  for (const item of document.querySelectorAll<HTMLFormElement>('form.host')) {
    const id = item.dataset.host!;
    item.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(item);
      void run(async () => { await api(`/tabularius/hosts/${encodeURIComponent(id)}`, 'PUT', { policy: data.get('policy'), commands: data.get('commands') }); await loadHosts(); draw(); message(t('tabularius.saved')); });
    });
    item.querySelector('[data-check]')!.addEventListener('click', () => void run(async () => { await api(`/tabularius/hosts/${encodeURIComponent(id)}/check`, 'POST'); await loadHosts(); draw(); message(t('tabularius.hostChecked')); }));
    item.querySelector('[data-remove]')!.addEventListener('click', () => void run(async () => {
      if (!await confirmAction({ title: t('tabularius.removeHost'), body: t('tabularius.confirmRemoveHost'), action: t('tabularius.removeHost'), danger: true })) return;
      await api(`/tabularius/hosts/${encodeURIComponent(id)}`, 'DELETE'); await loadHosts(); draw();
    }));
  }
  form('vault-prompt', async data => {
    await api(`/tabularius/vaults/${encodeURIComponent(vaultId)}/prompt`, 'PUT', { prompt: data.get('prompt') });
    await refresh(); message(t('tabularius.promptSaved'));
  });
  document.getElementById('import-prompt')!.addEventListener('click', () => void run(async () => {
    const { prompt } = await api<{ prompt: string }>(`/tabularius/vaults/${encodeURIComponent(vaultId)}/prompt/import`, 'POST', {});
    document.querySelector<HTMLTextAreaElement>('#vault-prompt textarea')!.value = prompt;
    message(t('tabularius.imported'));
  }));
  document.getElementById('preview')!.addEventListener('toggle', event => void run(async () => {
    if (!(event.target as HTMLDetailsElement).open) return;
    const preview = await api<{ fixed: string; server: string; vault: string; recipe: string }>(`/tabularius/vaults/${encodeURIComponent(vaultId)}/prompt`);
    document.querySelector('#preview .preview-body')!.innerHTML = [[t('tabularius.previewServer'), preview.server], [t('tabularius.previewFixed'), preview.fixed], [t('tabularius.previewVault'), preview.vault], [t('tabularius.previewRecipe'), preview.recipe]]
      .map(([title, text]) => `<h4>${escape(title)}</h4><pre class="prompt-text">${escape(text || '—')}</pre>`).join('');
  }));
  document.getElementById('vault-recipe')!.addEventListener('change', event => void run(async () => {
    const value = (event.target as HTMLSelectElement).value;
    await api(`/tabularius/vaults/${encodeURIComponent(vaultId)}/recipe`, 'PUT', { recipe: value || null });
    await refresh(); message(t('tabularius.saved'));
  }));
  document.getElementById('knowledge')?.addEventListener('change', event => void run(async () => {
    await api(`/tabularius/vaults/${encodeURIComponent(vaultId)}/knowledge`, 'PUT', { enabled: (event.target as HTMLInputElement).checked });
    await refresh(); message(t('tabularius.saved'));
  }));
  form('rules', async data => {
    await api(`/tabularius/vaults/${encodeURIComponent(vaultId)}/rules`, 'PUT', { excluded: data.get('excluded'), masks: data.get('masks') });
    await refresh(); message(t('tabularius.saved'));
  });
  document.getElementById('disable')!.addEventListener('click', () => void run(async () => {
    if (!await confirmAction({ title: t('tabularius.disable'), body: t('tabularius.confirmDisable', { name: current.name }), action: t('tabularius.disable'), danger: true, confirmName: current.name })) return;
    await api(`/tabularius/vaults/${encodeURIComponent(vaultId)}`, 'DELETE');
    view = 'chat'; await refresh(); await openVault();
  }));
}

async function showMemories() {
  memories = await api<MemoryItem[]>('/tabularius/memories');
  view = 'memories'; draw();
}
function drawMemories() {
  const items = memories.map(m => `<form class="memory stack" data-id="${escape(m.id)}"><textarea name="content" rows="2" aria-label="${t('tabularius.memory')}">${escape(m.content)}</textarea>
    <div class="actions"><small>${formatDate(m.updatedAt)}</small><button type="submit">${t('common.save')}</button><button type="button" class="danger" data-delete>${t('tabularius.deleteMemory')}</button></div></form>`).join('');
  shell(`<header class="page-head"><div><p class="eyebrow">Tabularius</p><h1>${t('tabularius.memories')}${tip(t('tabularius.memoriesDesc'))}</h1></div></header>
    <div class="card"><form id="add-memory" class="stack"><label>${t('tabularius.newMemory')}<textarea name="content" rows="2" required></textarea></label><button class="primary" type="submit">${t('tabularius.addMemory')}</button></form></div>
    <div class="card">${items || `<p class="muted">${t('tabularius.noMemories')}</p>`}</div>`);
  form('add-memory', async data => { await api('/tabularius/memories', 'POST', { content: data.get('content') }); await showMemories(); message(t('tabularius.saved')); });
  for (const item of document.querySelectorAll<HTMLFormElement>('form.memory')) {
    item.addEventListener('submit', event => {
      event.preventDefault();
      void run(async () => { await api(`/tabularius/memories/${encodeURIComponent(item.dataset.id!)}`, 'PUT', { content: new FormData(item).get('content') }); await showMemories(); message(t('tabularius.saved')); });
    });
    item.querySelector('[data-delete]')!.addEventListener('click', () => void run(async () => {
      if (!await confirmAction({ title: t('tabularius.deleteMemory'), body: t('tabularius.confirmDeleteMemory'), action: t('tabularius.deleteMemory'), danger: true })) return;
      await api(`/tabularius/memories/${encodeURIComponent(item.dataset.id!)}`, 'DELETE'); await showMemories();
    }));
  }
}
async function showProposals() {
  proposals = await api<ProposalSummary[]>(`/tabularius/vaults/${encodeURIComponent(vaultId)}/proposals`);
  view = 'proposals'; draw();
}
async function showProposal(id: string) {
  proposal = await api<ProposalDetail>(`/tabularius/proposals/${encodeURIComponent(id)}`);
  view = 'proposal'; draw();
}
function drawProposals() {
  const rows = proposals.map(p => `<tr><td><button class="link" data-proposal="${escape(p.id)}">${escape(p.title)}</button></td><td>${statusBadge(p.status)}</td><td>${formatDate(p.createdAt)}</td></tr>`).join('');
  shell(`<header class="page-head"><div><p class="eyebrow">Tabularius</p><h1>${t('tabularius.proposals')}</h1></div></header>
    <div class="card">${rows ? `<table><thead><tr><th>${t('tabularius.proposalTitle')}</th><th>${t('common.status')}</th><th>${t('tabularius.proposedAt')}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">${t('tabularius.noProposals')}</p>`}</div>`);
}
function fileHtml(file: ProposalFile) {
  const target = file.to ? `${escape(file.path)} → ${escape(file.to)}` : escape(file.path);
  const lines = file.hunks.map(hunk => `<div class="hunk">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</div>` + hunk.lines
    .filter(line => !line.startsWith('\\'))
    .map(line => `<div class="${line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'}">${escape(line) || ' '}</div>`).join('')).join('');
  return `<section class="file"><h3><span class="badge${file.op === 'delete' ? ' warn' : ''}">${t(`tabularius.op.${file.op}`)}</span> <code>${target}</code>${file.automatic ? ` <small>${t('tabularius.automatic')}</small>` : ''}</h3>
    ${file.binary ? `<p class="muted">${t('tabularius.binary')}</p>` : lines ? `<pre class="diff">${lines}</pre>` : `<p class="muted">${t('tabularius.unchanged')}</p>`}</section>`;
}
function drawProposal(detail: ProposalDetail) {
  const pending = detail.status === 'pending';
  shell(`<header class="page-head"><div><p class="eyebrow">${t('tabularius.proposal')} ${statusBadge(detail.status)}</p><h1>${escape(detail.title)}</h1>
      <p>${escape(detail.summary)}</p><small>${t('tabularius.fileCount', { count: detail.files.length })} · ${formatDate(detail.createdAt)}</small></div>
      <div class="actions"><button id="chat">${t('tabularius.backToChat')}</button>${pending ? `<button id="discard">${t('tabularius.discard')}</button><button id="apply" class="primary">${t('tabularius.apply')}</button>` : ''}</div></header>
    ${detail.error && pending ? `<div class="notice error">${t('tabularius.applyFailed')}<ul>${detail.error.split('\n').map(line => { const [kind, path] = line.split('\t'); return `<li>${path === undefined ? escape(kind) : (hasMessage(`tabularius.problem.${kind}`) ? t(`tabularius.problem.${kind as 'missing'}`, { path: escape(path) }) : `${escape(kind)}: ${escape(path)}`)}</li>`; }).join('')}</ul></div>` : ''}
    ${pending && detail.files.length > 1 ? `<p class="notice">${t('tabularius.pauseEditing')}</p>` : ''}
    <div class="card proposal">${detail.files.map(fileHtml).join('')}</div>`);
  document.getElementById('chat')!.addEventListener('click', () => void run(async () => {
    const loaded = await api<{ id: string; messages: Entry[] }>(`/tabularius/conversations/${encodeURIComponent(detail.conversationId)}`);
    view = 'chat'; conversationId = loaded.id; entries = loaded.messages; draw();
  }));
  document.getElementById('discard')?.addEventListener('click', () => void run(async () => {
    await api(`/tabularius/proposals/${encodeURIComponent(detail.id)}/discard`, 'POST');
    await showProposal(detail.id); message(t('tabularius.discardedMessage'));
  }));
  document.getElementById('apply')?.addEventListener('click', () => void run(async () => {
    if (!await confirmAction({ title: t('tabularius.apply'), body: t('tabularius.confirmApply', { count: detail.files.length }), action: t('tabularius.apply') })) return;
    try { await api(`/tabularius/proposals/${encodeURIComponent(detail.id)}/apply`, 'POST'); } catch (error) { await showProposal(detail.id); throw error; }
    await showProposal(detail.id); message(t('tabularius.appliedMessage'));
  }));
}

function drawChat(current: VaultStatus) {
  const title = conversations.find(c => c.id === conversationId)?.title ?? (entries.length ? t('tabularius.newChat') : '');
  // The recipe and this conversation's settings sit in the box itself, with the send button.
  const picker = overview!.recipes.length ? `<button id="chat-settings" type="button" class="icon-button" aria-label="${t('tabularius.chatSettings')}" title="${t('tabularius.chatSettings')}">${GEAR_ICON}</button><select id="chat-recipe" class="bare" aria-label="${t('tabularius.recipe')}" title="${escape(recipeOf(chat.recipe)?.modelName ?? '')}">${recipeOptions(chat.recipe, chat.recipe ? undefined : t('tabularius.noModel'))}</select>` : '';
  const attach = `<button id="attach" type="button" class="icon-button" aria-label="${t('tabularius.attach')}" title="${t('tabularius.attachHint')}">${ATTACH_ICON}</button><input id="attach-input" type="file" multiple hidden>`;
  const webPill = chat.web && webAllowed() ? `<span class="composer-pill">${t('tabularius.webPill')}</span>` : '';
  const composer = `<form id="ask" class="composer"><div id="attachments" class="attachments">${pendingHtml()}</div><textarea name="message" rows="${entries.length ? 2 : 3}" placeholder="${escape(t('tabularius.ask'))}" aria-label="${escape(t('tabularius.ask'))}" title="${escape(t('tabularius.askHint'))}" ${busy ? 'disabled' : ''}></textarea><div class="composer-bar"><div class="composer-tools">${attach}${picker}${webPill}</div><div class="composer-tools"><small>${escape(current.name)}</small><button class="primary send" type="submit" aria-label="${t('tabularius.send')}" title="${t('tabularius.send')}" ${busy ? 'disabled' : ''}>${SEND_ICON}</button></div></div></form>`;
  // A new conversation starts in the middle of the page; once it has messages the box moves below them.
  shell(`<header class="chat-top"><h1 class="chat-title">${escape(title)}</h1><div class="chat-tools">${syncPill(current)}${conversationId ? `<button id="delete" class="danger">${t('tabularius.deleteChat')}</button>` : ''}</div></header>
    ${current.indexError ? `<p class="notice error">${t('tabularius.indexError', { error: escape(current.indexError) })}</p>` : ''}
    ${entries.length ? `<section id="log" class="log" aria-live="polite">${entries.map(entryHtml).join('')}</section><div class="chat-bottom">${composer}</div>`
    : `<div class="chat-start"><div class="chat-start-inner"><h2 class="chat-hello">Tabularius</h2>${composer}</div></div><div id="log" hidden></div>`}`);
  const log = document.getElementById('log')!;
  log.scrollTop = log.scrollHeight;
  // Diagrams are drawn once an answer is complete; while it streams their source shows.
  if (!busy) void answers.renderDiagrams(log);
  document.getElementById('chat-recipe')?.addEventListener('change', event => void run(async () => { await saveChat({ recipe: (event.target as HTMLSelectElement).value }); draw(); }));
  document.getElementById('chat-settings')?.addEventListener('click', chatSettings);
  document.getElementById('delete')?.addEventListener('click', () => void run(async () => {
    if (!await confirmAction({ title: t('tabularius.deleteChat'), body: t('tabularius.confirmDeleteChat'), action: t('tabularius.deleteChat'), danger: true })) return;
    await api(`/tabularius/conversations/${encodeURIComponent(conversationId!)}`, 'DELETE');
    conversations = conversations.filter(c => c.id !== conversationId); conversationId = undefined; entries = []; newChat(); draw();
  }));
  const textarea = document.querySelector<HTMLTextAreaElement>('#ask textarea')!;
  textarea.addEventListener('keydown', event => {
    // Enter sends and Shift+Enter starts a new line; Enter that confirms an input method's composition does neither.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); (textarea.form as HTMLFormElement).requestSubmit(); }
  });
  const form = document.getElementById('ask') as HTMLFormElement;
  const input = document.getElementById('attach-input') as HTMLInputElement;
  document.getElementById('attach')!.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addFiles([...input.files ?? []]); input.value = ''; });
  // Files dropped on the box or pasted into it are added like chosen ones.
  form.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); form.classList.add('dropping'); } });
  form.addEventListener('dragleave', () => form.classList.remove('dropping'));
  form.addEventListener('drop', event => { event.preventDefault(); form.classList.remove('dropping'); addFiles([...event.dataTransfer?.files ?? []]); });
  textarea.addEventListener('paste', event => {
    const files = [...event.clipboardData?.files ?? []];
    if (files.length) { event.preventDefault(); addFiles(files); }
  });
  document.getElementById('attachments')!.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
    if (button) dropPending(Number(button.dataset.remove));
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (busy || (!text && !pending.length)) return;
    if (pending.some(item => !item.id && !item.error)) { message(t('tabularius.waitUploads'), true); return; }
    if (pending.some(item => item.error)) { message(t('tabularius.removeFailed'), true); return; }
    if (pending.some(item => item.kind === 'image') && !recipeOf(chat.recipe)?.vision) { message(t('tabularius.noVision'), true); return; }
    const sent = pending.map(item => ({ id: item.id!, name: item.name, kind: item.kind! }));
    for (const item of pending) if (item.preview) URL.revokeObjectURL(item.preview);
    pending = [];
    void run(() => ask(text, sent));
  });
  if (!busy) textarea.focus();
}

/** Sends a message and renders the streamed reply as it arrives. */
async function ask(text: string, attachments: AttachmentRef[]) {
  busy = true;
  const answer: Entry = { role: 'assistant', text: '', tools: [] };
  entries.push({ role: 'user', text, ...(attachments.length ? { attachments } : {}) }, answer);
  draw();
  const target = () => document.querySelector('#log .turn.assistant:last-child');
  const update = () => { const node = target(); if (node) node.outerHTML = entryHtml({ ...answer, text: answer.text || t('tabularius.working') }); const log = document.getElementById('log'); if (log) log.scrollTop = log.scrollHeight; };
  update();
  try {
    const response = await fetch(conversationId ? `/api/v1/tabularius/conversations/${encodeURIComponent(conversationId)}/messages` : `/api/v1/tabularius/vaults/${encodeURIComponent(vaultId)}/conversations`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': state.session!.csrf }, body: JSON.stringify({ message: text, attachments: attachments.map(item => item.id),
        ...(conversationId ? {} : { recipe: chat.recipe || undefined, prompt: chat.prompt, params: chat.params, web: webAllowed() && chat.web }) }),
    });
    if (!response.ok) throw new ApiError(response.status, serverError((await response.json()).error));
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null');
        if (event === 'conversation') {
          if (!conversationId) { conversationId = data.id; conversations.unshift({ id: data.id, title: data.title, updatedAt: Date.now() }); }
        } else if (event === 'text') answer.text += data.text;
        else if (event === 'tool') answer.tools!.push(data);
        else if (event === 'approval') {
          const list = answer.approvals ??= [];
          const known = list.find(a => a.id === data.id);
          if (known) known.approved = data.approved; else list.push(data);
        } else if (event === 'proposal') {
          const tool = answer.tools!.find(item => item.name === 'propose_changes' && !item.proposal);
          if (tool) tool.proposal = data;
        }
        else if (event === 'done') { answer.read = data.read; answer.sources = data.sources; }
        else if (event === 'error') answer.error = data.message;
        update();
      }
    }
  } finally {
    busy = false;
    draw();
  }
}

// Approval buttons appear inside a streaming answer, which is re-rendered as it grows, so clicks are handled here.
document.addEventListener('click', event => {
  if ((event.target as HTMLElement).closest('#log') && answers.copyCode(event, t('notes.codeCopied'))) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-approve],[data-deny]');
  if (!button) return;
  const id = button.dataset.approve ?? button.dataset.deny!;
  if (answered.has(id)) return;
  answered.add(id);
  for (const other of document.querySelectorAll<HTMLButtonElement>(`[data-approve="${CSS.escape(id)}"],[data-deny="${CSS.escape(id)}"]`)) other.disabled = true;
  void run(() => api(`/tabularius/approvals/${encodeURIComponent(id)}`, 'POST', { approved: Boolean(button.dataset.approve) }));
});

/** Draws Tabularius into the shell's content area; `?vault=` and `?conversation=` select what opens. */
export async function renderTabularius(content: HTMLElement) {
  app = content;
  notesStyles();
  answers ??= await import('/notes/assets/answer-markdown.js' as string) as AnswerModule;
  const query = new URLSearchParams(location.search);
  if (query.get('vault')) vaultId = query.get('vault')!;
  view = 'chat';
  await load();
  // Only a conversation of this vault that the server listed for this user opens from the address.
  const conversation = query.get('conversation');
  if (conversation && conversations.some(c => c.id === conversation)) await openConversation(conversation);
}
