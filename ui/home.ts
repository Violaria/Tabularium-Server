// Home: the signed-in user's vaults at a glance, recent Tabularius conversations, and a server line for administrators.
import { formatDate, t } from './i18n.js';
import { ago, api, bytes, escape, icon, page, state, tip } from './core.js';

interface HomeVault {
  id: string; name: string; state: string; locked: boolean; rebuilding: boolean; size: number; notes: number; tabularius: boolean;
  devices: { name: string; lastSeenAt: number | null }[]; recent: { path: string; mtime: number }[];
}
interface Home {
  vaults: HomeVault[];
  conversations: { id: string; title: string; vaultId: string; vault: string; updatedAt: number }[];
  server: { uptimeSeconds: number; activeProxyConnections: number; storage: boolean; model: string | null } | null;
}

const when = (value: number) => ago(value, formatDate, {
  now: t('time.now'), minutes: n => t('time.minutes', { n }), hours: n => t('time.hours', { n }), days: n => t('time.days', { n }),
});
function greeting() {
  const hour = new Date().getHours();
  const key = hour < 5 ? 'home.evening' : hour < 12 ? 'home.morning' : hour < 18 ? 'home.afternoon' : 'home.evening';
  return t(key, { name: state.session!.user.username });
}
/** The vault's state as a dot; its name is the tooltip. A locked vault's dot leads to where it is unlocked. */
function status(vault: HomeVault) {
  const [kind, label] = vault.state !== 'ready' ? ['warn', t('home.notReady')] : vault.rebuilding ? ['busy', t('home.rebuilding')]
    : vault.locked ? ['warn', t('home.locked')] : ['', t('home.synced')];
  const dot = `<span class="dot ${kind}" role="img" aria-label="${escape(label)}" title="${escape(label)}"></span>`;
  return vault.locked && vault.state === 'ready' ? `<a class="state-link" href="/account/vaults/${vault.id}" data-route title="${escape(label)}">${dot}</a>` : dot;
}
function vaultCard(vault: HomeVault) {
  const devices = vault.devices.length
    ? `<ul class="rows">${vault.devices.map(d => `<li><span class="lead">${icon('device')}<span>${escape(d.name)}</span></span><span title="${escape(t('account.lastSync'))}">${d.lastSeenAt ? escape(when(d.lastSeenAt)) : '—'}</span></li>`).join('')}</ul>`
    : `<p class="muted">${t('home.noDevices')}</p>`;
  const recent = vault.tabularius && vault.recent.length
    ? `<div><h3>${t('home.recent')}</h3><ul class="rows">${vault.recent.map(r => `<li><a class="lead" data-route href="/notes/?vault=${vault.id}&amp;path=${encodeURIComponent(r.path)}" title="${escape(r.path)}">${icon('file')}<span>${escape(r.path.replace(/\.md$/i, '').split('/').pop()!)}</span></a><span>${escape(when(r.mtime))}</span></li>`).join('')}</ul></div>`
    : '';
  const facts = `<div class="facts"><span title="${escape(t('home.notesLabel'))}">${icon('notes')}<strong>${vault.notes}</strong></span><span title="${escape(t('home.sizeLabel'))}">${icon('database')}${bytes(vault.size)}</span>${vault.tabularius ? `<span class="on" title="${escape(t('home.tabulariusOn'))}" role="img" aria-label="${escape(t('home.tabulariusOn'))}">${icon('assistant')}</span>` : ''}</div>`;
  const actions = `<div class="actions"><a class="button primary" href="/notes/?vault=${vault.id}" data-route>${icon('notes')}${t('home.openNotes')}</a>${vault.tabularius ? `<a class="button" href="/tabularius/?vault=${vault.id}" data-route>${icon('assistant')}${t('home.ask')}</a>` : ''}<a class="icon-button" href="/account/vaults/${vault.id}" data-route aria-label="${escape(t('home.manageDevices'))}" title="${escape(t('home.manageDevices'))}">${icon('gear')}</a></div>`;
  return `<section class="card home-vault"><header><h2>${escape(vault.name)}</h2>${status(vault)}${facts}</header><div class="split"><div><h3>${t('home.devices')}</h3>${devices}</div>${recent}</div>${actions}</section>`;
}

export async function renderHome(content: HTMLElement) {
  const data = await api<Home>('/home');
  document.title = 'Tabularium';
  const body = page(content, { title: greeting() });
  const vaults = data.vaults.length ? data.vaults.map(vaultCard).join('') : `<section class="card empty">${t('home.noVaults')}${tip(t('home.noVaultsHint'))}</section>`;
  const conversations = data.conversations.length
    ? `<section class="card"><h2>${t('home.conversations')}</h2><ul class="rows">${data.conversations.map(c => `<li><a class="lead" href="/tabularius/?vault=${c.vaultId}&amp;conversation=${c.id}" data-route>${icon('assistant')}<span>${escape(c.title)}</span></a><span>${escape(c.vault)} · ${escape(when(c.updatedAt))}</span></li>`).join('')}</ul></section>`
    : '';
  const server = data.server
    ? `<section class="card server"><div class="server-line"><span class="dot ${data.server.storage ? '' : 'error'}" role="img" aria-label="${escape(data.server.storage ? t('overview.ok') : t('overview.down'))}" title="${escape(data.server.storage ? t('overview.ok') : t('overview.down'))}"></span><strong>${t('home.server')}</strong><span>${t('home.uptime', { duration: uptime(data.server.uptimeSeconds) })}</span><span>${t('home.connections', { n: data.server.activeProxyConnections })}</span>${data.server.model ? `<span>${escape(data.server.model)}</span>` : ''}<a class="icon-button" href="/admin/" data-route aria-label="${escape(t('home.toOverview'))}" title="${escape(t('home.toOverview'))}">${icon('chevron')}</a></div></section>`
    : '';
  body.innerHTML = vaults + conversations + server;
}
function uptime(seconds: number) {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? t('time.daysHours', { d: days, h: hours }) : hours ? t('time.hoursMinutes', { h: hours, m: minutes }) : t('time.minutesOnly', { m: minutes });
}
