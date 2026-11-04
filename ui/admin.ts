// Administration, for administrators only: overview, accounts, every vault, and the audit log. The server refuses these
// routes to other users; the shell does not offer the module to them.
import { shareTable, type ShareRow } from './shares.js';
import { renderAiSettings } from './ai.js';
import { renderServerSettings } from './server-settings.js';
import { renderBackups } from './backups.js';
import { formatDate, hasMessage, t } from './i18n.js';
import { api, button, bytes, confirmAction, escape, form, input, message, page, state, tip, type User } from './core.js';
import { badge, deviceTable, usableDevice, type Device, type Vault } from './account.js';

interface Overview { users: number; activeUsers: number; vaults: number; devices: number; requests: number; proxyRequests: number; activeProxyConnections: number; uptimeSeconds: number; backupFailure: { at: number; error: string } | null }
interface Usage { diskBytes: number; activeBytes: number; documents: number; deletedDocuments: number }
interface Audit { id: number; occurredAt: number; actor: string; action: string; targetId: string }

const date = formatDate;
const tabs = (): [string, string][] => [['/admin/', t('nav.overview')], ['/admin/users', t('nav.users')], ['/admin/vaults', t('nav.vaults')], ['/admin/shares', t('shares.all')], ['/admin/ai', t('nav.ai')], ['/admin/settings', t('nav.serverSettings')], ['/admin/backups', t('nav.backups')], ['/admin/audit', t('nav.audit')]];
const frame = (content: HTMLElement) => page(content, { title: t('nav.admin'), subtitle: t('admin.desc'), tabs: tabs() });

export async function renderAdmin(content: HTMLElement, path: string) {
  if (state.session!.user.role !== 'admin') {
    page(content, { title: t('nav.admin') }).innerHTML = `<section class="card"><h2>${t('admin.forbidden')}</h2><p>${t('admin.forbiddenHint')}</p></section>`;
    return;
  }
  const vault = path.match(/^\/admin\/vaults\/([^/]+)/)?.[1];
  if (vault) await vaultPage(content, vault);
  else if (path.startsWith('/admin/users')) await usersPage(content);
  else if (path.startsWith('/admin/vaults')) await vaultsPage(content);
  else if (path.startsWith('/admin/audit')) await auditPage(content);
  else if (path.startsWith('/admin/shares')) await sharesPage(content);
  else if (path.startsWith('/admin/ai')) await renderAiSettings(frame(content));
  else if (path.startsWith('/admin/settings')) await renderServerSettings(frame(content));
  else if (path.startsWith('/admin/backups')) await renderBackups(frame(content));
  else await overviewPage(content);
}

async function overviewPage(content: HTMLElement) {
  const body = frame(content);
  const metrics = await api<Overview>('/admin/overview');
  const health = await fetch('/health/ready');
  body.innerHTML = (metrics.backupFailure ? `<p class="notice error">${t('overview.backupFailed', { date: date(metrics.backupFailure.at), error: escape(metrics.backupFailure.error) })} <a href="/admin/backups" data-route>${t('nav.backups')}</a></p>` : '')
    + `<div class="stats">${[[t('overview.accounts'), metrics.users], [t('overview.vaults'), metrics.vaults], [t('overview.devices'), metrics.devices], [t('overview.connections'), metrics.activeProxyConnections]].map(([name, value]) => `<div class="card stat"><span>${name}</span><strong>${value}</strong></div>`).join('')}</div><div class="split"><section class="card"><h2>${t('overview.service')}</h2><dl class="details"><dt>${t('overview.storage')}</dt><dd><span class="badge ${health.ok ? '' : 'warn'}">${health.ok ? t('overview.ok') : t('overview.down')}</span></dd><dt>${t('overview.uptime')}</dt><dd>${t('overview.minutes', { minutes: Math.floor(metrics.uptimeSeconds / 60) })}</dd><dt>${t('overview.activeUsers')}</dt><dd>${metrics.activeUsers}</dd></dl></section><section class="card"><h2>${t('overview.run')}${tip(t('overview.countersHint'))}</h2><dl class="details"><dt>${t('overview.requests')}</dt><dd>${metrics.requests}</dd><dt>${t('overview.proxyRequests')}</dt><dd>${metrics.proxyRequests}</dd></dl><br></section></div>`;
}

