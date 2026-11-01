// Account settings, open to every user: own vaults and devices (issue, revoke, rebuild, unlock), Kindle, password.
import { formatDate, languageSelect, t } from './i18n.js';
import { shareTable, type ShareRow } from './shares.js';
import { ago, api, applyTheme, button, bytes, confirmAction, DEFAULT_THEME, escape, form, input, message, navigate, page, RECIPES, state, THEMES, tip, type Recipe } from './core.js';

interface Rebuild { deviceId: string; until: number; started: number | null }
export interface Vault { id: string; name: string; state: string; ownerId?: string; owner?: string; rebuild: Rebuild | null }
interface Retired { name: string; retiredAt: number; partial: boolean; diskBytes: number }
export interface Device { id: string; name: string; revoked: number; expiresAt: number; lastSeenAt: number | null }
interface KindleSettings { address: string | null; configured: boolean; from: string | null; domains: string[]; dailyLimit: number; sentToday: number }
interface Delivery { occurredAt: number; fileName: string; size: number; status: 'sent' | 'failed'; error: string | null }

const date = formatDate;
export const when = (value: number) => ago(value, formatDate, {
  now: t('time.now'), minutes: n => t('time.minutes', { n }), hours: n => t('time.hours', { n }), days: n => t('time.days', { n }),
});
export const badge = (value: string) =>
  `<span class="badge ${value === 'ready' ? '' : 'warn'}">${(['ready', 'failed', 'provisioning'].includes(value) ? t(`state.${value}` as 'state.ready') : escape(value))}</span>`;
const tabs = (): [string, string][] => [['/account/', t('account.vaults')], ['/account/interface', t('account.interface')], ['/account/shares', t('shares.mine')], ['/account/kindle', t('nav.kindle')], ['/account/password', t('nav.password')]];
const frame = (content: HTMLElement) => page(content, { title: t('account.title'), subtitle: t('account.desc'), tabs: tabs() });

export async function renderAccount(content: HTMLElement, path: string) {
  const vault = path.match(/^\/account\/vaults\/([^/]+)/)?.[1];
  if (vault) await vaultPage(content, vault);
  else if (path.startsWith('/account/kindle')) await kindlePage(content);
  else if (path.startsWith('/account/shares')) await sharesPage(content);
  else if (path.startsWith('/account/password')) passwordPage(content);
  else if (path.startsWith('/account/interface') || path.startsWith('/account/appearance')) interfacePage(content);
  else await vaultsPage(content);
}

async function vaultsPage(content: HTMLElement) {
  const body = frame(content);
  const vaults = await api<Vault[]>('/vaults');
  body.innerHTML = `<section class="card table-wrap">${vaults.length ? `<table><thead><tr><th>${t('vaults.vault')}</th><th>${t('common.status')}</th><th></th></tr></thead><tbody>${vaults.map(v => `<tr><td><a href="/account/vaults/${v.id}" data-route>${escape(v.name)}</a></td><td>${badge(v.state)}</td><td class="right"><a href="/account/vaults/${v.id}" data-route>${t('vaults.devices')}</a></td></tr>`).join('')}</tbody></table>` : `<div class="empty">${t('vaults.none')}</div>`}</section><section class="card"><h2>${t('vaults.create')}${tip(t('account.createHint'))}</h2><form id="create-vault" class="inline-form">${input(t('vaults.name'), 'name', 'text', 'maxlength="128"')}<button class="primary" type="submit">${t('vaults.create')}</button></form></section>`;
  form('create-vault', async data => { await api('/vaults', 'POST', Object.fromEntries(data)); await vaultsPage(content); message(t('vaults.created')); });
}

