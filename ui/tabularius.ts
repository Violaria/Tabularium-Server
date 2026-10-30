// Tabularius: enable the AI curator for a vault, set what it may send, and talk to it about the notes.
import { formatDate, languageSelect, serverError, t } from './i18n.js';

interface Session { user: { username: string; mustChangePassword: boolean }; csrf: string }
interface VaultStatus {
  id: string; name: string; enabled: boolean; enabledAt?: number; excluded?: string; masks?: string; running?: boolean; replicated?: boolean;
  deviceRevoked?: boolean; knowledge?: boolean; web?: boolean; mode?: Mode; params?: string; indexError?: string | null; notes?: number; chunks?: number; log?: string[];
}
type Mode = 'read-only' | 'restricted' | 'full';
interface Overview { provider: string; model: string; embeddings: boolean; knowledge: boolean; web: boolean; modes: Mode[]; params: Record<string, unknown>; paramNames: string[]; vaults: VaultStatus[] }
interface Summary { id: string; title: string; updatedAt: number }
interface ProposalRef { id: string; title: string; status: string; files?: number }
interface ToolUse { name: string; input: Record<string, unknown>; proposal?: ProposalRef }
interface ProposalSummary { id: string; conversationId: string; title: string; summary: string; status: string; error: string | null; createdAt: number; decidedAt: number | null }
interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
interface ProposalFile { op: 'create' | 'edit' | 'move' | 'delete'; path: string; to: string | null; automatic: boolean; binary: boolean; hunks: Hunk[] }
interface ProposalDetail extends ProposalSummary { vaultId: string; files: ProposalFile[] }
interface Source { url: string; title: string }
interface Entry { role: 'user' | 'assistant'; text: string; tools?: ToolUse[]; read?: string[]; sources?: Source[]; error?: string }

const app = document.querySelector<HTMLDivElement>('#app')!;
let session: Session | undefined;
let overview: Overview | undefined;
let vaultId = new URLSearchParams(location.search).get('vault') ?? '';
let view: 'chat' | 'settings' | 'proposals' | 'proposal' = 'chat';
let proposals: ProposalSummary[] = [];
let proposal: ProposalDetail | undefined;
let conversations: Summary[] = [];
let conversationId: string | undefined;
let entries: Entry[] = [];
let busy = false;

class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-csrf-token': session.csrf } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, serverError(result.error));
  return result as T;
}
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const vault = () => overview?.vaults.find(v => v.id === vaultId);

function message(text: string, error = false) {
  const target = document.querySelector<HTMLDivElement>('#message');
  if (!target) return;
  target.className = error ? 'notice error' : 'notice'; target.textContent = text; target.hidden = false;
}
async function run(action: () => Promise<void>) {
  try { await action(); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) { session = undefined; login(); message(t('common.sessionExpired'), true); }
    else message(error instanceof Error ? error.message : t('common.failed'), true);
  }
}
function form(id: string, action: (data: FormData) => Promise<void>) {
  document.querySelector<HTMLFormElement>(`#${id}`)?.addEventListener('submit', event => {
    event.preventDefault();
    const target = event.currentTarget as HTMLFormElement;
    const submit = target.querySelector<HTMLButtonElement>('button[type=submit]')!; submit.disabled = true;
    void run(() => action(new FormData(target))).finally(() => { submit.disabled = false; });
  });
}

