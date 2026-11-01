// Shared pieces of the web application: session, API calls, notices, forms, the confirmation dialog and navigation.
import { serverError, t } from './i18n.js';
import { paintIcon } from './mark.js';
export { markShapes } from './mark.js';

/** A colour scheme built from a few choices: the main colour, how strongly it tints the pages, and the sidebar. */
export interface Recipe { accent: string; tint: number; side: 'light' | 'dark' }
export interface User { id: string; username: string; role: 'admin' | 'user'; disabled: boolean; mustChangePassword: boolean; theme: string; recipe: Recipe | null }
export interface Session { user: User; csrf: string }

export const state: { session?: Session } = {};

/** Colour themes of the web pages; "custom" uses the account's own recipe. */
export const THEMES = ['sakura', 'lavender', 'forest', 'custom'] as const;
/** Accounts that have not chosen a theme, and the sign-in page before anyone has signed in here, use this one. */
export const DEFAULT_THEME = 'sakura';
/** The recipes of the built-in tinted themes, also the starting point of a custom one. */
export const RECIPES: Record<'sakura' | 'lavender', Recipe> = {
  sakura: { accent: '#d63c78', tint: 22, side: 'light' },
  lavender: { accent: '#7653d9', tint: 20, side: 'light' },
};
/** The web notes style sheet: notes, and the note-like Tabularius answers, use it. */
export function notesStyles() {
  if (document.querySelector('link[data-notes]')) return;
  const style = document.createElement('link');
  style.rel = 'stylesheet'; style.href = '/notes/assets/notes-module.css'; style.dataset.notes = '';
  document.head.append(style);
}
const THEME_KEY = 'tabularium-theme';
/**
 * Applies a colour theme ('' for the default) and remembers it in this browser, so the next page load starts in it.
 * A custom theme passes its recipe to the style sheet as custom properties.
 */
export function applyTheme(theme: string, recipe?: Recipe | null) {
  const root = document.documentElement;
  const shown = theme === 'custom' && !recipe ? DEFAULT_THEME : theme || DEFAULT_THEME;
  if (shown !== 'forest') root.dataset.theme = shown; else delete root.dataset.theme;
  if (shown === 'custom' && recipe) {
    root.style.setProperty('--recipe-accent', recipe.accent);
    root.style.setProperty('--recipe-tint', `${recipe.tint}%`);
    root.dataset.side = recipe.side;
  } else {
    root.style.removeProperty('--recipe-accent');
    root.style.removeProperty('--recipe-tint');
    delete root.dataset.side;
  }
  paintIcon();
  saved = { theme, recipe: recipe ?? null };
  try { localStorage.setItem(THEME_KEY, JSON.stringify(saved)); } catch { /* storage unavailable: the theme lasts for this page */ }
}
let saved: { theme: string; recipe: Recipe | null } = { theme: '', recipe: null };
try { saved = JSON.parse(localStorage.getItem(THEME_KEY) ?? 'null') ?? saved; } catch { /* storage unavailable or an older plain value */ }
applyTheme(saved.theme ?? '', saved.recipe);
/**
 * Password managers attach their autofill button to any focused text field, and leave it behind when the page redraws
 * (the chat box moving down under a new answer). Only the sign-in and password fields are theirs: every other field
 * says it is not one, as it appears.
 */
const CREDENTIAL = /\b(username|current-password|new-password|one-time-code)\b/;
const FIELDS = 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color]):not([data-bwignore]), textarea:not([data-bwignore])';
function markField(field: Element) {
  if (CREDENTIAL.test(field.getAttribute('autocomplete') ?? '')) return;
  field.setAttribute('data-bwignore', ''); field.setAttribute('data-1p-ignore', ''); field.setAttribute('data-lpignore', 'true');
  if (!field.hasAttribute('autocomplete')) field.setAttribute('autocomplete', 'off');
}
/** Marks the fields in `root`, and `root` itself when it is one. */
function noFill(root: Element | Document) {
  if (root instanceof Element && root.matches(FIELDS)) markField(root);
  for (const field of root.querySelectorAll(FIELDS)) markField(field);
}
new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) noFill(node); })
  .observe(document.documentElement, { childList: true, subtree: true });
