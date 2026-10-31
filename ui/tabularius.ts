// Tabularius: enable the AI curator for a vault, set what it may send, and talk to it about the notes.
import { formatDate, serverError, t } from './i18n.js';
import { api, ApiError, confirmAction, escape, message, run, state, tip } from './core.js';
import { FormError, modelName, modelOptions, paramForm, paramLabel, PROVIDER_NAMES, type ModelOption, type Params, type ProviderName, type Rule } from './params.js';
interface VaultStatus {
  id: string; name: string; enabled: boolean; enabledAt?: number; excluded?: string; masks?: string; running?: boolean; replicated?: boolean;
  deviceRevoked?: boolean; knowledge?: boolean; web?: boolean; mode?: Mode; params?: Partial<Record<ProviderName, Params>>; prompt?: string; model?: string | null; indexError?: string | null; notes?: number; chunks?: number; log?: string[];
}
type Mode = 'read-only' | 'restricted' | 'full';
interface Overview { models: ModelOption[]; defaultModel: string; rules: Record<ProviderName, Record<string, Rule>>; serverParams: Record<ProviderName, Params>;
  embeddings: boolean; knowledge: boolean; web: boolean; admin: boolean; modes: Mode[]; vaults: VaultStatus[] }
/** The open conversation's model, extra prompt and parameters, or what a new conversation will start with. */
interface ChatSettings { model: string; prompt: string; params: Partial<Record<ProviderName, Params>> }
interface Summary { id: string; title: string; updatedAt: number }
interface ProposalRef { id: string; title: string; status: string; files?: number }
interface ToolUse { name: string; input: Record<string, unknown>; proposal?: ProposalRef }
interface ProposalSummary { id: string; conversationId: string; title: string; summary: string; status: string; error: string | null; createdAt: number; decidedAt: number | null }
interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
interface ProposalFile { op: 'create' | 'edit' | 'move' | 'delete'; path: string; to: string | null; automatic: boolean; binary: boolean; hunks: Hunk[] }
interface ProposalDetail extends ProposalSummary { vaultId: string; files: ProposalFile[] }
interface Source { url: string; title: string }
interface Approval { id: string; host: string; command: string; approved?: boolean }
interface Entry { role: 'user' | 'assistant'; text: string; tools?: ToolUse[]; read?: string[]; sources?: Source[]; approvals?: Approval[]; error?: string }
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
let chat: ChatSettings = { model: '', prompt: '', params: {} };
const providerOf = (model: string) => model.slice(0, model.indexOf('/')) as ProviderName;
/** A new conversation starts with the vault's default model, else the server's. */
function newChat() {
  const own = vault()?.model;
  chat = { model: own && overview!.models.some(m => m.id === own) ? own : overview!.defaultModel, prompt: '', params: {} };
}

const vault = () => overview?.vaults.find(v => v.id === vaultId);

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
  const link = (path: string) => `<a class="cite" href="/notes/?vault=${encodeURIComponent(vaultId)}&amp;path=${encodeURIComponent(path)}">${escape(path)}</a>`;
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
const statusBadge = (status: string) => `<span class="badge${status === 'pending' ? ' warn' : status === 'discarded' ? ' off' : ''}">${t(`tabularius.status.${status as 'pending' | 'applied' | 'discarded'}`)}</span>`;
function entryHtml(entry: Entry) {
  if (entry.role === 'user') return `<div class="turn user"><p>${escape(entry.text).replace(/\n/g, '<br>')}</p></div>`;
  const tools = (entry.tools ?? []).map(tool => `<li>${toolLabel(tool)}</li>`).join('');
  const read = entry.read?.length ? `<div class="read"><small>${t('tabularius.readNotes')}</small>${render(entry.read.map(path => `[[${path}]]`).join('  '))}</div>` : '';
  const web = (entry.sources ?? []).filter(source => /^https?:/.test(source.url));
  const sources = web.length ? `<div class="read"><small>${t('tabularius.sources')}</small><ol class="sources">${web.map(source =>
    `<li><a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${escape(source.title || source.url)}</a></li>`).join('')}</ol></div>` : '';
  const approvals = (entry.approvals ?? []).map(a => `<div class="notice approval"><p>${t('tabularius.approvalAsk', { host: escape(a.host) })}</p><pre class="mono">${escape(a.command)}</pre>
    ${a.approved === undefined ? `<div class="actions"><button class="primary" data-approve="${escape(a.id)}">${t('tabularius.approve')}</button><button data-deny="${escape(a.id)}">${t('tabularius.deny')}</button></div>`
      : `<span class="badge${a.approved ? '' : ' warn'}">${a.approved ? t('tabularius.approved') : t('tabularius.denied')}</span>`}</div>`).join('');
  return `<div class="turn assistant">${tools ? `<ul class="tools">${tools}</ul>` : ''}${approvals}<div class="answer">${render(entry.text)}</div>${entry.error ? `<p class="notice error">${escape(entry.error)}</p>` : ''}${read}${sources}</div>`;
}

