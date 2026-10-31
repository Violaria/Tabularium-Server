// The Tabularium web application: one sign-in, one shell, and the modules home, web notes, Tabularius, administration
// and account settings. Every path of the application loads this page; the path selects the module.
import { t, type Language } from './i18n.js';
import { api, ApiError, applyTheme, markShapes, notesStyles, captureLinks, chooseAction, connect, escape, form, icon, input, message, navigate, run, state, storedTheme, clearMessage, tip, type Session } from './core.js';
import { renderHome } from './home.js';
import { renderAdmin } from './admin.js';
import { renderAccount } from './account.js';
import { renderTabularius } from './tabularius.js';

const app = document.querySelector<HTMLDivElement>('#app')!;
const mark = () => `<span class="brand-mark"><svg viewBox="0 0 64 64" aria-hidden="true">${markShapes()}</svg></span><div><strong>Tabularium</strong><small>${t('brand.subtitle')}</small></div>`;
const brand = () => `<div class="brand">${mark()}</div>`;

type Module = 'home' | 'notes' | 'tabularius' | 'admin' | 'account';

/** Web notes: a separate bundle with the sync core, loaded when the module first opens. */
interface NotesModule { mount(target: HTMLElement): void; changeLanguage(next: Language): void; unmount(): Promise<void>; clearAccount(userId: string): Promise<void>; forgetUnlocked(): void }
/** How many vaults web notes keeps in this browser for an account (records in its IndexedDB), without loading the module. */
async function localVaults(userId: string) {
  if (!(await indexedDB.databases()).some(db => db.name === 'tabularium-notes')) return 0;
  return new Promise<number>(resolve => {
    const request = indexedDB.open('tabularium-notes');
    request.onerror = () => resolve(0);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('vaults')) { db.close(); resolve(0); return; }
      const keys = db.transaction('vaults').objectStore('vaults').getAllKeys();
      keys.onsuccess = () => { db.close(); resolve((keys.result as string[]).filter(key => key.startsWith(`${userId}:`)).length); };
      keys.onerror = () => { db.close(); resolve(0); };
    };
  });
}
let notes: NotesModule | undefined;
let notesMounted = false;
async function openNotes(content: HTMLElement) {
  notesStyles();
  notes ??= await import('/notes/assets/notes-module.js' as string) as NotesModule;
  content.replaceChildren();
  notes.mount(content);
  notesMounted = true;
}
/** Leaving web notes stops its replication and closes the local database before another module draws. */
async function leaveNotes() {
  if (!notesMounted) return;
  notesMounted = false;
  await notes!.unmount();
}
function moduleOf(path: string): Module {
  if (path.startsWith('/notes')) return 'notes';
  if (path.startsWith('/tabularius')) return 'tabularius';
  if (path.startsWith('/admin')) return 'admin';
  if (path.startsWith('/account')) return 'account';
  return 'home';
}

function signIn() {
  document.title = 'Tabularium';
  app.innerHTML = `<div class="gate"><div class="gate-box">${brand()}<div class="card"><h1>${t('console.signInTitle')}${tip(t('console.accountsHint'))}</h1><form id="login" class="stack">${input(t('common.username'), 'username', 'text', 'autocomplete="username"')}${input(t('common.password'), 'password', 'password', 'autocomplete="current-password"')}<button class="primary" type="submit">${t('common.signIn')}</button></form></div></div></div>`;
  form('login', async data => {
    state.session = await api<Session>('/web-session', 'POST', Object.fromEntries(data));
    draw();
  });
}

/** The first sign-in replaces the initial password before any module opens. */
function initialPassword() {
  app.innerHTML = `<div class="gate"><div class="gate-box">${brand()}<div class="card"><h1>${t('password.initialTitle')}${tip(t('password.desc'))}</h1><form id="password" class="stack">${input(t('password.current'), 'currentPassword', 'password', 'autocomplete="current-password"')}${input(`${t('password.new')}${tip(t('password.hint'))}`, 'password', 'password', 'minlength="12" autocomplete="new-password"')}${input(t('password.confirm'), 'confirmation', 'password', 'minlength="12" autocomplete="new-password"')}<button class="primary" type="submit">${t('password.save')}</button></form></div></div></div>`;
  form('password', async data => {
    if (data.get('password') !== data.get('confirmation')) { message(t('password.mismatch'), true); return; }
    await api('/me/password', 'PUT', { currentPassword: data.get('currentPassword'), password: data.get('password') });
    state.session!.user.mustChangePassword = false;
    draw();
  });
}