noFill(document);
/** The theme this browser last used, for starting without the server. */
export const storedTheme = () => saved;
let expired = () => {};
let route = () => {};
/** The shell registers what happens when the session ends and how a path is drawn. */
export function connect(handlers: { expired: () => void; route: () => void }) { expired = handlers.expired; route = handlers.route; }

/** An explanation behind an ⓘ icon, shown on hover or focus, instead of a paragraph on the page. */
export const tip = (text: string) =>
  `<span class="tip" tabindex="0" data-tip="${escape(text)}"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4M8 4.9v.1"/></svg></span>`;
export const escape = (value: string | number) =>
  String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export const bytes = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GiB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`;

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(state.session ? { 'x-csrf-token': state.session.csrf } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  // A reverse proxy's own error page is HTML: the status is reported instead of a parse error.
  const result = /json/.test(response.headers.get('content-type') ?? '') ? await response.json() : undefined;
  if (!response.ok) throw new ApiError(response.status, result?.error ? serverError(result.error) : `HTTP ${response.status}`);
  return result as T;
}

/**
 * Notices appear as toasts in the top-right corner of every page: confirmations close by themselves, errors stay
 * longer and can be closed.
 */
export function message(text: string, error = false) {
  let stack = document.getElementById('toasts');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toasts';
    stack.className = 'toasts';
    document.body.append(stack);
  }
  for (const old of stack.querySelectorAll<HTMLElement>('.toast')) if (old.dataset.text === text) old.remove();
  const toast = document.createElement('div');
  toast.className = error ? 'toast error' : 'toast';
  toast.setAttribute('role', error ? 'alert' : 'status');
  toast.dataset.text = text;
  toast.innerHTML = `<span>${escape(text)}</span><button type="button" class="toast-close" aria-label="${escape(t('dialog.close'))}">×</button>`;
  const remove = () => toast.remove();
  toast.querySelector('button')!.addEventListener('click', remove);
  stack.append(toast);
  setTimeout(remove, error ? 10_000 : 4_000);
}
export function clearMessage() { document.getElementById('toasts')?.replaceChildren(); }

export async function run(action: () => Promise<void>) {
  try { await action(); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401 && state.session) { state.session = undefined; expired(); message(t('common.sessionExpired'), true); }
    else message(error instanceof Error ? error.message : t('common.failed'), true);
  }
}
export function button(id: string, action: () => Promise<void>) {
  document.getElementById(id)!.addEventListener('click', event => {
    const control = event.currentTarget as HTMLButtonElement;
    control.disabled = true;
    void run(action).finally(() => { control.disabled = false; });
  });
}
export function form(id: string, action: (data: FormData) => Promise<void>) {
  document.querySelector<HTMLFormElement>(`#${id}`)!.addEventListener('submit', event => {
    event.preventDefault(); const target = event.currentTarget as HTMLFormElement;
    const submit = target.querySelector<HTMLButtonElement>('button[type=submit]')!; submit.disabled = true;
    void run(() => action(new FormData(target))).finally(() => { submit.disabled = false; });
  });
}
export const input = (label: string, name: string, type = 'text', extra = '') =>
  `<label>${label}<input name="${name}" type="${type}" required ${extra}></label>`;

/**
 * Asks before a consequential action. One statement of what happens, the action named on the button (red when it
 * destroys or revokes), and, when `confirmName` is given, the button stays disabled until that name is typed.
 */