async function load() {
  overview = await api<Overview>('/tabularius');
  if (!overview.vaults.some(v => v.id === vaultId)) vaultId = overview.vaults.find(v => v.enabled)?.id ?? overview.vaults[0]?.id ?? '';
  await openVault();
}
async function openVault() {
  conversationId = undefined; entries = []; newChat();
  conversations = vault()?.enabled ? await api<Summary[]>(`/tabularius/vaults/${vaultId}/conversations`) : [];
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
  const options = overview!.vaults.map(v => `<option value="${escape(v.id)}" ${v.id === vaultId ? 'selected' : ''}>${escape(v.name)}${v.enabled ? '' : ` (${t('tabularius.off')})`}</option>`).join('');
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
  const loaded = await api<{ id: string; messages: Entry[] } & ChatSettings>(`/tabularius/conversations/${id}`);
  view = 'chat'; conversationId = loaded.id; entries = loaded.messages; chat = { model: loaded.model, prompt: loaded.prompt, params: loaded.params ?? {} }; draw();
}
/** Saves the conversation's settings, or keeps them for the first message of a new conversation. */
async function saveChat(next: Partial<ChatSettings>) {
  const before = chat.model;
  chat = { ...chat, ...next };
  if (conversationId) {
    const saved = await api<ChatSettings>(`/tabularius/conversations/${conversationId}`, 'PATCH', next);
    chat = { model: saved.model, prompt: saved.prompt, params: saved.params ?? {} };
  }
  // Parameters chosen for another provider do not travel with a switch of model.
  if (next.model && before && providerOf(before) !== providerOf(next.model)) {
    const left = Object.keys({ ...(vault()?.params?.[providerOf(before)] ?? {}), ...(chat.params[providerOf(before)] ?? {}) });
    if (left.length) message(t('tabularius.paramsNotApplied', { names: left.map(paramLabel).join(', '), model: modelName(overview!.models, next.model) }));
  }
}
/** The conversation settings dialog: an extra prompt and parameters for the conversation's model. */
function chatSettings() {
  const provider = providerOf(chat.model);
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog chat-settings';
  dialog.innerHTML = `<form method="dialog" class="stack"><h2>${t('tabularius.chatSettings')}</h2><label><span>${t('tabularius.chatPrompt')}${tip(t('tabularius.chatPromptHint'))}</span><textarea name="prompt" rows="4">${escape(chat.prompt)}</textarea></label>
    <h3>${t('tabularius.paramsFor', { model: escape(modelName(overview!.models, chat.model)) })}</h3><div class="chat-params"></div>
    <div class="buttons"><button type="button" data-cancel>${t('dialog.cancel')}</button><button type="submit" class="primary">${t('common.save')}</button></div></form>`;
  document.body.append(dialog);
  const defaults = { ...overview!.serverParams[provider], ...(vault()?.params?.[provider] ?? {}) };
  const read = provider ? paramForm(dialog.querySelector<HTMLElement>('.chat-params')!, provider, overview!.rules[provider], defaults, chat.params[provider] ?? {}) : () => ({});
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.addEventListener('cancel', close);
  dialog.querySelector('[data-cancel]')!.addEventListener('click', close);
  dialog.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault();
    let params: Params;
    try { params = read(); } catch (error) { if (error instanceof FormError) { message(error.message, true); return; } throw error; }
    void run(async () => {
      await saveChat({ prompt: String(new FormData(dialog.querySelector('form')!).get('prompt')), params: { ...chat.params, ...(provider ? { [provider]: params } : {}) } });
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
    <div class="card"><p>${t('tabularius.enableWarning', { provider: escape(overview!.defaultModel ? modelName(overview!.models, overview!.defaultModel) : t('tabularius.noModel')) })}</p>
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

/** The hosted client's state as a small indicator: a coloured dot, the state, and what is indexed. */
function syncPill(current: VaultStatus) {
  const [kind, label] = current.deviceRevoked ? ['warn', t('tabularius.revoked')]
    : !current.running ? ['warn', t('tabularius.stopped')]
      : current.indexError ? ['warn', t('tabularius.ready')]
        : current.replicated ? ['ok', t('tabularius.ready')] : ['busy', t('tabularius.syncing')];
  const counts = t('tabularius.counts', { notes: current.notes ?? 0, chunks: current.chunks ?? 0 });
  return `<span class="sync-pill ${kind}" role="status" title="${escape(current.indexError ? t('tabularius.indexError', { error: current.indexError }) : counts)}"><span class="dot" aria-hidden="true"></span><strong>${escape(label)}</strong><span class="sep" aria-hidden="true"></span><span>${escape(counts)}</span></span>`;
}
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
    <div class="card"><div class="card-head"><h2>${t('tabularius.modelTitle')}</h2>${overview!.admin ? `<a class="button" href="/admin/ai" data-route>${t('tabularius.manageModels')}</a>` : ''}</div><label>${t('tabularius.vaultModel')}<select id="vault-model">${modelOptions(overview!.models, current.model ?? '', t('tabularius.followServer'))}</select></label></div>
    <div class="card"><h2>${t('tabularius.paramsTitle')}${tip(t('tabularius.paramsDesc'))}</h2>${[...new Set(overview!.models.map(m => m.provider))].map(provider =>
      `<details class="param-provider"${provider === providerOf(current.model || overview!.defaultModel) ? ' open' : ''}><summary>${PROVIDER_NAMES[provider]}</summary><div data-params="${provider}"></div></details>`).join('') || `<p class="muted">${t('tabularius.noModel')}</p>`}
      <button class="primary" type="button" id="save-params">${t('common.save')}</button></div>
    ${overview!.knowledge ? `<div class="card"><div class="card-head"><h2>${t('tabularius.knowledge')}${tip(t('tabularius.knowledgeDesc'))}</h2><a class="button" href="/admin/ai" data-route>${t('tabularius.knowledgeSettings')}</a></div>
      <label class="check"><input type="checkbox" id="knowledge" ${current.knowledge ? 'checked' : ''}> ${t('tabularius.knowledgeEnable')}</label></div>` : ''}
    <div class="card"><h2>${t('tabularius.about')}</h2><dl class="details"><dt>${t('tabularius.model')}</dt><dd>${escape(current.model || overview!.defaultModel ? modelName(overview!.models, current.model || overview!.defaultModel) : t('tabularius.noModel'))}</dd>
      <dt>${t('tabularius.embeddings')}</dt><dd>${overview!.embeddings ? t('tabularius.embeddingsOn') : t('tabularius.embeddingsOff')}</dd>
      <dt>${t('tabularius.enabledAt')}</dt><dd>${formatDate(current.enabledAt!)}</dd></dl>
      ${current.log?.length ? `<details><summary>${t('tabularius.log')}</summary><pre class="mono">${escape(current.log.join('\n'))}</pre></details>` : ''}</div>
    <div class="card"><h2>${t('tabularius.disable')}${tip(t('tabularius.disableDesc'))}</h2><button id="disable" class="danger">${t('tabularius.disable')}</button></div>`);
  document.getElementById('reload')!.addEventListener('click', () => void run(refresh));
  document.getElementById('mode')!.addEventListener('change', event => void run(async () => {
    const select = event.target as HTMLSelectElement;
    if (select.value === 'full' && !await confirmAction({ title: t('tabularius.mode.full'), body: t('tabularius.confirmFull'), action: t('tabularius.mode.full'), danger: true })) { select.value = current.mode ?? 'read-only'; return; }
    await api(`/tabularius/vaults/${vaultId}/mode`, 'PUT', { mode: select.value });
    await refresh(); message(t('tabularius.saved'));
  }));
  document.getElementById('web')?.addEventListener('change', event => void run(async () => {
    await api(`/tabularius/vaults/${vaultId}/web`, 'PUT', { enabled: (event.target as HTMLInputElement).checked });
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
      void run(async () => { await api(`/tabularius/hosts/${id}`, 'PUT', { policy: data.get('policy'), commands: data.get('commands') }); await loadHosts(); draw(); message(t('tabularius.saved')); });
    });
    item.querySelector('[data-check]')!.addEventListener('click', () => void run(async () => { await api(`/tabularius/hosts/${id}/check`, 'POST'); await loadHosts(); draw(); message(t('tabularius.hostChecked')); }));
    item.querySelector('[data-remove]')!.addEventListener('click', () => void run(async () => {
      if (!await confirmAction({ title: t('tabularius.removeHost'), body: t('tabularius.confirmRemoveHost'), action: t('tabularius.removeHost'), danger: true })) return;
      await api(`/tabularius/hosts/${id}`, 'DELETE'); await loadHosts(); draw();
    }));
  }
  const providers = [...new Set(overview!.models.map(m => m.provider))];
  const readers = Object.fromEntries(providers.map(provider => [provider,
    paramForm(document.querySelector<HTMLElement>(`[data-params="${provider}"]`)!, provider, overview!.rules[provider], overview!.serverParams[provider] ?? {}, current.params?.[provider] ?? {})]));
  document.getElementById('save-params')?.addEventListener('click', () => void run(async () => {
    let params: Record<string, Params>;
    try { params = Object.fromEntries(providers.map(provider => [provider, readers[provider]()])); } catch (error) {
      if (error instanceof FormError) { message(error.message, true); return; }
      throw error;
    }
    await api(`/tabularius/vaults/${vaultId}/params`, 'PUT', { params: { ...current.params, ...params } });
    await refresh(); message(t('tabularius.saved'));
  }));
  form('vault-prompt', async data => {
    await api(`/tabularius/vaults/${vaultId}/prompt`, 'PUT', { prompt: data.get('prompt') });
    await refresh(); message(t('tabularius.promptSaved'));
  });
  document.getElementById('import-prompt')!.addEventListener('click', () => void run(async () => {
    const { prompt } = await api<{ prompt: string }>(`/tabularius/vaults/${vaultId}/prompt/import`, 'POST', {});
    document.querySelector<HTMLTextAreaElement>('#vault-prompt textarea')!.value = prompt;
    message(t('tabularius.imported'));
  }));
  document.getElementById('preview')!.addEventListener('toggle', event => void run(async () => {
    if (!(event.target as HTMLDetailsElement).open) return;
    const preview = await api<{ fixed: string; server: string; vault: string }>(`/tabularius/vaults/${vaultId}/prompt`);
    document.querySelector('#preview .preview-body')!.innerHTML = [[t('tabularius.previewServer'), preview.server], [t('tabularius.previewFixed'), preview.fixed], [t('tabularius.previewVault'), preview.vault]]
      .map(([title, text]) => `<h4>${escape(title)}</h4><pre class="prompt-text">${escape(text || '—')}</pre>`).join('');
  }));
  document.getElementById('vault-model')!.addEventListener('change', event => void run(async () => {
    const value = (event.target as HTMLSelectElement).value;
    await api(`/tabularius/vaults/${vaultId}/model`, 'PUT', { model: value || null });
    await refresh(); message(t('tabularius.saved'));
  }));
  document.getElementById('knowledge')?.addEventListener('change', event => void run(async () => {
    await api(`/tabularius/vaults/${vaultId}/knowledge`, 'PUT', { enabled: (event.target as HTMLInputElement).checked });
    await refresh(); message(t('tabularius.saved'));
  }));
  form('rules', async data => {
    await api(`/tabularius/vaults/${vaultId}/rules`, 'PUT', { excluded: data.get('excluded'), masks: data.get('masks') });
    await refresh(); message(t('tabularius.saved'));
  });
  document.getElementById('disable')!.addEventListener('click', () => void run(async () => {
    if (!await confirmAction({ title: t('tabularius.disable'), body: t('tabularius.confirmDisable', { name: current.name }), action: t('tabularius.disable'), danger: true, confirmName: current.name })) return;
    await api(`/tabularius/vaults/${vaultId}`, 'DELETE');
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
      void run(async () => { await api(`/tabularius/memories/${item.dataset.id}`, 'PUT', { content: new FormData(item).get('content') }); await showMemories(); message(t('tabularius.saved')); });
    });
    item.querySelector('[data-delete]')!.addEventListener('click', () => void run(async () => {
      if (!await confirmAction({ title: t('tabularius.deleteMemory'), body: t('tabularius.confirmDeleteMemory'), action: t('tabularius.deleteMemory'), danger: true })) return;
      await api(`/tabularius/memories/${item.dataset.id}`, 'DELETE'); await showMemories();
    }));
  }
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
    if (!await confirmAction({ title: t('tabularius.apply'), body: t('tabularius.confirmApply', { count: detail.files.length }), action: t('tabularius.apply') })) return;
    try { await api(`/tabularius/proposals/${detail.id}/apply`, 'POST'); } catch (error) { await showProposal(detail.id); throw error; }
    await showProposal(detail.id); message(t('tabularius.appliedMessage'));
  }));
}

function drawChat(current: VaultStatus) {
  const title = conversations.find(c => c.id === conversationId)?.title ?? (entries.length ? t('tabularius.newChat') : '');
  const composer = `<form id="ask" class="composer"><textarea name="message" rows="${entries.length ? 2 : 3}" placeholder="${t('tabularius.ask')}" aria-label="${t('tabularius.ask')}" required ${busy ? 'disabled' : ''}></textarea><div class="composer-bar"><small>${escape(current.name)}</small><button class="primary send" type="submit" aria-label="${t('tabularius.send')}" title="${t('tabularius.send')}" ${busy ? 'disabled' : ''}>${SEND_ICON}</button></div></form>`;
  // A new conversation starts in the middle of the page; once it has messages the box moves below them.
  const models = overview!.models;
  const picker = models.length ? `<select id="chat-model" class="compact" aria-label="${t('tabularius.model')}">${modelOptions(models, chat.model, chat.model ? undefined : t('tabularius.noModel'))}</select><button id="chat-settings" type="button">${t('tabularius.chatSettings')}</button>` : '';
  shell(`<header class="chat-top"><h1 class="chat-title">${escape(title)}</h1><div class="chat-tools">${picker}${syncPill(current)}${conversationId ? `<button id="delete" class="danger">${t('tabularius.deleteChat')}</button>` : ''}</div></header>
    ${current.indexError ? `<p class="notice error">${t('tabularius.indexError', { error: escape(current.indexError) })}</p>` : ''}
    ${entries.length ? `<section id="log" class="log" aria-live="polite">${entries.map(entryHtml).join('')}</section><div class="chat-bottom">${composer}</div>`
    : `<div class="chat-start"><div class="chat-start-inner"><h2 class="chat-hello">Tabularius</h2>${composer}</div></div><div id="log" hidden></div>`}`);
  const log = document.getElementById('log')!;
  log.scrollTop = log.scrollHeight;
  document.getElementById('chat-model')?.addEventListener('change', event => void run(async () => { await saveChat({ model: (event.target as HTMLSelectElement).value }); draw(); }));
  document.getElementById('chat-settings')?.addEventListener('click', chatSettings);
  document.getElementById('delete')?.addEventListener('click', () => void run(async () => {
    if (!await confirmAction({ title: t('tabularius.deleteChat'), body: t('tabularius.confirmDeleteChat'), action: t('tabularius.deleteChat'), danger: true })) return;
    await api(`/tabularius/conversations/${conversationId}`, 'DELETE');
    conversations = conversations.filter(c => c.id !== conversationId); conversationId = undefined; entries = []; newChat(); draw();
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
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': state.session!.csrf }, body: JSON.stringify(conversationId ? { message: text } : { message: text, model: chat.model || undefined, prompt: chat.prompt, params: chat.params }),
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
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-approve],[data-deny]');
  if (!button) return;
  const id = button.dataset.approve ?? button.dataset.deny!;
  button.disabled = true;
  void run(() => api(`/tabularius/approvals/${id}`, 'POST', { approved: Boolean(button.dataset.approve) }));
});

/** Draws Tabularius into the shell's content area; `?vault=` and `?conversation=` select what opens. */
export async function renderTabularius(content: HTMLElement) {
  app = content;
  const query = new URLSearchParams(location.search);
  if (query.get('vault')) vaultId = query.get('vault')!;
  view = 'chat';
  await load();
  const conversation = query.get('conversation');
  if (conversation) await openConversation(conversation);
}