/** Answer text: paragraphs, fenced code, inline code, and [[note]] citations linked to the web notes page. */
function render(text: string) {
  const link = (path: string) => `<a class="cite" href="/notes/#${encodeURIComponent(vaultId)}/${path.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener">${escape(path)}</a>`;
  const inline = (value: string) => escape(value)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[\[([^\]\n|]+?)(?:\|[^\]\n]*)?\]\]/g, (_, path: string) => link(path.replace(/&amp;/g, '&')));
  return text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/).map(block => {
    const fence = /^```[^\n]*\n([\s\S]*?)(?:```)?$/.exec(block);
    if (fence) return `<pre><code>${escape(fence[1])}</code></pre>`;
    return block.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => `<p>${inline(p).replace(/\n/g, '<br>')}</p>`).join('');
  }).join('');
}
function toolLabel(tool: ToolUse) {
  const value = (key: string) => escape(String(tool.input[key] ?? ''));
  if (tool.name === 'search_notes') return t('tabularius.toolSearch', { query: value('query') });
  if (tool.name === 'read_note') return t('tabularius.toolRead', { path: value('path') });
  if (tool.name === 'list_notes') return t('tabularius.toolList', { folder: value('folder') || '/' });
  if (tool.name === 'search_knowledge_base') return t('tabularius.toolKnowledge', { query: value('question') });
  if (tool.name === 'web_search') return t('tabularius.toolWebSearch', { query: value('query') });
  if (tool.name === 'web_fetch' || tool.name === 'fetch_url') return t('tabularius.toolWebFetch', { url: value('url') });
  if (tool.name === 'propose_changes') return tool.proposal
    ? `<button class="proposal-link" data-proposal="${escape(tool.proposal.id)}">${t('tabularius.toolPropose', { title: escape(tool.proposal.title) })}</button> ${statusBadge(tool.proposal.status)}`
    : t('tabularius.toolProposeFailed');
  return escape(tool.name);
}
const statusBadge = (status: string) => `<span class="badge${status === 'pending' ? ' warn' : status === 'discarded' ? ' off' : ''}">${t(`tabularius.status.${status as 'pending' | 'applied' | 'discarded'}`)}</span>`;
function entryHtml(entry: Entry) {
  if (entry.role === 'user') return `<div class="turn user"><p>${escape(entry.text).replace(/\n/g, '<br>')}</p></div>`;
  const tools = (entry.tools ?? []).map(tool => `<li>${toolLabel(tool)}</li>`).join('');
  const read = entry.read?.length ? `<div class="read"><small>${t('tabularius.readNotes')}</small>${render(entry.read.map(path => `[[${path}]]`).join('  '))}</div>` : '';
  const web = (entry.sources ?? []).filter(source => /^https?:/.test(source.url));
  const sources = web.length ? `<div class="read"><small>${t('tabularius.sources')}</small><ol class="sources">${web.map(source =>
    `<li><a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${escape(source.title || source.url)}</a></li>`).join('')}</ol></div>` : '';
  return `<div class="turn assistant">${tools ? `<ul class="tools">${tools}</ul>` : ''}<div class="answer">${render(entry.text)}</div>${entry.error ? `<p class="notice error">${escape(entry.error)}</p>` : ''}${read}${sources}</div>`;
}

function login() {
  document.title = 'Tabularius';
  app.innerHTML = `<div class="login-page"><div class="login-box"><div class="brand"><span class="brand-mark">T</span><div><strong>Tabularius</strong><small>${t('tabularius.subtitle')}</small></div></div><div class="card"><h1>${t('console.signInTitle')}</h1><div id="message" role="status" hidden></div><form id="login" class="stack"><label>${t('common.username')}<input name="username" autocomplete="username" required></label><label>${t('common.password')}<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">${t('common.signIn')}</button></form></div><div id="language"></div></div></div>`;
  document.getElementById('language')!.replaceChildren(languageSelect(login));
  form('login', async data => { session = await api<Session>('/web-session', 'POST', Object.fromEntries(data)); await load(); });
}

async function load() {
  if (session!.user.mustChangePassword) { app.innerHTML = `<div class="login-page"><div class="login-box"><div class="card"><p>${t('tabularius.changePassword')}</p><a href="/admin/">${t('home.console')}</a></div></div></div>`; return; }
  overview = await api<Overview>('/tabularius');
  if (!overview.vaults.some(v => v.id === vaultId)) vaultId = overview.vaults.find(v => v.enabled)?.id ?? overview.vaults[0]?.id ?? '';
  await openVault();
}
async function openVault() {
  conversationId = undefined; entries = [];
  conversations = vault()?.enabled ? await api<Summary[]>(`/tabularius/vaults/${vaultId}/conversations`) : [];
  draw();
}
async function refresh() {
  overview = await api<Overview>('/tabularius');
  draw();
}