export function confirmAction(options: { title: string; body: string; action: string; danger?: boolean; confirmName?: string }): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.innerHTML = `<h2>${escape(options.title)}</h2><p>${escape(options.body)}</p>${options.confirmName === undefined ? ''
      : `<label>${escape(t('dialog.typeName', { name: options.confirmName }))}<input name="confirm" autocomplete="off"></label>`}<div class="buttons"><button type="button" data-answer="no">${escape(t('dialog.cancel'))}</button><button type="button" data-answer="yes" class="${options.danger ? 'danger solid' : 'primary'}">${escape(options.action)}</button></div>`;
    const confirmButton = dialog.querySelector<HTMLButtonElement>('[data-answer="yes"]')!;
    const typed = dialog.querySelector<HTMLInputElement>('input[name="confirm"]');
    if (typed) {
      confirmButton.disabled = true;
      typed.addEventListener('input', () => { confirmButton.disabled = typed.value !== options.confirmName; });
    }
    const close = (answer: boolean) => { dialog.close(); dialog.remove(); resolve(answer); };
    dialog.addEventListener('cancel', () => close(false));
    dialog.querySelector('[data-answer="no"]')!.addEventListener('click', () => close(false));
    confirmButton.addEventListener('click', () => close(true));
    document.body.append(dialog);
    dialog.showModal();
    (typed ?? confirmButton).focus();
  });
}

/** A dialog with several actions; resolves to the chosen value, or null when it is cancelled. */
export function chooseAction(options: { title: string; body: string; choices: { value: string; label: string; danger?: boolean }[] }): Promise<string | null> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.innerHTML = `<h2>${escape(options.title)}</h2><p>${escape(options.body)}</p><div class="buttons"><button type="button" data-cancel>${escape(t('dialog.cancel'))}</button>${options.choices.map(choice =>
      `<button type="button" data-value="${escape(choice.value)}" class="${choice.danger ? 'danger solid' : 'primary'}">${escape(choice.label)}</button>`).join('')}</div>`;
    const close = (answer: string | null) => { dialog.close(); dialog.remove(); resolve(answer); };
    dialog.addEventListener('cancel', () => close(null));
    dialog.querySelector('[data-cancel]')!.addEventListener('click', () => close(null));
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-value]')) button.addEventListener('click', () => close(button.dataset.value!));
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Moves to another path of the application without reloading the page. */
export function navigate(path: string) {
  if (location.pathname + location.search === path) { route(); return; }
  history.pushState(null, '', path);
  route();
}
/** Links inside the application navigate in place; other links behave normally. */
export function captureLinks(root: HTMLElement) {
  root.addEventListener('click', event => {
    const link = (event.target as HTMLElement).closest('a');
    if (!link || link.target || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !link.hasAttribute('data-route')) return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  });
}

