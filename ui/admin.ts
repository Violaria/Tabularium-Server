import { formatDate, hasMessage, languageSelect, serverError, t } from './i18n.js';
interface User { id: string; username: string; role: 'admin' | 'user'; disabled: boolean; mustChangePassword: boolean }
interface Rebuild { deviceId: string; until: number; started: number | null }
interface Vault { id: string; name: string; state: string; syncPath: string; ownerId?: string; owner?: string; rebuild: Rebuild | null }
interface Retired { name: string; retiredAt: number; partial: boolean; diskBytes: number }
interface Device { id: string; name: string; revoked: number; expiresAt: number }
interface Session { user: User; csrf: string }
interface Overview { users: number; activeUsers: number; vaults: number; devices: number; requests: number; proxyRequests: number; activeProxyConnections: number; uptimeSeconds: number }
interface Usage { diskBytes: number; activeBytes: number; documents: number; deletedDocuments: number }
interface KindleSettings { address: string | null; configured: boolean; from: string | null; domains: string[]; dailyLimit: number; sentToday: number }
interface Delivery { occurredAt: number; fileName: string; size: number; status: 'sent' | 'failed'; error: string | null }
interface Audit { id: number; occurredAt: number; actor: string; action: string; targetId: string }
const app = document.querySelector<HTMLDivElement>('#app')!;
let session: Session | undefined;
let section = 'overview';
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const brand = () => `<div class="brand"><span class="brand-mark">T</span><div><strong>Tabularium</strong><small>${t('brand.subtitle')}</small></div></div>`;
const bytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`;
const date = formatDate;
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-csrf-token': session.csrf } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, serverError(result.error));
  return result as T;
}
function message(text: string, error = false) {
  const target = document.querySelector<HTMLDivElement>('#message')!;
  target.className = error ? 'notice error' : 'notice'; target.textContent = text; target.hidden = false;
}
async function run(action: () => Promise<void>) {
  try { await action(); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401 && session) { session = undefined; login(); message(t('common.sessionExpired'), true); }
    else message(error instanceof Error ? error.message : t('common.failed'), true);
  }
}
function button(id: string, action: () => Promise<void>) {
  document.getElementById(id)!.addEventListener('click', event => {
    const control = event.currentTarget as HTMLButtonElement;
    control.disabled = true;
    void run(action).finally(() => { control.disabled = false; });
  });
}
function form(id: string, action: (data: FormData) => Promise<void>) {
  document.querySelector<HTMLFormElement>(`#${id}`)!.addEventListener('submit', event => {
    event.preventDefault(); const target = event.currentTarget as HTMLFormElement;
    const submit = target.querySelector<HTMLButtonElement>('button[type=submit]')!; submit.disabled = true;
    void run(() => action(new FormData(target))).finally(() => { submit.disabled = false; });
  });
}
const input = (label: string, name: string, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" required ${extra}></label>`;
function login() {
  app.innerHTML = `<div class="login-page"><div class="login-box">${brand()}<div class="card"><p class="eyebrow">${t('console.eyebrow')}</p><h1>${t('console.signInTitle')}</h1><p>${t('console.signInDesc')}</p><div id="message" role="status" hidden></div><form id="login" class="stack">${input(t('common.username'), 'username', 'text', 'autocomplete="username"')}${input(t('common.password'), 'password', 'password', 'autocomplete="current-password"')}<button class="primary" type="submit">${t('common.signIn')}</button></form></div><small>${t('console.accountsHint')}</small><div id="language"></div></div></div>`;
  mountLanguage(login);
  form('login', async data => {
    session = await api<Session>('/web-session', 'POST', Object.fromEntries(data));
    section = session.user.mustChangePassword ? 'password' : session.user.role === 'admin' ? 'overview' : 'vaults';
    await render();
  });
}
function shell(title: string, subtitle: string) {
  const user = session!.user;
  const items = user.mustChangePassword ? [['password', t('nav.changeInitialPassword')]] : [
    ...(user.role === 'admin' ? [['overview', t('nav.overview')]] : []), ['vaults', t('nav.vaults')], ['kindle', t('nav.kindle')],
    ...(user.role === 'admin' ? [['users', t('nav.users')], ['audit', t('nav.audit')]] : []), ['password', t('nav.password')],
  ];
  app.innerHTML = `<aside class="sidebar">${brand()}<nav aria-label="${t('console.navLabel')}">${items.map(([key, label]) => `<button data-section="${key}" ${key === section ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav><div class="account"><div><strong>${escape(user.username)}</strong><br><small>${user.role === 'admin' ? t('role.admin') : t('role.user')}</small></div><div id="language"></div><button id="logout">${t('common.signOut')}</button></div></aside><main class="main"><header class="page-head"><div><p class="eyebrow">${t('console.management')}</p><h1>${title}</h1><p>${subtitle}</p></div><button id="refresh">${t('common.refresh')}</button></header><div id="message" role="status" hidden></div><div id="content"></div></main>`;
  for (const nav of document.querySelectorAll<HTMLButtonElement>('[data-section]')) nav.addEventListener('click', () => {
    section = nav.dataset.section!; void run(render);
  });
  button('refresh', render);
  mountLanguage(() => void run(render));
  button('logout', async () => { await api('/web-session', 'DELETE'); session = undefined; login(); });
}
/** Puts the language selector into the page's #language slot. */
function mountLanguage(rerender: () => void) {
  document.getElementById('language')!.replaceChildren(languageSelect(() => { document.title = t('console.title'); rerender(); }));
}
function content(html: string) { document.getElementById('content')!.innerHTML = html; }
const badge = (state: string) => `<span class="badge ${state === 'ready' ? '' : 'warn'}">${(['ready', 'failed', 'provisioning'].includes(state) ? t(`state.${state}` as 'state.ready') : escape(state))}</span>`;
async function render() {
  if (!session) { login(); return; }
  if (session.user.mustChangePassword) section = 'password';
  if (section === 'password') { passwordPage(); return; }
  if (section === 'overview') await overviewPage();
  if (section === 'users') await usersPage();
  if (section === 'vaults') await vaultsPage();
  if (section === 'audit') await auditPage();
  if (section === 'kindle') await kindlePage();
}
async function kindlePage() {
  shell(t('nav.kindle'), t('kindle.desc'));
  const settings = await api<KindleSettings>('/me/kindle');
  const deliveries = await api<Delivery[]>('/me/kindle/deliveries');
  const setup = settings.configured
    ? `<p>${escape(t('kindle.setup', { from: '\u0000' })).replace('\u0000', `<strong class="mono">${escape(settings.from!)}</strong>`)}</p>`
    : `<div class="notice error">${t('kindle.notConfigured')}</div>`;
  content(`<section class="card"><h2>${t('kindle.addressTitle')}</h2>${setup}<form id="kindle-address" class="inline-form">${input(t('kindle.address'), 'address', 'email', `placeholder="name@kindle.com" value="${escape(settings.address ?? '')}"`).replace(' required', '')}<button class="primary" type="submit">${t('common.save')}</button>${settings.address && settings.configured ? `<button type="button" id="kindle-test">${t('kindle.test')}</button>` : ''}</form><small>${escape(t('kindle.usage', { domains: settings.domains.join(', '), sent: settings.sentToday, limit: settings.dailyLimit }))}</small></section><section class="card table-wrap"><h2>${t('kindle.history')}</h2>${deliveries.length ? `<table><thead><tr><th>${t('common.time')}</th><th>${t('kindle.file')}</th><th>${t('kindle.size')}</th><th>${t('kindle.result')}</th></tr></thead><tbody>${deliveries.map(d => `<tr><td>${date(d.occurredAt)}</td><td>${escape(d.fileName)}</td><td>${bytes(d.size)}</td><td>${d.status === 'sent' ? `<span class="badge">${t('kindle.sent')}</span>` : `<span class="badge warn">${t('kindle.failed')}</span> <small>${escape(d.error ?? '')}</small>`}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">${t('kindle.none')}</div>`}</section>`);
  form('kindle-address', async data => { await api('/me/kindle', 'PUT', Object.fromEntries(data)); await kindlePage(); message(t('kindle.saved')); });
  if (settings.address && settings.configured) button('kindle-test', async () => { await api('/me/kindle/test', 'POST', {}); await kindlePage(); message(t('kindle.testSent')); });
}
function passwordPage() {
  shell(session!.user.mustChangePassword ? t('password.initialTitle') : t('password.title'), t('password.desc'));
  content(`<section class="card"><form id="password" class="stack">${input(t('password.current'), 'currentPassword', 'password', 'autocomplete="current-password"')}${input(t('password.new'), 'password', 'password', 'minlength="12" autocomplete="new-password"')}${input(t('password.confirm'), 'confirmation', 'password', 'minlength="12" autocomplete="new-password"')}<small>${t('password.hint')}</small><button class="primary" type="submit">${t('password.save')}</button></form></section>`);
  form('password', async data => {
    if (data.get('password') !== data.get('confirmation')) { message(t('password.mismatch'), true); return; }
    await api('/me/password', 'PUT', { currentPassword: data.get('currentPassword'), password: data.get('password') });
    session!.user.mustChangePassword = false; section = session!.user.role === 'admin' ? 'overview' : 'vaults'; await render(); message(t('password.updated'));
  });
}
async function overviewPage() {
  shell(t('overview.title'), t('overview.desc'));
  const metrics = await api<Overview>('/admin/overview');
  const health = await fetch('/health/ready');
  content(`<div class="stats">${[[t('overview.accounts'), metrics.users], [t('overview.vaults'), metrics.vaults], [t('overview.devices'), metrics.devices], [t('overview.connections'), metrics.activeProxyConnections]].map(([name, value]) => `<div class="card stat"><span>${name}</span><strong>${value}</strong></div>`).join('')}</div><div class="split"><section class="card"><h2>${t('overview.service')}</h2><dl class="details"><dt>${t('overview.storage')}</dt><dd><span class="badge ${health.ok ? '' : 'warn'}">${health.ok ? t('overview.ok') : t('overview.down')}</span></dd><dt>${t('overview.uptime')}</dt><dd>${t('overview.minutes', { minutes: Math.floor(metrics.uptimeSeconds / 60) })}</dd><dt>${t('overview.activeUsers')}</dt><dd>${metrics.activeUsers}</dd></dl></section><section class="card"><h2>${t('overview.run')}</h2><dl class="details"><dt>${t('overview.requests')}</dt><dd>${metrics.requests}</dd><dt>${t('overview.proxyRequests')}</dt><dd>${metrics.proxyRequests}</dd></dl><small>${t('overview.countersHint')}</small></section></div>`);
}
async function usersPage() {
  shell(t('users.title'), t('users.desc'));
  const users = await api<User[]>('/users');
  content(`<section class="card"><h2>${t('users.create')}</h2><form id="create-user" class="inline-form">${input(t('common.username'), 'username', 'text', 'maxlength="128" autocomplete="off"')}${input(t('users.initialPassword'), 'password', 'password', 'minlength="12" autocomplete="new-password"')}<button type="submit" class="primary">${t('users.create')}</button></form><small>${t('users.createHint')}</small></section><section class="card table-wrap"><table><thead><tr><th>${t('common.username')}</th><th>${t('users.role')}</th><th>${t('common.status')}</th><th>${t('common.actions')}</th></tr></thead><tbody>${users.map(u => `<tr><td>${escape(u.username)}</td><td>${u.role === 'admin' ? t('role.admin') : t('role.user')}</td><td><span class="badge ${u.disabled ? 'off' : ''}">${u.disabled ? t('users.disabled') : t('users.enabled')}</span></td><td>${u.id === session!.user.id ? t('users.current') : `<button id="user-${u.id}" class="${u.disabled ? '' : 'danger'}">${u.disabled ? t('users.enable') : t('users.disable')}</button>`}</td></tr>`).join('')}</tbody></table></section>`);
  form('create-user', async data => { await api('/users', 'POST', Object.fromEntries(data)); await usersPage(); message(t('users.created')); });
  for (const user of users.filter(u => u.id !== session!.user.id)) button(`user-${user.id}`, async () => {
    if (!user.disabled && !confirm(t('users.confirmDisable', { name: user.username }))) return;
    await api(`/users/${user.id}`, 'PATCH', { disabled: !user.disabled }); await usersPage();
  });
}
async function vaultsPage() {
  shell(t('vaults.title'), t('vaults.desc'));
  const admin = session!.user.role === 'admin';
  const vaults = await api<Vault[]>(admin ? '/admin/vaults' : '/vaults');
  const users = admin ? await api<User[]>('/users') : [];
  content(`<section class="card"><h2>${t('vaults.create')}</h2><form id="create-vault" class="inline-form">${input(t('vaults.name'), 'name', 'text', 'maxlength="128"')}${admin ? `<label><span id="owner-label">${t('vaults.owner')}</span><select name="ownerId" aria-labelledby="owner-label">${users.filter(u => !u.disabled).map(u => `<option value="${u.id}">${escape(u.username)}</option>`).join('')}</select></label>` : ''}<button class="primary" type="submit">${t('vaults.create')}</button></form></section><section class="card table-wrap">${vaults.length ? `<table><thead><tr><th>${t('vaults.vault')}</th>${admin ? `<th>${t('vaults.owner')}</th>` : ''}<th>${t('common.status')}</th><th>${t('common.actions')}</th></tr></thead><tbody>${vaults.map(v => `<tr><td><button class="link" id="vault-${v.id}">${escape(v.name)}</button></td>${admin ? `<td>${escape(v.owner!)}</td>` : ''}<td>${badge(v.state)}</td><td><button id="details-${v.id}">${t('vaults.devices')}</button></td></tr>`).join('')}</tbody></table>` : `<div class="empty">${t('vaults.none')}</div>`}</section>`);
  form('create-vault', async data => { await api(admin ? '/admin/vaults' : '/vaults', 'POST', Object.fromEntries(data)); await vaultsPage(); message(t('vaults.created')); });
  for (const vault of vaults) for (const prefix of ['vault-', 'details-']) button(prefix + vault.id, () => vaultPage(vault));
}
async function vaultPage(vault: Vault) {
  shell(escape(vault.name), t('vault.desc'));
  const admin = session!.user.role === 'admin';
  const owner = !admin || vault.ownerId === session!.user.id;
  const base = `${admin ? '/admin' : ''}/vaults/${vault.id}`;
  const devices = await api<Device[]>(`${base}/devices`);
  const rebuildCard = owner && vault.state === 'ready' ? await rebuildSection(vault.id, devices) : '';
  content(`<div class="actions"><button id="back">${t('vault.back')}</button></div><br><section class="card"><h2>${t('vault.connection')}</h2><dl class="details"><dt>${t('vault.syncAddress')}</dt><dd>${escape(location.origin)}/sync</dd><dt>${t('vault.id')}</dt><dd class="mono">${vault.id}</dd><dt>${t('common.status')}</dt><dd>${badge(vault.state)}</dd></dl><p>${t('vault.clientHint')}</p>${vault.state !== 'ready' ? `<button id="retry">${t('vault.retry')}</button>` : ''}${admin ? `<button id="usage">${t('vault.usage')}</button><div id="usage-result"></div>` : ''}</section>${owner && vault.state === 'ready' ? `<section class="card"><h2>${t('vault.addDevice')}</h2><form id="issue-device" class="inline-form">${input(t('vault.deviceName'), 'name', 'text', `placeholder="${escape(t('vault.devicePlaceholder'))}" maxlength="128"`)}<button class="primary" type="submit">${t('vault.issue')}</button></form></section>` : `<p>${t('vault.ownerIssues')}</p>`}<div id="new-secret"></div><section class="card table-wrap"><h2>${t('vault.deviceList')}</h2>${devices.length ? `<table><thead><tr><th>${t('vault.device')}</th><th>${t('common.status')}</th><th>${t('vault.expires')}</th><th>${t('common.actions')}</th></tr></thead><tbody>${devices.map(d => `<tr><td>${escape(d.name)}</td><td><span class="badge ${d.revoked || d.expiresAt <= Date.now() ? 'off' : ''}">${d.revoked ? t('vault.revoked') : d.expiresAt <= Date.now() ? t('vault.expired') : t('vault.active')}</span></td><td>${date(d.expiresAt)}</td><td>${d.revoked ? '—' : `<button class="danger" id="revoke-${d.id}">${t('vault.revoke')}</button>`}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">${t('vault.noDevices')}</div>`}</section>${rebuildCard}`);
  button('back', vaultsPage);
  if (rebuildCard) bindRebuild(vault, devices);
  if (vault.state !== 'ready') button('retry', async () => { await api(`${base}/provision`, 'POST', {}); await vaultsPage(); });
  if (admin) button('usage', async () => {
    const usage = await api<Usage>(`${base}/usage`);
    document.getElementById('usage-result')!.innerHTML = `<br><dl class="details"><dt>${t('vault.diskUsage')}</dt><dd>${bytes(usage.diskBytes)}</dd><dt>${t('vault.activeData')}</dt><dd>${bytes(usage.activeBytes)}</dd><dt>${t('vault.documents')}</dt><dd>${usage.documents}</dd></dl><small>${t('vault.usageHint')}</small>`;
  });
  if (owner && vault.state === 'ready') form('issue-device', async data => {
    const credential = await api<{ username: string; password: string; expiresAt: number }>(`/vaults/${vault.id}/devices`, 'POST', Object.fromEntries(data));
    await vaultPage(vault);
    const target = document.getElementById('new-secret')!;
    target.innerHTML = `<section class="card secret"><h2>${t('vault.saveCredentials')}</h2><p>${t('vault.onlyOnce')}</p><div class="stack"><label>${t('vault.deviceUser')}<input readonly id="credential-user"></label><label>${t('vault.devicePassword')}<input readonly id="credential-password"></label><small>${t('vault.validUntil', { date: date(credential.expiresAt) })}</small><button id="close-secret">${t('vault.closeSecret')}</button></div></section>`;
    document.querySelector<HTMLInputElement>('#credential-user')!.value = credential.username;
    document.querySelector<HTMLInputElement>('#credential-password')!.value = credential.password;
    button('close-secret', async () => { target.replaceChildren(); });
  });
  for (const device of devices.filter(d => !d.revoked)) button(`revoke-${device.id}`, async () => {
    if (!confirm(t('vault.confirmRevoke', { name: device.name }))) return;
    await api(`${base}/devices/${device.id}`, 'DELETE'); await vaultPage(vault);
  });
}
let retired: Retired[] = [];
let rebuild: Rebuild | null = null;
async function rebuildSection(vaultId: string, devices: Device[]) {
  rebuild = (await api<Vault>(`/vaults/${vaultId}`)).rebuild;
  retired = await api<Retired[]>(`/vaults/${vaultId}/databases`);
  const active = devices.filter(d => !d.revoked && d.expiresAt > Date.now());
  const deviceName = (id: string) => escape(devices.find(d => d.id === id)?.name ?? id);
  const status = rebuild
    ? `<dl class="details"><dt>${t('rebuild.device')}</dt><dd>${deviceName(rebuild.deviceId)}</dd><dt>${t('rebuild.until')}</dt><dd>${date(rebuild.until)}</dd><dt>${t('common.status')}</dt><dd>${rebuild.started ? t('rebuild.running') : t('rebuild.waiting')}</dd></dl><button id="rebuild-end">${t('rebuild.end')}</button>`
    : active.length
      ? `<form id="rebuild-arm" class="inline-form"><label><span id="rebuild-device-label">${t('rebuild.deviceLabel')}</span><select name="deviceId" aria-labelledby="rebuild-device-label">${active.map(d => `<option value="${d.id}">${escape(d.name)}</option>`).join('')}</select></label>${input(t('rebuild.confirmName'), 'confirm', 'text', 'autocomplete="off" maxlength="128"')}<button class="primary" type="submit">${t('rebuild.arm')}</button></form>`
      : `<div class="empty">${t('rebuild.noDevices')}</div>`;
  const revertTarget = retired.find(r => !r.partial);
  const list = retired.length ? `<h3>${t('rebuild.retired')}</h3><table><thead><tr><th>${t('rebuild.retiredAt')}</th><th>${t('rebuild.size')}</th><th>${t('rebuild.content')}</th><th>${t('common.actions')}</th></tr></thead><tbody>${retired.map((r, i) => `<tr><td>${date(r.retiredAt)}</td><td>${bytes(r.diskBytes)}</td><td>${r.partial ? t('rebuild.partial') : t('rebuild.complete')}</td><td>${r === revertTarget ? `<button id="rebuild-revert">${t('rebuild.revert')}</button> ` : ''}<button class="danger" id="retired-${i}">${t('rebuild.delete')}</button></td></tr>`).join('')}</tbody></table>` : '';
  return `<section class="card table-wrap"><h2>${t('rebuild.title')}</h2><p>${t('rebuild.desc')}</p>${status}${list}</section>`;
}
function bindRebuild(vault: Vault, devices: Device[]) {
  const reload = () => vaultPage(vault);
  if (rebuild) button('rebuild-end', async () => {
    if (rebuild!.started && !confirm(t('rebuild.confirmEnd'))) return;
    await api(`/vaults/${vault.id}/rebuild`, 'DELETE'); await reload(); message(t('rebuild.ended'));
  });
  else if (devices.some(d => !d.revoked && d.expiresAt > Date.now())) form('rebuild-arm', async data => {
    await api(`/vaults/${vault.id}/rebuild`, 'POST', Object.fromEntries(data)); await reload(); message(t('rebuild.armed'));
  });
  if (retired.some(r => !r.partial)) button('rebuild-revert', async () => {
    const name = prompt(t('rebuild.promptRevert'));
    if (name === null) return;
    await api(`/vaults/${vault.id}/rebuild/revert`, 'POST', { confirm: name }); await reload(); message(t('rebuild.reverted'));
  });
  retired.forEach((r, i) => button(`retired-${i}`, async () => {
    if (!confirm(t('rebuild.confirmDelete'))) return;
    await api(`/vaults/${vault.id}/databases/${r.name}`, 'DELETE'); await reload(); message(t('rebuild.deleted'));
  }));
}
const actionName = (action: string) => {
  const key = `action.${action}`;
  return hasMessage(key) ? t(key) : action;
};
async function auditPage() {
  shell(t('audit.title'), t('audit.desc'));
  const events = await api<Audit[]>('/admin/audit');
  content(`<section class="card table-wrap"><table><thead><tr><th>${t('common.time')}</th><th>${t('audit.actor')}</th><th>${t('audit.action')}</th><th>${t('audit.target')}</th></tr></thead><tbody>${events.map(event => `<tr><td>${date(event.occurredAt)}</td><td>${escape(event.actor)}</td><td>${escape(actionName(event.action))}</td><td class="mono">${escape(event.targetId)}</td></tr>`).join('')}</tbody></table></section>`);
}
document.title = t('console.title');
login();
void run(async () => {
  try { session = await api<Session>('/web-session'); }
  catch (error) { if (error instanceof ApiError && error.status === 401) return; throw error; }
  section = session.user.role === 'admin' ? 'overview' : 'vaults'; await render();
});