function shell(content: string) {
  const current = vault();
  const options = overview!.vaults.map(v => `<option value="${escape(v.id)}" ${v.id === vaultId ? 'selected' : ''}>${escape(v.name)}${v.enabled ? '' : ` (${t('tabularius.off')})`}</option>`).join('');
  const list = conversations.map(c => `<button class="conversation" data-id="${escape(c.id)}" ${c.id === conversationId ? 'aria-current="page"' : ''}>${escape(c.title)}<small>${formatDate(c.updatedAt)}</small></button>`).join('');
  app.innerHTML = `<aside class="sidebar"><div class="brand"><span class="brand-mark">T</span><div><strong>Tabularius</strong><small>${t('tabularius.subtitle')}</small></div></div>
    <nav aria-label="${t('tabularius.conversations')}">${overview!.vaults.length ? `<select id="vault" aria-label="${t('tabularius.vault')}">${options}</select>` : ''}
    ${current?.enabled ? `<button id="new" class="new">${t('tabularius.newChat')}</button>${list || `<small>${t('tabularius.noConversations')}</small>`}<button id="proposals" ${view.startsWith('proposal') ? 'aria-current="page"' : ''}>${t('tabularius.proposals')}</button><button id="settings" ${view === 'settings' ? 'aria-current="page"' : ''}>${t('tabularius.settings')}</button>` : ''}</nav>
    <div class="account"><div><strong>${escape(session!.user.username)}</strong><br><a href="/admin/">${t('home.console')}</a> · <a href="/notes/">${t('home.notes')}</a></div><div id="language"></div><button id="logout">${t('common.signOut')}</button></div></aside>
    <main class="main tabularius"><div id="message" role="status" hidden></div>${content}</main>`;
  document.getElementById('language')!.replaceChildren(languageSelect(draw));
  document.getElementById('vault')?.addEventListener('change', event => { vaultId = (event.target as HTMLSelectElement).value; view = 'chat'; void run(openVault); });
  document.getElementById('new')?.addEventListener('click', () => { view = 'chat'; conversationId = undefined; entries = []; draw(); });
  document.getElementById('settings')?.addEventListener('click', () => { view = 'settings'; void run(refresh); });
  document.getElementById('proposals')?.addEventListener('click', () => void run(showProposals));
  for (const item of document.querySelectorAll<HTMLButtonElement>('[data-proposal]')) item.addEventListener('click', () => void run(() => showProposal(item.dataset.proposal!)));
  document.getElementById('logout')!.addEventListener('click', () => void run(async () => { await api('/web-session', 'DELETE'); session = undefined; login(); }));
  for (const item of document.querySelectorAll<HTMLButtonElement>('.conversation')) item.addEventListener('click', () => void run(async () => {
    const loaded = await api<{ id: string; messages: Entry[] }>(`/tabularius/conversations/${item.dataset.id}`);
    view = 'chat'; conversationId = loaded.id; entries = loaded.messages; draw();
  }));
}

function draw() {
  document.title = `Tabularius · ${vault()?.name ?? 'Tabularium'}`;
  const current = vault();
  if (!current) { shell(`<div class="card empty">${t('tabularius.noVaults')}</div>`); return; }
  if (!current.enabled) { drawEnable(current); return; }
  if (view === 'settings') { drawSettings(current); return; }
  if (view === 'proposals') { drawProposals(); return; }
  if (view === 'proposal' && proposal) { drawProposal(proposal); return; }
  drawChat(current);
}

const rulesFields = (excluded: string, masks: string) => `
  <label>${t('tabularius.excluded')}<textarea name="excluded" rows="4" spellcheck="false">${escape(excluded)}</textarea><small>${t('tabularius.excludedHint')}</small></label>
  <label>${t('tabularius.masks')}<textarea name="masks" rows="3" spellcheck="false">${escape(masks)}</textarea><small>${t('tabularius.masksHint')}</small></label>`;

function drawEnable(current: VaultStatus) {
  shell(`<header class="page-head"><div><p class="eyebrow">Tabularius</p><h1>${t('tabularius.enableTitle', { name: escape(current.name) })}</h1></div></header>
    <div class="card"><p>${t('tabularius.enableWarning', { provider: escape(`${overview!.provider} ${overview!.model}`) })}</p>
    <form id="enable" class="stack"><label class="check"><input type="checkbox" name="confirm" required> ${t('tabularius.enableConfirm')}</label>
    <label>${t('tabularius.passphrase')}<input name="passphrase" type="password" autocomplete="off" required></label>
    ${rulesFields('', '')}
    <button class="primary" type="submit">${t('tabularius.enable')}</button></form></div>`);
  form('enable', async data => {
    message(t('tabularius.enabling'));
    await api(`/tabularius/vaults/${vaultId}`, 'POST', { passphrase: data.get('passphrase'), confirm: data.get('confirm') === 'on', excluded: data.get('excluded'), masks: data.get('masks') });
    await refresh(); await openVault();
  });
}

function statusText(current: VaultStatus) {
  if (current.deviceRevoked) return `<span class="badge warn">${t('tabularius.revoked')}</span>`;
  const state = !current.running ? `<span class="badge warn">${t('tabularius.stopped')}</span>`
    : current.replicated ? `<span class="badge">${t('tabularius.ready')}</span>` : `<span class="badge off">${t('tabularius.syncing')}</span>`;
  return `${state} <small>${t('tabularius.counts', { notes: current.notes ?? 0, chunks: current.chunks ?? 0 })}</small>${current.indexError ? `<p class="notice error">${t('tabularius.indexError', { error: escape(current.indexError) })}</p>` : ''}`;
}