/** Line icons drawn inline (24 grid), so the pages need no icon font or third-party assets. */
const ICONS: Record<string, string> = {
  home: '<path d="M4 10.2 12 4l8 6.2V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  notes: '<path d="M7 3.5h7.5L19 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M14 3.5V8.5h5M9.5 13h6M9.5 16.5h4"/>',
  assistant: '<path d="M5 5.5h14a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1h-8.5L6 20.5V17H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"/><path d="M8.5 10h7M8.5 13h4.5"/>',
  admin: '<path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6.2z"/><path d="m9.2 12 2 2 3.8-4"/>',
  logout: '<path d="M14 4.5h4a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-4"/><path d="M10 8.5 6.5 12l3.5 3.5M6.5 12H15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  compose: '<path d="M12.5 5.5H6a1 1 0 0 0-1 1V18a1 1 0 0 0 1 1h11.5a1 1 0 0 0 1-1v-6.5"/><path d="m10 14 .6-2.7 7.6-7.6a1.4 1.4 0 0 1 2 2l-7.6 7.6z"/>',
  pencil: '<path d="m5 19 .9-3.6L15.6 5.7a1.8 1.8 0 0 1 2.6 0l.1.1a1.8 1.8 0 0 1 0 2.6L8.6 18.1z"/><path d="m14 7.3 2.7 2.7"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4.5 4.5"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1"/><path d="M5 9v9.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  unarchive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1"/><path d="M5 9v9.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M12 17v-5M9.8 14 12 11.8l2.2 2.2"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 11.6a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
  more: '<circle cx="6" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18" cy="12" r="1.1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2.6-1.5L14.1 2.5h-4.2l-.4 2.5a7.5 7.5 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4.2l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.3.9 2-3.4z"/>',
  proposal: '<path d="M6 4.5v15M6 4.5a2 2 0 1 0 0 0zM18 19.5a2 2 0 1 0 0 0z"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M18 16V10a3 3 0 0 0-3-3h-4.5M12.5 4.5 10 7l2.5 2.5"/>',
  memory: '<path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-3.8-6 3.8v-16a1 1 0 0 1 1-1z"/>',
  file: '<path d="M7 3.5h7L18.5 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5V8.5h5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5z"/>',
  chevron: '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
  steps: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  spark: '<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4 18 18M6 18l2.6-2.6M15.4 8.6 18 6"/>',
  device: '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M8.5 19.5h7M12 16v3.5"/>',
  database: '<ellipse cx="12" cy="6.5" rx="7" ry="2.8"/><path d="M5 6.5v11c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-11M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
  eye: '<path d="M2.5 12C4.2 7.8 7.8 5 12 5s7.8 2.8 9.5 7c-1.7 4.2-5.3 7-9.5 7s-7.8-2.8-9.5-7z"/><circle cx="12" cy="12" r="3"/>',
  code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"/>',
  live: '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/>',
  paperclip: '<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  save: '<path d="M5 4.5h11l3.5 3.5V19a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5z"/><path d="M8 4.5v4h7v-4M8 19.5v-6h8v6"/>',
};
export const icon = (name: keyof typeof ICONS | string) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
/** A button that is only a symbol; its name is its accessible label and tooltip. */
export const iconButton = (name: string, label: string, extra = '', cls = '') =>
  `<button type="button" class="icon-button${cls ? ` ${cls}` : ''}" aria-label="${escape(label)}" title="${escape(label)}" ${extra}>${icon(name)}</button>`;

/** An item of a floating menu: a label with an optional icon, a danger style, a check mark, or a separator ('-'). */
export type MenuItem = '-' | { label: string; icon?: string; svg?: string; danger?: boolean; checked?: boolean; heading?: boolean; action?: () => void | Promise<void> };
let openMenu: { element: HTMLElement; anchor: HTMLElement; close: () => void } | undefined;
/** Closes the open floating menu, if any. */
export function closeMenu() { openMenu?.close(); }
/**
 * A floating menu under (or above, near the bottom of the window) its button. It closes on a choice, a click outside,
 * Escape or scrolling; the button is marked expanded while it is open.
 */
