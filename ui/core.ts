// Shared pieces of the web application: session, API calls, notices, forms, the confirmation dialog and navigation.
import { serverError, t } from './i18n.js';

export interface User { id: string; username: string; role: 'admin' | 'user'; disabled: boolean; mustChangePassword: boolean; theme: string }
export interface Session { user: User; csrf: string }

export const state: { session?: Session } = {};

/** Colour themes of the web pages; forest is the default. */
export const THEMES = ['forest', 'sakura', 'lavender'] as const;
/** Accounts that have not chosen a theme, and the sign-in page before anyone has signed in here, use this one. */
export const DEFAULT_THEME = 'sakura';
const THEME_KEY = 'tabularium-theme';
/** Applies a colour theme ('' for the default) and remembers it in this browser, so the next page load starts in it. */
export function applyTheme(theme: string) {
  const shown = theme || DEFAULT_THEME;
  if (shown !== 'forest') document.documentElement.dataset.theme = shown; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable: the theme lasts for this page */ }
}
let savedTheme = '';
try { savedTheme = localStorage.getItem(THEME_KEY) ?? ''; } catch { /* storage unavailable */ }
applyTheme(savedTheme);
let expired = () => {};
let route = () => {};
/** The shell registers what happens when the session ends and how a path is drawn. */
export function connect(handlers: { expired: () => void; route: () => void }) { expired = handlers.expired; route = handlers.route; }

export const escape = (value: string | number) =>
  String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export const bytes = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GiB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`;

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(state.session ? { 'x-csrf-token': state.session.csrf } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, serverError(result.error));
  return result as T;
}

/** The notice under the page heading; it sticks to the top while scrolling. */
export function message(text: string, error = false) {
  const target = document.querySelector<HTMLDivElement>('#message');
  if (!target) return;
  target.className = error ? 'notice error' : 'notice'; target.textContent = text; target.hidden = false;
}
export function clearMessage() { const target = document.querySelector<HTMLDivElement>('#message'); if (target) target.hidden = true; }

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

/** Line icons drawn inline, so the pages need no icon font or third-party assets. */
const ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  assistant: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 10h8M8 13h5"/>',
  admin: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
};
export const icon = (name: keyof typeof ICONS | string) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

let drawnPage = '';
/**
 * Draws a page in the content area: heading, optional tabs and actions, the notice, and an empty body that the module
 * fills. Redrawing the same page after an action keeps the frame and the scroll position.
 */
export function page(content: HTMLElement, options: { title: string; subtitle?: string; tabs?: [string, string][]; actions?: string }) {
  const key = JSON.stringify([options.title, options.subtitle, options.tabs, options.actions, location.pathname, document.documentElement.lang]);
  const existing = content.querySelector<HTMLDivElement>('#body');
  if (key === drawnPage && existing) { clearMessage(); return existing; }
  drawnPage = key;
  // The current tab is the one whose address is the longest prefix of the path, so detail pages keep their tab marked.
  const current = options.tabs?.map(([href]) => href).filter(href => location.pathname === href || location.pathname.startsWith(href.endsWith('/') ? href : `${href}/`) || location.pathname === href.replace(/\/$/, ''))
    .sort((a, b) => b.length - a.length)[0];
  const tabs = options.tabs ? `<nav class="tabs">${options.tabs.map(([href, label]) =>
    `<a href="${href}" data-route ${href === current ? 'aria-current="page"' : ''}>${escape(label)}</a>`).join('')}</nav>` : '';
  content.innerHTML = `<div class="page"><header class="page-head"><div><h1>${escape(options.title)}</h1>${options.subtitle ? `<p>${escape(options.subtitle)}</p>` : ''}</div>${options.actions ?? ''}</header>${tabs}<div id="message" role="status" hidden></div><div id="body"></div></div>`;
  window.scrollTo(0, 0);
  return content.querySelector<HTMLDivElement>('#body')!;
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
    dialog.innerHTML = `<form method="dialog" class="stack"><h2>${escape(options.title)}</h2><label>${escape(options.label)}<input name="value" autocomplete="off" required></label><div class="buttons"><button type="button" data-answer="no">${escape(t('dialog.cancel'))}</button><button type="submit" class="primary">${escape(options.action)}</button></div></form>`;
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