/** Devices that can still synchronise, with when they last did; revoked and expired ones are folded away below. */
export function deviceTable(devices: Device[], revocable: boolean) {
  const usable = (d: Device) => !d.revoked && d.expiresAt > Date.now();
  const active = devices.filter(usable), inactive = devices.filter(d => !usable(d));
  const seen = (d: Device) => d.lastSeenAt ? escape(when(d.lastSeenAt)) : `<span class="muted">${t('home.neverSynced')}</span>`;
  const table = active.length
    ? `<table><thead><tr><th>${t('vault.device')}</th><th>${t('account.lastSync')}</th><th>${t('vault.expires')}</th>${revocable ? '<th></th>' : ''}</tr></thead><tbody>${active.map(d => `<tr><td>${escape(d.name)}</td><td>${seen(d)}</td><td>${date(d.expiresAt)}</td>${revocable ? `<td class="right"><button class="danger" id="revoke-${d.id}">${t('vault.revoke')}</button></td>` : ''}</tr>`).join('')}</tbody></table>`
    : `<div class="empty">${t('vault.noDevices')}</div>`;
  const folded = inactive.length
    ? `<details class="inactive"><summary>${t('vault.inactiveDevices', { count: String(inactive.length) })}</summary><table><thead><tr><th>${t('vault.device')}</th><th>${t('common.status')}</th><th>${t('vault.expires')}</th></tr></thead><tbody>${inactive.map(d => `<tr><td>${escape(d.name)}</td><td><span class="badge off">${d.revoked ? t('vault.revoked') : t('vault.expired')}</span></td><td>${date(d.expiresAt)}</td></tr>`).join('')}</tbody></table></details>`
    : '';
  return table + folded;
}

async function vaultPage(content: HTMLElement, id: string) {
  const vault = await api<Vault>(`/vaults/${id}`);
  const body = page(content, { title: vault.name, subtitle: t('vault.desc'), tabs: tabs(), back: { href: '/account/', label: t('vault.back') } });
  const devices = await api<Device[]>(`/vaults/${id}/devices`);
  const rebuildCard = vault.state === 'ready' ? await rebuildSection(vault, devices) : '';
  body.innerHTML = `<section class="card"><h2>${t('vault.connection')}</h2><dl class="details"><dt>${t('vault.syncAddress')}</dt><dd>${escape(location.origin)}/sync</dd><dt>${t('vault.id')}</dt><dd class="mono">${vault.id}</dd><dt>${t('common.status')}</dt><dd>${badge(vault.state)}</dd></dl>${vault.state !== 'ready' ? `<br><button id="retry">${t('vault.retry')}</button>` : ''}</section><div id="new-secret"></div><section class="card table-wrap"><h2>${t('vault.deviceList')}</h2>${deviceTable(devices, true)}</section>${vault.state === 'ready' ? `<section class="card"><h2>${t('vault.addDevice')}${tip(t('vault.clientHint'))}</h2><form id="issue-device" class="inline-form">${input(t('vault.deviceName'), 'name', 'text', `placeholder="${escape(t('vault.devicePlaceholder'))}" maxlength="128"`)}<button class="primary" type="submit">${t('vault.issue')}</button></form></section>` : ''}${rebuildCard}`;
  const reload = () => vaultPage(content, id);
  if (vault.state !== 'ready') button('retry', async () => { await api(`/vaults/${id}/provision`, 'POST', {}); await reload(); });
  if (vault.state === 'ready') form('issue-device', async data => {
    const credential = await api<{ username: string; password: string; expiresAt: number }>(`/vaults/${id}/devices`, 'POST', Object.fromEntries(data));
    await reload();
    const target = document.getElementById('new-secret')!;
    target.innerHTML = `<section class="card secret"><h2>${t('vault.saveCredentials')}</h2><p>${t('vault.onlyOnce')}</p><div class="stack"><label>${t('vault.deviceUser')}<input readonly id="credential-user"></label><label>${t('vault.devicePassword')}<input readonly id="credential-password"></label><small>${t('vault.validUntil', { date: date(credential.expiresAt) })}</small><button id="close-secret">${t('vault.closeSecret')}</button></div></section>`;
    document.querySelector<HTMLInputElement>('#credential-user')!.value = credential.username;
    document.querySelector<HTMLInputElement>('#credential-password')!.value = credential.password;
    button('close-secret', async () => { target.replaceChildren(); });
  });
  for (const device of devices.filter(d => !d.revoked && d.expiresAt > Date.now())) button(`revoke-${device.id}`, async () => {
    if (!await confirmAction({ title: t('vault.revokeTitle', { name: device.name }), body: t('vault.revokeBody'), action: t('vault.revoke'), danger: true })) return;
    await api(`/vaults/${id}/devices/${device.id}`, 'DELETE'); await reload();
  });
  if (rebuildCard) bindRebuild(vault, devices, reload);
}