export function popMenu(anchor: HTMLElement, items: MenuItem[]) {
  const again = openMenu?.anchor === anchor;
  closeMenu();
  if (again) return;
  const menu = document.createElement('div');
  menu.className = 'pop-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === '-') { menu.append(document.createElement('hr')); continue; }
    if (item.heading) { const label = document.createElement('div'); label.className = 'menu-label'; label.textContent = item.label; menu.append(label); continue; }
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
    if (item.danger) button.className = 'danger';
    button.innerHTML = `${item.svg ?? (item.icon ? icon(item.icon) : '')}<span>${escape(item.label)}</span>`;
    button.addEventListener('click', () => { closeMenu(); if (item.action) void run(async () => { await item.action!(); }); });
    menu.append(button);
  }
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
  const below = box.bottom + 6 + height < window.innerHeight - 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${below ? box.bottom + 6 : Math.max(8, box.top - 6 - height)}px`;
  const row = anchor.closest<HTMLElement>('.conv-row, .project-row');
  row?.classList.add('menu-open');
  anchor.setAttribute('aria-expanded', 'true');
  const outside = (event: Event) => { if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) closeMenu(); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { closeMenu(); anchor.focus(); } };
  const scrolled = (event: Event) => { if (!menu.contains(event.target as Node)) closeMenu(); };
  const close = () => {
    menu.remove(); row?.classList.remove('menu-open'); anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); document.removeEventListener('scroll', scrolled, true);
    window.removeEventListener('resize', close);
    openMenu = undefined;
  };
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); document.addEventListener('scroll', scrolled, true);
  window.addEventListener('resize', close);
  openMenu = { element: menu, anchor, close };
  menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
}

let drawnPage = '';
/**
 * Draws a page in the content area: heading, optional tabs and actions, and an empty body that the module fills. A page
 * with tabs shows them in place of the module's title, which the sidebar already names. Redrawing the same page after an
 * action keeps the frame and the scroll position.
 */
export function page(content: HTMLElement, options: { title: string; subtitle?: string; tabs?: [string, string][]; actions?: string; back?: { href: string; label: string } }) {
  const key = JSON.stringify([options.title, options.subtitle, options.tabs, options.actions, options.back, location.pathname, document.documentElement.lang]);
  const existing = content.querySelector<HTMLDivElement>('#body');
  if (key === drawnPage && existing) return existing;
  drawnPage = key;
  // The current tab is the one whose address is the longest prefix of the path, so detail pages keep their tab marked.
  const current = options.tabs?.map(([href]) => href).filter(href => location.pathname === href || location.pathname.startsWith(href.endsWith('/') ? href : `${href}/`) || location.pathname === href.replace(/\/$/, ''))
    .sort((a, b) => b.length - a.length)[0];
  const tabs = options.tabs ? `<nav class="tabs">${options.tabs.map(([href, label]) =>
    `<a href="${href}" data-route ${href === current ? 'aria-current="page"' : ''}>${escape(label)}</a>`).join('')}</nav>` : '';
  const back = options.back ? `<a class="icon-button back" href="${options.back.href}" data-route aria-label="${escape(options.back.label)}" title="${escape(options.back.label)}">${icon('back')}</a>` : '';
  const head = options.tabs && !options.actions && !options.back ? ''
    : `<header class="page-head"><div class="title-row">${back}<h1>${escape(options.title)}${options.subtitle ? tip(options.subtitle) : ''}</h1></div>${options.actions ?? ''}</header>`;
  content.innerHTML = `<div class="page">${head}${tabs}<div id="body"></div></div>`;
  content.scrollTo(0, 0); window.scrollTo(0, 0);
  return content.querySelector<HTMLDivElement>('#body')!;
}
/** What scrolls the page: the content sheet on wide screens, the window on narrow ones. */
export function scroller(): Element {
  const content = document.getElementById('content');
  return content && getComputedStyle(content).overflowY === 'auto' ? content : document.scrollingElement!;
}
/** Relative time for recent events: "3 minutes ago", falling back to the date. */
export function ago(value: number, format: (value: number) => string, words: { now: string; minutes: (n: number) => string; hours: (n: number) => string; days: (n: number) => string }) {
  const seconds = Math.max(0, (Date.now() - value) / 1000);
  if (seconds < 60) return words.now;
  if (seconds < 3600) return words.minutes(Math.floor(seconds / 60));
  if (seconds < 86400) return words.hours(Math.floor(seconds / 3600));
  if (seconds < 7 * 86400) return words.days(Math.floor(seconds / 86400));
  return format(value);
}

/** Asks for one line of text, such as a note name; resolves to null when cancelled. */
export function askText(options: { title: string; label: string; value?: string; action: string }): Promise<string | null> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.innerHTML = `<form method="dialog" class="stack"><h2>${escape(options.title)}</h2><label>${escape(options.label)}<input name="value" autocomplete="off" data-bwignore data-1p-ignore data-lpignore="true" required></label><div class="buttons"><button type="button" data-answer="no">${escape(t('dialog.cancel'))}</button><button type="submit" class="primary">${escape(options.action)}</button></div></form>`;
    const field = dialog.querySelector<HTMLInputElement>('input')!;
    field.value = options.value ?? '';
    const close = (answer: string | null) => { dialog.close(); dialog.remove(); resolve(answer); };
    dialog.addEventListener('cancel', () => close(null));
    dialog.querySelector('[data-answer="no"]')!.addEventListener('click', () => close(null));
    dialog.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); close(field.value.trim() || null); });
    document.body.append(dialog);
    dialog.showModal();
    field.focus(); field.setSelectionRange(field.value.length, field.value.length);
  });
}
