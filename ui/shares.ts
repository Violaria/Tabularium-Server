// Share lists: "My shares" in account settings and every share in administration. Neither page can show what is
// shared or copy an encrypted link: those need the vault's E2EE passphrase and are done in web notes or the plug-in.
import { formatDate, t } from './i18n.js';
import { api, bytes, confirmAction, escape, message, run, tip } from './core.js';

export interface ShareRow {
  id: string; slug: string; vaultId: string; mode: 'encrypted' | 'public'; expiresAt: number | null; password: boolean;
  indexable: boolean; views: number; size: number; createdAt: number; updatedAt: number | null; state: 'active' | 'expired' | 'revoked';
  owner?: string; vault?: string;
}
const DAY = 86_400_000;

function status(share: ShareRow) {
  if (share.state === 'revoked') return `<span class="badge off">${t('shares.revoked')}</span>`;
  if (share.state === 'expired') return `<span class="badge off">${t('shares.expired')}</span>`;
  return `<span class="badge">${share.expiresAt === null ? t('share.forever') : t('shares.until', { time: formatDate(share.expiresAt) })}</span>`;
}
function address(share: ShareRow) {
  const path = `/s/${encodeURIComponent(share.slug)}`;
  // An encrypted link is useless without its key; only a public page can be opened from here.
  return share.mode === 'public' && share.state === 'active'
    ? `<a href="${escape(path)}" target="_blank" rel="noopener noreferrer" class="mono">${escape(`/s/${share.slug}`)}</a>`
    : `<span class="mono">${escape(`/s/${share.slug}`)}</span>`;
}
const kind = (share: ShareRow) =>
  `${share.mode === 'encrypted' ? t('share.encrypted') : t('share.public')}${share.password ? ` · ${t('shares.withPassword')}` : ''}`;

/** Draws the table into `body`; `reload` draws it again after a change. `admin` uses the administrator's routes. */
export function shareTable(body: HTMLElement, shares: ShareRow[], vaultName: (share: ShareRow) => string, admin: boolean, reload: () => Promise<void>) {
  if (!shares.length) { body.innerHTML = `<section class="card"><div class="empty">${t('shares.none')}</div></section>`; return; }
  const inactive = shares.some(share => share.state !== 'active');
  body.innerHTML = `<section class="card table-wrap">${inactive ? `<div class="card-head"><span></span><button type="button" id="shares-clean">${t('shares.clean')}</button></div>` : ''}<table><thead><tr><th>${t('share.address')}${admin ? '' : tip(t('shares.hint'))}</th>${admin ? `<th>${t('shares.owner')}</th>` : ''}<th>${t('shares.vault')}</th><th>${t('share.mode')}</th><th>${t('share.expiry')}</th><th>${t('shares.views')}</th><th>${t('shares.size')}</th><th></th></tr></thead><tbody>${shares.map(share => `<tr data-share="${escape(share.id)}"><td>${address(share)}</td>${admin ? `<td>${escape(share.owner ?? '')}</td>` : ''}<td>${escape(vaultName(share))}</td><td>${kind(share)}</td><td>${status(share)}</td><td>${share.views}</td><td>${share.size ? bytes(share.size) : '—'}</td><td class="right">${share.state === 'active' ? `${admin ? '' : `<select class="compact" data-expiry aria-label="${escape(t('shares.changeExpiry'))}"><option value="">${t('shares.changeExpiry')}</option><option value="7">${t('share.day7')}</option><option value="30">${t('share.day30')}</option><option value="forever">${t('share.forever')}</option></select> `}<button class="danger" data-revoke>${t('share.revoke')}</button>` : ''}</td></tr>`).join('')}</tbody></table></section>`;
  body.querySelector('#shares-clean')?.addEventListener('click', () => void run(async () => {
    if (!await confirmAction({ title: t('shares.clean'), body: t('shares.cleanBody'), action: t('shares.clean'), danger: true })) return;
    await api(admin ? '/admin/shares' : '/shares', 'DELETE'); await reload();
  }));
  for (const row of body.querySelectorAll<HTMLTableRowElement>('tr[data-share]')) {
    const id = row.dataset.share!;
    row.querySelector('[data-revoke]')?.addEventListener('click', () => void run(async () => {
      if (!await confirmAction({ title: t('share.revokeTitle'), body: t('share.revokeBody'), action: t('share.revoke'), danger: true })) return;
      await api(admin ? `/admin/shares/${encodeURIComponent(id)}` : `/shares/${encodeURIComponent(id)}`, 'DELETE'); await reload(); message(t('shares.revokedNotice'));
    }));
    row.querySelector<HTMLSelectElement>('[data-expiry]')?.addEventListener('change', event => void run(async () => {
      const value = (event.target as HTMLSelectElement).value;
      if (!value) return;
      await api(`/shares/${encodeURIComponent(id)}`, 'PATCH', { expiresAt: value === 'forever' ? null : Date.now() + Number(value) * DAY });
      await reload(); message(t('shares.expiryChanged'));
    }));
  }
}