let framed = '';
/** The shell is drawn once per language and user; moving between modules only replaces the content area. */
function frame(current: Module) {
  const user = state.session!.user;
  const key = `${user.id}|${document.documentElement.lang}`;
  if (framed !== key || !document.getElementById('content')) {
    framed = key;
    // The content area survives a redraw of the frame, so a mounted module (web notes) stays open across a language change.
    const kept = document.getElementById('content');
    const items: [Module, string, string, string][] = [
      ['home', '/', 'home', t('nav.home')],
      ['notes', '/notes/', 'notes', t('home.notes')],
      ['tabularius', '/tabularius/', 'assistant', t('nav.tabularius')],
      ...(user.role === 'admin' ? [['admin', '/admin/', 'admin', t('nav.admin')] as [Module, string, string, string]] : []),
    ];
    app.innerHTML = `<div class="shell"><aside class="side"><a href="/" data-route class="brand">${mark()}</a><nav aria-label="${t('console.navLabel')}">${items.map(([module, href, glyph, label]) =>
      `<a href="${href}" data-route data-module="${module}">${icon(glyph)}<span>${label}</span></a>`).join('')}</nav><div class="account"><a href="/account/" data-route data-module="account" class="who"><span class="avatar">${escape(user.username.slice(0, 1).toUpperCase())}</span><span><strong>${escape(user.username)}</strong><small>${user.role === 'admin' ? t('role.admin') : t('role.user')}</small></span></a><button id="logout" type="button">${t('common.signOut')}</button></div></aside><main class="content" id="content"></main></div>`;
    if (kept) document.getElementById('content')!.replaceWith(kept);
    document.getElementById('logout')!.addEventListener('click', () => void run(async () => {
      // A plain-text copy of notes left in a shared browser can be read by its next user: ask what to do with it.
      const kept = await localVaults(user.id);
      if (kept) {
        const choice = await chooseAction({ title: t('signOut.title'), body: t('signOut.body', { count: kept }), choices: [
          { value: 'keep', label: t('signOut.keep') }, { value: 'clear', label: t('signOut.clear'), danger: true }] });
        if (!choice) return;
        if (choice === 'clear') {
          await leaveNotes();
          notes ??= await import('/notes/assets/notes-module.js' as string) as NotesModule;
          await notes.clearAccount(user.id);
        }
      }
      // Web notes stops before the session ends, and the passphrase kept in this page goes with it.
      await leaveNotes();
      notes?.forgetUnlocked();
      await api('/web-session', 'DELETE'); state.session = undefined; history.pushState(null, '', '/'); signIn();
    }));
  }
  for (const link of app.querySelectorAll<HTMLAnchorElement>('[data-module]'))
    if (link.dataset.module === current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  return document.getElementById('content')!;
}

let drawnPath = '';
function draw() {
  if (!state.session) { signIn(); return; }
  applyTheme(state.session.user.theme, state.session.user.recipe);
  if (state.session.user.mustChangePassword) { initialPassword(); return; }
  const path = location.pathname;
  // Toasts belong to the page they were raised on.
  if (path !== drawnPath) { drawnPath = path; clearMessage(); }
  const current = moduleOf(path);
  const content = frame(current);
  void run(async () => {
    if (current !== 'notes') await leaveNotes();
    else if (notesMounted) return;
    if (current === 'home' && !offline) await renderHome(content);
    else if (offline && current !== 'notes') content.innerHTML = `<div class="page"><section class="card"><h2>${t('app.offline')}</h2><p>${t('app.offlineHint')}</p><a class="button primary" href="/notes/" data-route>${t('home.notes')}</a></section></div>`;
    else if (current === 'admin') await renderAdmin(content, path);
    else if (current === 'account') await renderAccount(content, path);
    else if (current === 'tabularius') await renderTabularius(content);
    else await openNotes(content);
  });
}

connect({ expired: signIn, route: draw });
captureLinks(app);
window.addEventListener('popstate', draw);
document.title = 'Tabularium';
/**
 * Without a network only web notes work, for the account that used this browser last: it opens the vaults fetched
 * here before. The other modules need the server.
 */
let offline = false;
function offlineSession() {
  let last: { id: string; username: string } | null = null;
  try { last = JSON.parse(localStorage.getItem('tabularium-notes:last-user') ?? 'null'); } catch { /* no record */ }
  if (!last) return undefined;
  return { user: { ...last, role: 'user' as const, disabled: false, mustChangePassword: false, ...storedTheme() }, csrf: '' };
}
void (async () => {
  try { state.session = await api<Session>('/web-session'); }
  catch (error) {
    if (error instanceof TypeError) { offline = true; state.session = offlineSession(); }
    else if (!(error instanceof ApiError && error.status === 401)) throw error;
  }
  draw();
})();
// One service worker for the whole application keeps it, and web notes, usable without a network.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js', { scope: '/' });
  // The earlier web notes page registered its own worker under /notes/.
  void navigator.serviceWorker.getRegistrations().then(list => list.filter(r => r.scope.endsWith('/notes/')).forEach(r => void r.unregister()));
}
