// Home: the signed-in user's vaults at a glance, recent Tabularius conversations, and a server line for administrators.
import { formatDate, t } from './i18n.js';
import { ago, api, bytes, escape, page, state } from './core.js';

interface HomeVault {
  id: string; name: string; state: string; locked: boolean; rebuilding: boolean; size: number; notes: number; tabularius: boolean;
  devices: { name: string; lastSeenAt: number | null }[]; recent: { path: string; mtime: number }[];
}
interface Home {
  vaults: HomeVault[];
  conversations: { id: string; title: string; vaultId: string; vault: string; updatedAt: number }[];
  server: { uptimeSeconds: number; activeProxyConnections: number; storage: boolean; provider: { name: string; model: string } | null } | null;
}

const when = (value: number) => ago(value, formatDate, {
  now: t('time.now'), minutes: n => t('time.minutes', { n }), hours: n => t('time.hours', { n }), days: n => t('time.days', { n }),
});
function greeting() {
  const hour = new Date().getHours();
  const key = hour < 5 ? 'home.evening' : hour < 12 ? 'home.morning' : hour < 18 ? 'home.afternoon' : 'home.evening';
  return t(key, { name: state.session!.user.username });
}
function status(vault: HomeVault) {
  if (vault.state !== 'ready') return `<span class="badge warn">${t('home.notReady')}</span>`;
  if (vault.rebuilding) return `<span class="badge warn">${t('home.rebuilding')}</span>`;
  if (vault.locked) return `<a class="badge warn" href="/account/vaults/${vault.id}" data-route>${t('home.locked')}</a>`;
  return `<span class="badge">${t('home.synced')}</span>`;
}
function vaultCard(vault: HomeVault) {
  const devices = vault.devices.length
    ? `<ul class="rows">${vault.devices.map(d => `<li><span>${escape(d.name)}</span><span>${d.lastSeenAt ? escape(t('home.lastSync', { when: when(d.lastSeenAt) })) : t('home.neverSynced')}</span></li>`).join('')}</ul>`
    : `<p>${t('home.noDevices')}</p>`;
  const recent = vault.tabularius && vault.recent.length
    ? `<div><h3>${t('home.recent')}</h3><ul class="rows">${vault.recent.map(r => `<li><a href="/notes/?vault=${vault.id}&amp;path=${encodeURIComponent(r.path)}">${escape(r.path.replace(/\.md$/i, ''))}</a><span>${escape(when(r.mtime))}</span></li>`).join('')}</ul></div>`
    : '';
  return `<section class="card home-vault"><header><h2>${escape(vault.name)}</h2>${status(vault)}</header><div class="facts"><span>${t('home.noteCount', { n: `<strong>${vault.notes}</strong>` })}</span><span>${bytes(vault.size)}</span><span>${vault.tabularius ? t('home.tabulariusOn') : t('home.tabulariusOff')}</span></div><div class="split"><div><h3>${t('home.devices')}</h3>${devices}</div>${recent}</div><div class="actions"><a class="button primary" href="/notes/?vault=${vault.id}">${t('home.openNotes')}</a>${vault.tabularius ? `<a class="button" href="/tabularius/?vault=${vault.id}">${t('home.ask')}</a>` : ''}<a class="button link" href="/account/vaults/${vault.id}" data-route>${t('home.manageDevices')}</a></div></section>`;
}

export async function renderHome(content: HTMLElement) {
  const data = await api<Home>('/home');
  document.title = 'Tabularium';
  const body = page(content, { title: greeting(), subtitle: new Date().toLocaleDateString(document.documentElement.lang === 'zh' ? 'zh-CN' : document.documentElement.lang, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }) });
  const vaults = data.vaults.length ? data.vaults.map(vaultCard).join('') : `<section class="card"><h2>${t('home.noVaults')}</h2><p>${t('home.noVaultsHint')}</p></section>`;
  const conversations = data.conversations.length
    ? `<section class="card"><h2>${t('home.conversations')}</h2><ul class="rows">${data.conversations.map(c => `<li><a href="/tabularius/?vault=${c.vaultId}&amp;conversation=${c.id}">${escape(c.title)}</a><span>${escape(c.vault)} · ${escape(when(c.updatedAt))}</span></li>`).join('')}</ul></section>`
    : '';
  const server = data.server
    ? `<section class="card"><div class="server-line"><strong>${t('home.server')}</strong><span>${t('home.uptime', { duration: uptime(data.server.uptimeSeconds) })}</span><span>${t('home.connections', { n: data.server.activeProxyConnections })}</span><span class="badge ${data.server.storage ? '' : 'warn'}">${data.server.storage ? t('overview.ok') : t('overview.down')}</span>${data.server.provider ? `<span>${escape(data.server.provider.model)}</span>` : ''}<a href="/admin/" data-route>${t('home.toOverview')}</a></div></section>`
    : '';
  body.innerHTML = vaults + conversations + server;
}
function uptime(seconds: number) {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? t('time.daysHours', { d: days, h: hours }) : hours ? t('time.hoursMinutes', { h: hours, m: minutes }) : t('time.minutesOnly', { m: minutes });
}
