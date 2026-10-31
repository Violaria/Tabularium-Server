// Server settings, for administrators: mail and Kindle, sharing, and accounts and access. Everything the server used to
// read from its environment at start is changed here and applies to the next request.
import { t } from './i18n.js';
import { api, confirmAction, escape, form, message, run, tip } from './core.js';

interface Mail { host: string; port: number; security: 'tls' | 'starttls' | 'none'; user: string; from: string; passwordSet: boolean; passwordHint: string }
interface View {
  mail: Mail | null;
  kindle: { domains: string[]; daily: number; maxMegabytes: number };
  shares: { enabled: boolean; url: string; maxMegabytes: number };
  access: { sessionHours: number; deviceDays: number; rebuildMinutes: number; loginPerMinute: number; syncPerMinute: number; auditDays: number; streamMinutes: number; writeMegabytes: number };
  secretKey: boolean;
}
const ACCESS: [keyof View['access'], number, number, number][] = [
  ['sessionHours', 1, 2160, 1], ['deviceDays', 1, 3650, 1], ['rebuildMinutes', 1, 1440, 1], ['loginPerMinute', 1, 10_000, 1],
  ['syncPerMinute', 10, 1_000_000, 10], ['auditDays', 1, 3650, 1], ['streamMinutes', 1, 1440, 1], ['writeMegabytes', 1, 4096, 1],
];
const lines = (text: FormDataEntryValue | null) => String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
const field = (label: string, input: string, hint?: string) => `<label><span>${label}${hint ? tip(hint) : ''}</span>${input}</label>`;

export async function renderServerSettings(body: HTMLElement) {
  const view = await api<View>('/admin/settings');
  const mail = view.mail ?? { host: '', port: 465, security: 'tls', user: '', from: '', passwordSet: false, passwordHint: '' };
  const scrolled = window.scrollY;
  body.innerHTML = `<section class="card"><h2>${t('settings.mailTitle')}${tip(t('settings.mailDesc'))}</h2><form id="mail" class="stack">
      <div class="recipe-fields">
        ${field(t('settings.mailHost'), `<input name="host" value="${escape(mail.host)}" placeholder="smtp.example.com">`, t('settings.mailHostHint'))}
        ${field(t('settings.mailPort'), `<input name="port" type="number" min="1" max="65535" value="${mail.port}">`)}
        ${field(t('settings.mailSecurity'), `<select name="security">${(['tls', 'starttls', 'none'] as const).map(value => `<option value="${value}" ${value === mail.security ? 'selected' : ''}>${t(`settings.security.${value}`)}</option>`).join('')}</select>`)}
        ${field(t('settings.mailUser'), `<input name="user" value="${escape(mail.user)}" autocomplete="off">`)}
        ${field(t('settings.mailPassword'), `<input name="password" type="password" autocomplete="new-password" ${view.secretKey ? '' : 'disabled'} placeholder="${mail.passwordSet ? escape(t('ai.keySet', { hint: mail.passwordHint })) : ''}">`, view.secretKey ? undefined : t('settings.needSecret'))}
        ${field(t('settings.mailFrom'), `<input name="from" type="email" value="${escape(mail.from)}">`, t('settings.mailFromHint'))}
      </div>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button>${mail.passwordSet ? `<button type="button" id="clear-password">${t('settings.clearPassword')}</button>` : ''}</div></form>
      ${view.mail ? `<form id="mail-test" class="inline-form">${field(t('settings.mailTestTo'), '<input name="to" type="email" required>')}<button type="submit">${t('settings.mailTest')}</button></form>` : ''}</section>
    <section class="card"><h2>Kindle${tip(t('settings.kindleDesc'))}</h2><form id="kindle" class="stack"><div class="recipe-fields">
        ${field(t('settings.kindleDomains'), `<textarea name="domains" rows="2" spellcheck="false">${escape(view.kindle.domains.join('\n'))}</textarea>`, t('settings.oneLine'))}
        ${field(t('settings.kindleDaily'), `<input name="daily" type="number" min="1" max="1000" value="${view.kindle.daily}">`)}
        ${field(t('settings.kindleSize'), `<input name="maxMegabytes" type="number" min="1" max="200" value="${view.kindle.maxMegabytes}">`)}
      </div><div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form></section>
    <section class="card"><h2>${t('shares.all')}</h2><form id="shares" class="stack">
      <label class="check"><input type="checkbox" name="enabled" ${view.shares.enabled ? 'checked' : ''}> ${t('settings.sharesEnabled')}${tip(t('settings.sharesEnabledHint'))}</label>
      <div class="recipe-fields">
        ${field(t('settings.sharesUrl'), `<input name="url" value="${escape(view.shares.url)}" placeholder="https://notes.example.com">`, t('settings.sharesUrlHint'))}
        ${field(t('settings.sharesSize'), `<input name="maxMegabytes" type="number" min="1" max="1024" value="${view.shares.maxMegabytes}">`)}
      </div><div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form></section>
    <section class="card"><h2>${t('settings.accessTitle')}</h2><form id="access" class="stack"><div class="recipe-fields">
        ${ACCESS.map(([name, min, max, step]) => field(t(`settings.access.${name}`), `<input name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${view.access[name]}">`, t(`settings.access.${name}Hint`))).join('')}
      </div><div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form></section>`;
  window.scrollTo(0, scrolled);
  const save = async (data: Record<string, unknown>) => { await api('/admin/settings', 'PUT', data); await renderServerSettings(body); message(t('settings.saved')); };
  form('mail', async data => {
    const host = String(data.get('host')).trim();
    const password = String(data.get('password') ?? '');
    await save({ mail: host ? { host, port: Number(data.get('port')), security: data.get('security'), user: String(data.get('user')).trim(), from: String(data.get('from')).trim(),
      ...(password ? { password } : {}) } : null });
  });
  document.getElementById('clear-password')?.addEventListener('click', () => void run(async () => {
    if (!await confirmAction({ title: t('settings.clearPasswordTitle'), body: t('settings.clearPasswordBody'), action: t('settings.clearPassword'), danger: true })) return;
    await save({ mail: { host: mail.host, port: mail.port, security: mail.security, user: mail.user, from: mail.from, password: '' } });
  }));
  if (view.mail) form('mail-test', async data => { await api('/admin/settings/mail-test', 'POST', { to: data.get('to') }); message(t('settings.mailSent')); });
  form('kindle', async data => save({ kindle: { domains: lines(data.get('domains')), daily: Number(data.get('daily')), maxMegabytes: Number(data.get('maxMegabytes')) } }));
  form('shares', async data => save({ shares: { enabled: data.get('enabled') === 'on', url: String(data.get('url')).trim(), maxMegabytes: Number(data.get('maxMegabytes')) } }));
  form('access', async data => save({ access: Object.fromEntries(ACCESS.map(([name]) => [name, Number(data.get(name))])) }));
}
