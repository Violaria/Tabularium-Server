// Scheduled backups, for administrators: the schedule and how many points to keep, "back up now", the points on disk
// and the history of runs. Backups run on the server without stopping it; restoring is done with the backup tool.
import { formatDate, t } from './i18n.js';
import { api, bytes, escape, message, run, tip } from './core.js';

interface Settings { enabled: boolean; frequency: 'daily' | 'weekly' | 'monthly'; weekday: number; monthDay: number; time: string; timezone: string; keep: number; fullEvery: number }
interface Point { id: string; type: 'full' | 'incremental'; chain: string; createdAt: string; size: number }
interface Run { id: string; trigger: 'scheduled' | 'manual'; type: 'full' | 'incremental' | null; startedAt: number; finishedAt: number | null; size: number | null; ok: boolean | null; error: string | null }
interface View { available: boolean; directory: string | null; settings: Settings; running: boolean; free: number | null; next: number | null; points: Point[]; runs: Run[] }

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
let poll: number | undefined;

const result = (r: Run) => r.ok === null ? `<span class="badge">${t('backups.running')}</span>`
  : r.ok ? `<span class="badge">${t('backups.ok')}</span>` : `<span class="badge warn" title="${escape(r.error ?? '')}">${t('backups.failed')}</span>`;
const statusCard = (view: View) => `<section class="card" id="backup-status"><div class="card-head"><h2>${t('backups.title')}${tip(t('backups.desc'))}</h2>
      <button type="button" id="backup-now" class="primary" ${view.running ? 'disabled' : ''}>${view.running ? t('backups.running') : t('backups.now')}</button></div>
      <dl class="details">
        <dt>${t('backups.next')}</dt><dd>${view.next ? formatDate(view.next) : t('backups.off')}</dd>
        <dt>${t('backups.directory')}</dt><dd class="mono">${escape(view.directory ?? '')}</dd>
        <dt>${t('backups.free')}</dt><dd>${view.free === null ? '—' : bytes(view.free)}</dd>
        ${view.runs[0]?.ok === false ? `<dt>${t('backups.lastFailure')}</dt><dd class="error-text">${escape(view.runs[0].error ?? '')}</dd>` : ''}
      </dl></section>`;
const pointsCard = (view: View) => `<section class="card" id="backup-points"><h2>${t('backups.points')}${tip(t('backups.pointsHint'))}</h2>${view.points.length ? `<table><thead><tr><th>${t('backups.when')}</th><th>${t('backups.type')}</th><th>${t('backups.size')}</th><th>${t('backups.point')}</th></tr></thead><tbody>
      ${view.points.map(p => `<tr><td>${formatDate(Date.parse(p.createdAt))}</td><td>${t(`backups.type.${p.type}`)}</td><td>${bytes(p.size)}</td><td class="mono">${escape(p.id)}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${t('backups.noPoints')}</p>`}</section>`;
const historyCard = (view: View) => `<section class="card" id="backup-history"><h2>${t('backups.history')}</h2>${view.runs.length ? `<table><thead><tr><th>${t('backups.when')}</th><th>${t('backups.trigger')}</th><th>${t('backups.type')}</th><th>${t('backups.size')}</th><th>${t('backups.duration')}</th><th>${t('backups.result')}</th></tr></thead><tbody>
      ${view.runs.map(r => `<tr><td>${formatDate(r.startedAt)}</td><td>${t(`backups.trigger.${r.trigger}`)}</td><td>${r.type ? t(`backups.type.${r.type}`) : '—'}</td><td>${r.size === null ? '—' : bytes(r.size)}</td><td>${r.finishedAt ? t('backups.seconds', { n: Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000)) }) : '—'}</td><td>${result(r)}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${t('backups.noRuns')}</p>`}</section>`;