function drawSettings(current: VaultStatus) {
  shell(`<header class="page-head"><div><p class="eyebrow">Tabularius</p><h1>${escape(current.name)}</h1><p>${statusText(current)}</p></div><button id="reload">${t('common.refresh')}</button></header>
    <div class="card"><h2>${t('tabularius.rules')}</h2><form id="rules" class="stack">
      ${rulesFields(current.excluded ?? '', current.masks ?? '')}
      <button class="primary" type="submit">${t('common.save')}</button></form></div>
    <div class="card"><h2>${t('tabularius.modeTitle')}</h2><p>${t('tabularius.modeDesc')}</p>
      <label>${t('tabularius.mode')}<select id="mode">${(['read-only', 'restricted', 'full'] as Mode[]).map(mode =>
        `<option value="${mode}" ${current.mode === mode ? 'selected' : ''} ${overview!.modes.includes(mode) ? '' : 'disabled'}>${t(`tabularius.mode.${mode}`)}</option>`).join('')}</select></label>
      ${overview!.web ? `<label class="check"><input type="checkbox" id="web" ${current.web ? 'checked' : ''}> ${t('tabularius.webEnable')}</label><small>${t('tabularius.webDesc')}</small>` : ''}</div>
    <div class="card"><h2>${t('tabularius.paramsTitle')}</h2><form id="params" class="stack"><label>${t('tabularius.params')}<textarea name="params" rows="3" spellcheck="false" placeholder='{"effort": "high"}'>${escape(current.params ?? '')}</textarea>
      <small>${t('tabularius.paramsHint', { names: escape(overview!.paramNames.join(', ')), defaults: escape(JSON.stringify(overview!.params)) })}</small></label><button class="primary" type="submit">${t('common.save')}</button></form></div>
    ${overview!.knowledge ? `<div class="card"><h2>${t('tabularius.knowledge')}</h2><p>${t('tabularius.knowledgeDesc')}</p>
      <label class="check"><input type="checkbox" id="knowledge" ${current.knowledge ? 'checked' : ''}> ${t('tabularius.knowledgeEnable')}</label></div>` : ''}
    <div class="card"><h2>${t('tabularius.about')}</h2><dl class="details"><dt>${t('tabularius.model')}</dt><dd>${escape(`${overview!.provider} ${overview!.model}`)}</dd>
      <dt>${t('tabularius.embeddings')}</dt><dd>${overview!.embeddings ? t('tabularius.embeddingsOn') : t('tabularius.embeddingsOff')}</dd>
      <dt>${t('tabularius.enabledAt')}</dt><dd>${formatDate(current.enabledAt!)}</dd></dl>
      ${current.log?.length ? `<details><summary>${t('tabularius.log')}</summary><pre class="mono">${escape(current.log.join('\n'))}</pre></details>` : ''}</div>
    <div class="card"><h2>${t('tabularius.disable')}</h2><p>${t('tabularius.disableDesc')}</p><button id="disable" class="danger">${t('tabularius.disable')}</button></div>`);
  document.getElementById('reload')!.addEventListener('click', () => void run(refresh));
  document.getElementById('mode')!.addEventListener('change', event => void run(async () => {
    const select = event.target as HTMLSelectElement;
    if (select.value === 'full' && !confirm(t('tabularius.confirmFull'))) { select.value = current.mode ?? 'read-only'; return; }
    await api(`/tabularius/vaults/${vaultId}/mode`, 'PUT', { mode: select.value });
    await refresh(); message(t('tabularius.saved'));
  }));
  document.getElementById('web')?.addEventListener('change', event => void run(async () => {
    await api(`/tabularius/vaults/${vaultId}/web`, 'PUT', { enabled: (event.target as HTMLInputElement).checked });
    await refresh(); message(t('tabularius.saved'));
  }));
  form('params', async data => {
    await api(`/tabularius/vaults/${vaultId}/params`, 'PUT', { params: data.get('params') });
    await refresh(); message(t('tabularius.saved'));
  });
  document.getElementById('knowledge')?.addEventListener('change', event => void run(async () => {
    await api(`/tabularius/vaults/${vaultId}/knowledge`, 'PUT', { enabled: (event.target as HTMLInputElement).checked });
    await refresh(); message(t('tabularius.saved'));
  }));
  form('rules', async data => {
    await api(`/tabularius/vaults/${vaultId}/rules`, 'PUT', { excluded: data.get('excluded'), masks: data.get('masks') });
    await refresh(); message(t('tabularius.saved'));
  });
  document.getElementById('disable')!.addEventListener('click', () => void run(async () => {
    if (!confirm(t('tabularius.confirmDisable', { name: current.name }))) return;
    await api(`/tabularius/vaults/${vaultId}`, 'DELETE');
    view = 'chat'; await refresh(); await openVault();
  }));
}