let retired: Retired[] = [];
let locked = false;
async function rebuildSection(vault: Vault, devices: Device[]) {
  retired = await api<Retired[]>(`/vaults/${vault.id}/databases`);
  locked = (await api<{ locked: boolean }>(`/vaults/${vault.id}/rebuild/lock`)).locked;
  const rebuild = vault.rebuild;
  const active = devices.filter(d => !d.revoked && d.expiresAt > Date.now());
  const deviceName = (id: string) => escape(devices.find(d => d.id === id)?.name ?? id);
  const status = rebuild
    ? `<dl class="details"><dt>${t('rebuild.device')}</dt><dd>${deviceName(rebuild.deviceId)}</dd><dt>${t('rebuild.until')}</dt><dd>${date(rebuild.until)}</dd><dt>${t('common.status')}</dt><dd>${rebuild.started ? t('rebuild.running') : t('rebuild.waiting')}</dd></dl><br><button id="rebuild-end">${t('rebuild.end')}</button>`
    : active.length
      ? `<form id="rebuild-arm" class="inline-form"><label><span id="rebuild-device-label">${t('rebuild.deviceLabel')}</span><select name="deviceId" aria-labelledby="rebuild-device-label">${active.map(d => `<option value="${d.id}">${escape(d.name)}</option>`).join('')}</select></label><button class="primary" type="submit">${t('rebuild.arm')}</button></form>`
      : `<div class="empty">${t('rebuild.noDevices')}</div>`;
  const revertTarget = retired.find(r => !r.partial);
  const list = retired.length ? `<h3 class="spaced">${t('rebuild.retired')}</h3><table><thead><tr><th>${t('rebuild.retiredAt')}</th><th>${t('rebuild.size')}</th><th>${t('rebuild.content')}</th><th></th></tr></thead><tbody>${retired.map((r, i) => `<tr><td>${date(r.retiredAt)}</td><td>${bytes(r.diskBytes)}</td><td>${r.partial ? t('rebuild.partial') : t('rebuild.complete')}</td><td class="right">${r === revertTarget ? `<button id="rebuild-revert">${t('rebuild.revert')}</button> ` : ''}<button class="danger" id="retired-${i}">${t('rebuild.delete')}</button></td></tr>`).join('')}</tbody></table>` : '';
  const lock = locked && !rebuild?.started ? `<div class="notice warn"><p>${t('rebuild.locked')}</p><button id="rebuild-unlock">${t('rebuild.unlock')}</button></div>` : '';
  return `<section class="card table-wrap"><h2>${t('rebuild.title')}${tip(t('rebuild.desc'))}</h2>${lock}${status}${list}</section>`;
}
function bindRebuild(vault: Vault, devices: Device[], reload: () => Promise<void>) {
  const rebuild = vault.rebuild;
  if (locked && !rebuild?.started) button('rebuild-unlock', async () => {
    if (!await confirmAction({ title: t('rebuild.unlockTitle'), body: t('rebuild.confirmUnlock'), action: t('rebuild.unlock') })) return;
    await api(`/vaults/${vault.id}/rebuild/lock`, 'DELETE'); await reload(); message(t('rebuild.unlocked'));
  });
  if (rebuild) button('rebuild-end', async () => {
    if (rebuild.started && !await confirmAction({ title: t('rebuild.end'), body: t('rebuild.confirmEnd'), action: t('rebuild.end'), danger: true })) return;
    await api(`/vaults/${vault.id}/rebuild`, 'DELETE'); await reload(); message(t('rebuild.ended'));
  });
  else if (devices.some(d => !d.revoked && d.expiresAt > Date.now())) form('rebuild-arm', async data => {
    const device = devices.find(d => d.id === data.get('deviceId'));
    if (!await confirmAction({ title: t('rebuild.armTitle'), body: t('rebuild.armBody', { device: device?.name ?? '' }), action: t('rebuild.arm'), danger: true, confirmName: vault.name })) return;
    await api(`/vaults/${vault.id}/rebuild`, 'POST', { deviceId: data.get('deviceId'), confirm: vault.name }); await reload(); message(t('rebuild.armed'));
  });
  if (retired.some(r => !r.partial)) button('rebuild-revert', async () => {
    if (!await confirmAction({ title: t('rebuild.revert'), body: t('rebuild.revertBody'), action: t('rebuild.revert'), danger: true, confirmName: vault.name })) return;
    await api(`/vaults/${vault.id}/rebuild/revert`, 'POST', { confirm: vault.name }); await reload(); message(t('rebuild.reverted'));
  });
  retired.forEach((r, i) => button(`retired-${i}`, async () => {
    if (!await confirmAction({ title: t('rebuild.delete'), body: t('rebuild.confirmDelete'), action: t('rebuild.delete'), danger: true })) return;
    await api(`/vaults/${vault.id}/databases/${r.name}`, 'DELETE'); await reload(); message(t('rebuild.deleted'));
  }));
}