export async function renderBackups(body: HTMLElement) {
  window.clearTimeout(poll);
  const view = await api<View>('/admin/backups');
  if (!view.available) {
    body.innerHTML = `<section class="card"><h2>${t('backups.title')}</h2><p class="muted">${t('backups.unavailable')}</p></section>`;
    return;
  }
  const s = view.settings;
  const scrolled = window.scrollY;
  const zones = (Intl as unknown as { supportedValuesOf(kind: string): string[] }).supportedValuesOf('timeZone');
  body.innerHTML = `${statusCard(view)}
    <section class="card"><h2>${t('backups.schedule')}</h2><form id="backup-settings" class="stack">
      <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> ${t('backups.enabled')}</label>
      <div class="recipe-fields">
        <label>${t('backups.frequency')}<select name="frequency">${(['daily', 'weekly', 'monthly'] as const).map(f => `<option value="${f}" ${f === s.frequency ? 'selected' : ''}>${t(`backups.frequency.${f}`)}</option>`).join('')}</select></label>
        <label data-for="weekly">${t('backups.weekday')}<select name="weekday">${WEEKDAYS.map(d => `<option value="${d}" ${d === s.weekday ? 'selected' : ''}>${t(`backups.weekday.${d}` as 'backups.weekday.0')}</option>`).join('')}</select></label>
        <label data-for="monthly"><span>${t('backups.monthDay')}${tip(t('backups.monthDayHint'))}</span><input name="monthDay" type="number" min="1" max="31" value="${s.monthDay}"></label>
        <label>${t('backups.time')}<input name="time" type="time" value="${escape(s.time)}"></label>
        <label>${t('backups.timezone')}<input name="timezone" list="time-zones" value="${escape(s.timezone)}" spellcheck="false"><datalist id="time-zones">${zones.map(z => `<option value="${escape(z)}">`).join('')}</datalist></label>
        <label><span>${t('backups.keep')}${tip(t('backups.keepHint'))}</span><input name="keep" type="number" min="1" max="1000" value="${s.keep || ''}"></label>
        <label><span>${t('backups.fullEvery')}${tip(t('backups.fullEveryHint'))}</span><input name="fullEvery" type="number" min="1" max="365" value="${s.fullEvery}"></label>
      </div>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form></section>
    ${pointsCard(view)}
    ${historyCard(view)}`;
  window.scrollTo(0, scrolled);

  const settingsForm = document.getElementById('backup-settings') as HTMLFormElement;
  // Only the field for the chosen frequency is shown.
  const showFields = () => {
    const frequency = (settingsForm.elements.namedItem('frequency') as HTMLSelectElement).value;
    for (const field of settingsForm.querySelectorAll<HTMLElement>('[data-for]')) field.hidden = field.dataset.for !== frequency;
  };
  showFields();
  (settingsForm.elements.namedItem('frequency') as HTMLSelectElement).addEventListener('change', showFields);
  settingsForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(settingsForm);
    void run(async () => {
      await api('/admin/backups/settings', 'PUT', { enabled: data.get('enabled') === 'on', frequency: data.get('frequency'), weekday: Number(data.get('weekday')),
        monthDay: Number(data.get('monthDay')), time: String(data.get('time')), timezone: String(data.get('timezone')).trim(),
        keep: Number(data.get('keep') || 0), fullEvery: Number(data.get('fullEvery')) });
      await renderBackups(body); message(t('backups.saved'));
    });
  });
  bindNow(body);
  follow(body, view);
}

function bindNow(body: HTMLElement) {
  document.getElementById('backup-now')!.addEventListener('click', () => void run(async () => {
    const view = await api<View>('/admin/backups/run', 'POST');
    message(t('backups.started'));
    refresh(body, view);
  }));
}
/** While a backup runs, the status, points and history follow it; the schedule form is left as it is. */
function follow(body: HTMLElement, view: View) {
  window.clearTimeout(poll);
  if (view.running) poll = window.setTimeout(() => {
    if (body.isConnected) void run(async () => refresh(body, await api<View>('/admin/backups')));
  }, 3000);
}
function refresh(body: HTMLElement, view: View) {
  for (const [id, html] of [['backup-status', statusCard(view)], ['backup-points', pointsCard(view)], ['backup-history', historyCard(view)]] as const)
    document.getElementById(id)?.replaceWith(Object.assign(document.createElement('template'), { innerHTML: html }).content.firstElementChild!);
  bindNow(body);
  follow(body, view);
}