async function usersPage(content: HTMLElement) {
  const body = frame(content);
  const users = await api<User[]>('/users');
  const self = state.session!.user.id;
  body.innerHTML = `<section class="card table-wrap"><table><thead><tr><th>${t('common.username')}</th><th>${t('users.role')}</th><th>${t('common.status')}</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td>${escape(u.username)}</td><td>${u.role === 'admin' ? t('role.admin') : t('role.user')}</td><td><span class="badge ${u.disabled ? 'off' : ''}">${u.disabled ? t('users.disabled') : t('users.enabled')}</span></td><td class="right">${u.id === self ? `<span class="muted">${t('users.current')}</span>` : `<button id="user-${u.id}" class="${u.disabled ? '' : 'danger'}">${u.disabled ? t('users.enable') : t('users.disable')}</button>`}</td></tr>`).join('')}</tbody></table></section><section class="card"><h2>${t('users.create')}${tip(t('users.createHint'))}</h2><form id="create-user" class="inline-form">${input(t('common.username'), 'username', 'text', 'maxlength="128" autocomplete="off"')}${input(t('users.initialPassword'), 'password', 'password', 'minlength="12" autocomplete="new-password"')}<button type="submit" class="primary">${t('users.create')}</button></form></section>`;
  form('create-user', async data => { await api('/users', 'POST', Object.fromEntries(data)); await usersPage(content); message(t('users.created')); });
  for (const user of users.filter(u => u.id !== self)) button(`user-${user.id}`, async () => {
    if (!user.disabled && !await confirmAction({ title: t('users.disableTitle', { name: user.username }), body: t('users.confirmDisable', { name: user.username }), action: t('users.disable'), danger: true })) return;
    await api(`/users/${user.id}`, 'PATCH', { disabled: !user.disabled }); await usersPage(content);
  });
}

async function vaultsPage(content: HTMLElement) {
  const body = frame(content);
  const vaults = await api<Vault[]>('/admin/vaults');
  const users = await api<User[]>('/users');
  body.innerHTML = `<section class="card table-wrap">${vaults.length ? `<table><thead><tr><th>${t('vaults.vault')}</th><th>${t('vaults.owner')}</th><th>${t('common.status')}</th></tr></thead><tbody>${vaults.map(v => `<tr><td><a href="/admin/vaults/${v.id}" data-route>${escape(v.name)}</a></td><td>${escape(v.owner!)}</td><td>${badge(v.state)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">${t('vaults.none')}</div>`}</section><section class="card"><h2>${t('vaults.create')}</h2><form id="create-vault" class="inline-form">${input(t('vaults.name'), 'name', 'text', 'maxlength="128"')}<label><span id="owner-label">${t('vaults.owner')}</span><select name="ownerId" aria-labelledby="owner-label">${users.filter(u => !u.disabled).map(u => `<option value="${u.id}">${escape(u.username)}</option>`).join('')}</select></label><button class="primary" type="submit">${t('vaults.create')}</button></form></section>`;
  form('create-vault', async data => { await api('/admin/vaults', 'POST', Object.fromEntries(data)); await vaultsPage(content); message(t('vaults.created')); });
}

/** An administrator's view of any vault: owner, devices and storage. Owners manage their own vaults in account settings. */
async function vaultPage(content: HTMLElement, id: string) {
  const vault = (await api<Vault[]>('/admin/vaults')).find(v => v.id === id);
  if (!vault) { frame(content).innerHTML = `<div class="empty">${t('vaults.none')}</div>`; return; }
  const body = page(content, { title: vault.name, subtitle: t('admin.vaultDesc', { owner: vault.owner ?? '' }), tabs: tabs(), back: { href: '/admin/vaults', label: t('vault.back') } });
  const base = `/admin/vaults/${id}`;
  const devices = await api<Device[]>(`${base}/devices`);
  const own = vault.ownerId === state.session!.user.id;
  body.innerHTML = `<section class="card"><dl class="details"><dt>${t('vaults.owner')}</dt><dd>${escape(vault.owner ?? '')}</dd><dt>${t('vault.id')}</dt><dd class="mono">${vault.id}</dd><dt>${t('common.status')}</dt><dd>${badge(vault.state)}</dd></dl><br><div class="actions"><button id="usage">${t('vault.usage')}</button>${own ? `<a class="button" href="/account/vaults/${id}" data-route>${t('admin.manageOwn')}</a>` : ''}</div><div id="usage-result"></div></section><section class="card table-wrap"><h2>${t('vault.deviceList')}</h2>${deviceTable(devices, true)}</section>`;
  button('usage', async () => {
    const usage = await api<Usage>(`${base}/usage`);
    document.getElementById('usage-result')!.innerHTML = `<br><dl class="details"><dt>${t('vault.diskUsage')}</dt><dd>${bytes(usage.diskBytes)}</dd><dt>${t('vault.activeData')}</dt><dd>${bytes(usage.activeBytes)}</dd><dt>${t('vault.documents')}</dt><dd>${usage.documents}</dd></dl><br>${tip(t('vault.usageHint'))}`;
  });
  for (const device of devices.filter(usableDevice)) button(`revoke-${device.id}`, async () => {
    if (!await confirmAction({ title: t('vault.revokeTitle', { name: device.name }), body: t('vault.revokeBody'), action: t('vault.revoke'), danger: true })) return;
    await api(`${base}/devices/${device.id}`, 'DELETE'); await vaultPage(content, id);
  });
}

const actionName = (action: string) => { const key = `action.${action}`; return hasMessage(key) ? t(key) : action; };
async function sharesPage(content: HTMLElement) {
  const body = frame(content);
  const shares = await api<ShareRow[]>('/admin/shares');
  shareTable(body, shares, share => share.vault ?? '', true, () => sharesPage(content));
}
async function auditPage(content: HTMLElement) {
  const body = frame(content);
  const events = await api<Audit[]>('/admin/audit');
  body.innerHTML = `<section class="card table-wrap"><table><thead><tr><th>${t('common.time')}</th><th>${t('audit.actor')}</th><th>${t('audit.action')}</th><th>${t('audit.target')}</th></tr></thead><tbody>${events.map(event => `<tr><td>${date(event.occurredAt)}</td><td>${escape(event.actor)}</td><td>${escape(actionName(event.action))}</td><td class="mono">${escape(event.targetId)}</td></tr>`).join('')}</tbody></table></section>`;
}