async function kindlePage(content: HTMLElement) {
  const body = frame(content);
  const settings = await api<KindleSettings>('/me/kindle');
  const deliveries = await api<Delivery[]>('/me/kindle/deliveries');
  const setup = settings.configured
    ? `<p>${escape(t('kindle.setup', { from: '\u0000' })).replace('\u0000', `<strong class="mono">${escape(settings.from!)}</strong>`)}</p>`
    : `<div class="notice error">${t('kindle.notConfigured')}</div>`;
  body.innerHTML = `<section class="card"><h2>${t('kindle.addressTitle')}</h2>${setup}<form id="kindle-address" class="inline-form">${input(t('kindle.address'), 'address', 'email', `placeholder="name@kindle.com" value="${escape(settings.address ?? '')}"`).replace(' required', '')}<button class="primary" type="submit">${t('common.save')}</button>${settings.address && settings.configured ? `<button type="button" id="kindle-test">${t('kindle.test')}</button>` : ''}</form><small>${escape(t('kindle.usage', { domains: settings.domains.join(', '), sent: settings.sentToday, limit: settings.dailyLimit }))}</small></section><section class="card table-wrap"><h2>${t('kindle.history')}</h2>${deliveries.length ? `<table><thead><tr><th>${t('common.time')}</th><th>${t('kindle.file')}</th><th>${t('kindle.size')}</th><th>${t('kindle.result')}</th></tr></thead><tbody>${deliveries.map(d => `<tr><td>${date(d.occurredAt)}</td><td>${escape(d.fileName)}</td><td>${bytes(d.size)}</td><td>${d.status === 'sent' ? `<span class="badge">${t('kindle.sent')}</span>` : `<span class="badge warn">${t('kindle.failed')}</span> <small>${escape(d.error ?? '')}</small>`}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">${t('kindle.none')}</div>`}</section>`;
  form('kindle-address', async data => { await api('/me/kindle', 'PUT', Object.fromEntries(data)); await kindlePage(content); message(t('kindle.saved')); });
  if (settings.address && settings.configured) button('kindle-test', async () => { await api('/me/kindle/test', 'POST', {}); await kindlePage(content); message(t('kindle.testSent')); });
}

async function sharesPage(content: HTMLElement) {
  const body = frame(content);
  const [{ shares }, vaults] = await Promise.all([api<{ shares: ShareRow[] }>('/shares'), api<Vault[]>('/vaults')]);
  const names = new Map(vaults.map(vault => [vault.id, vault.name]));
  shareTable(body, shares, share => names.get(share.vaultId) ?? '', false, () => sharesPage(content));
}

function passwordPage(content: HTMLElement) {
  const body = frame(content);
  body.innerHTML = `<section class="card"><h2>${t('nav.password')}${tip(t('password.desc'))}</h2><form id="password" class="stack">${input(t('password.current'), 'currentPassword', 'password', 'autocomplete="current-password"')}${input(`${t('password.new')}${tip(t('password.hint'))}`, 'password', 'password', 'minlength="12" autocomplete="new-password"')}${input(t('password.confirm'), 'confirmation', 'password', 'minlength="12" autocomplete="new-password"')}<button class="primary" type="submit">${t('password.save')}</button></form></section>`;
  form('password', async data => {
    if (data.get('password') !== data.get('confirmation')) { message(t('password.mismatch'), true); return; }
    await api('/me/password', 'PUT', { currentPassword: data.get('currentPassword'), password: data.get('password') });
    (document.getElementById('password') as HTMLFormElement).reset();
    message(t('password.updated'));
  });
}

/** Interface: the language of this browser and the account's colour scheme, including a custom recipe. */
function interfacePage(content: HTMLElement) {
  const body = frame(content);
  const user = state.session!.user;
  const current = user.theme || DEFAULT_THEME;
  const recipe: Recipe = { ...(user.recipe ?? RECIPES.sakura) };
  const editing = current === 'custom';
  body.innerHTML = `<section class="card"><h2>${t('interface.language')}${tip(t('interface.languageDesc'))}</h2><div id="language-choice" class="language-choice"></div></section>
    <section class="card"><h2>${t('theme.title')}${tip(t('theme.desc'))}</h2><div class="themes">${THEMES.map(theme => `<button type="button" class="theme-card" id="theme-${theme}" aria-pressed="${theme === current}"><span class="swatches ${theme}"><span></span><span></span><span></span></span><span title="${escape(t(`theme.${theme}Desc`))}">${t(`theme.${theme}`)}</span></button>`).join('')}</div>
    <form id="recipe" class="recipe" ${editing ? '' : 'hidden'}><h3>${t('recipe.title')}${tip(t('recipe.hint'))}</h3><div class="recipe-fields">
      <label>${t('recipe.accent')}<input type="color" name="accent" value="${escape(recipe.accent)}"></label>
      <label>${t('recipe.tint')}<input type="range" name="tint" min="6" max="40" step="1" value="${recipe.tint}"></label>
      <fieldset><legend>${t('recipe.side')}</legend><label class="check"><input type="radio" name="side" value="light" ${recipe.side === 'light' ? 'checked' : ''}> ${t('recipe.light')}</label><label class="check"><input type="radio" name="side" value="dark" ${recipe.side === 'dark' ? 'checked' : ''}> ${t('recipe.dark')}</label></fieldset>
    </div><button class="primary" type="submit">${t('recipe.save')}</button></form></section>`;
  document.getElementById('language-choice')!.append(languageSelect(() => navigate(location.pathname)));
  const custom = body.querySelector<HTMLElement>('.swatches.custom')!.children;
  const recipeForm = document.getElementById('recipe') as HTMLFormElement;
  const read = (): Recipe => {
    const data = new FormData(recipeForm);
    return { accent: String(data.get('accent')), tint: Number(data.get('tint')), side: data.get('side') === 'dark' ? 'dark' : 'light' };
  };
  const paintSwatches = (value: Recipe) => {
    (custom[0] as HTMLElement).style.background = value.accent;
    (custom[1] as HTMLElement).style.background = `color-mix(in oklab, ${value.accent} ${value.side === 'dark' ? 30 : value.tint * 1.4}%, ${value.side === 'dark' ? '#17131a' : '#fff'})`;
    (custom[2] as HTMLElement).style.background = `color-mix(in oklab, ${value.accent} ${value.tint}%, #fff)`;
  };
  paintSwatches(recipe);
  // Changes are previewed at once; they are kept only when saved.
  recipeForm.addEventListener('input', () => { const value = read(); paintSwatches(value); applyTheme('custom', value); });
  form('recipe', async () => {
    const value = read();
    await api('/me/theme', 'PUT', { theme: 'custom', recipe: value });
    user.theme = 'custom'; user.recipe = value;
    applyTheme('custom', value);
    interfacePage(content);
    message(t('theme.saved'));
  });
  for (const theme of THEMES) button(`theme-${theme}`, async () => {
    if (theme === 'custom') {
      recipeForm.hidden = false;
      for (const card of body.querySelectorAll('.theme-card')) card.setAttribute('aria-pressed', String(card.id === 'theme-custom'));
      applyTheme('custom', read());
      return;
    }
    await api('/me/theme', 'PUT', { theme });
    user.theme = theme;
    applyTheme(theme, user.recipe);
    interfacePage(content);
    message(t('theme.saved'));
  });
}