async function showProposals() {
  proposals = await api<ProposalSummary[]>(`/tabularius/vaults/${vaultId}/proposals`);
  view = 'proposals'; draw();
}
async function showProposal(id: string) {
  proposal = await api<ProposalDetail>(`/tabularius/proposals/${id}`);
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
    ${detail.error && pending ? `<div class="notice error">${t('tabularius.applyFailed')}<ul>${detail.error.split('\n').map(line => { const [kind, path] = line.split('\t'); return `<li>${path === undefined ? escape(kind) : t(`tabularius.problem.${kind as 'missing' | 'changed' | 'exists'}`, { path: escape(path) })}</li>`; }).join('')}</ul></div>` : ''}
    ${pending && detail.files.length > 1 ? `<p class="notice">${t('tabularius.pauseEditing')}</p>` : ''}
    <div class="card proposal">${detail.files.map(fileHtml).join('')}</div>`);
  document.getElementById('chat')!.addEventListener('click', () => void run(async () => {
    const loaded = await api<{ id: string; messages: Entry[] }>(`/tabularius/conversations/${detail.conversationId}`);
    view = 'chat'; conversationId = loaded.id; entries = loaded.messages; draw();
  }));
  document.getElementById('discard')?.addEventListener('click', () => void run(async () => {
    await api(`/tabularius/proposals/${detail.id}/discard`, 'POST');
    await showProposal(detail.id); message(t('tabularius.discardedMessage'));
  }));
  document.getElementById('apply')?.addEventListener('click', () => void run(async () => {
    if (!confirm(t('tabularius.confirmApply', { count: detail.files.length }))) return;
    try { await api(`/tabularius/proposals/${detail.id}/apply`, 'POST'); } catch (error) { await showProposal(detail.id); throw error; }
    await showProposal(detail.id); message(t('tabularius.appliedMessage'));
  }));
}

function drawChat(current: VaultStatus) {
  shell(`<header class="chat-head"><div><h1>${escape(conversations.find(c => c.id === conversationId)?.title ?? t('tabularius.newChat'))}</h1><p>${statusText(current)}</p></div>
      ${conversationId ? `<button id="delete" class="danger">${t('tabularius.deleteChat')}</button>` : ''}</header>
    <section id="log" class="log" aria-live="polite">${entries.length ? entries.map(entryHtml).join('') : `<p class="muted">${t('tabularius.intro')}</p>`}</section>
    <form id="ask" class="ask"><textarea name="message" rows="3" placeholder="${t('tabularius.ask')}" required ${busy ? 'disabled' : ''}></textarea><button class="primary" type="submit" ${busy ? 'disabled' : ''}>${t('tabularius.send')}</button></form>`);
  const log = document.getElementById('log')!;
  log.scrollTop = log.scrollHeight;
  document.getElementById('delete')?.addEventListener('click', () => void run(async () => {
    if (!confirm(t('tabularius.confirmDeleteChat'))) return;
    await api(`/tabularius/conversations/${conversationId}`, 'DELETE');
    conversations = conversations.filter(c => c.id !== conversationId); conversationId = undefined; entries = []; draw();
  }));
  const textarea = document.querySelector<HTMLTextAreaElement>('#ask textarea')!;
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); (textarea.form as HTMLFormElement).requestSubmit(); }
  });
  document.getElementById('ask')!.addEventListener('submit', event => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (text && !busy) void run(() => ask(text));
  });
  if (!busy) textarea.focus();
}

/** Sends a message and renders the streamed reply as it arrives. */
async function ask(text: string) {
  busy = true;
  const answer: Entry = { role: 'assistant', text: '', tools: [] };
  entries.push({ role: 'user', text }, answer);
  draw();
  const target = () => document.querySelector('#log .turn.assistant:last-child');
  const update = () => { const node = target(); if (node) node.outerHTML = entryHtml({ ...answer, text: answer.text || t('tabularius.working') }); const log = document.getElementById('log'); if (log) log.scrollTop = log.scrollHeight; };
  update();
  try {
    const response = await fetch(conversationId ? `/api/v1/tabularius/conversations/${conversationId}/messages` : `/api/v1/tabularius/vaults/${vaultId}/conversations`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': session!.csrf }, body: JSON.stringify({ message: text }),
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
        else if (event === 'proposal') {
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

void run(async () => {
  try { session = await api<Session>('/web-session'); } catch (error) {
    if (error instanceof ApiError && error.status === 401) { login(); return; }
    throw error;
  }
  await load();
});
