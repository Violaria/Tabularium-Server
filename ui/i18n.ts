// Language selection and lookup for the web pages; the texts are in messages.ts.
import { catalogues, type Language, type MessageKey } from './messages.js';

export { catalogues, type Language, type MessageKey };
export const LANGUAGES: Language[] = ['en', 'zh', 'la'];
const STORAGE_KEY = 'tabularium-language';

function detect(): Language {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return 'zh';
    if (lower === 'la' || lower.startsWith('la-')) return 'la';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

/** The chosen language: saved in this browser for every page of the server, otherwise from the browser's languages. */
export function language(): Language {
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable: use the browser's languages */ }
  return saved && (LANGUAGES as string[]).includes(saved) ? saved as Language : detect();
}

export function setLanguage(next: Language) {
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable: the choice lasts for this page */ }
  current = next;
  document.documentElement.lang = next;
}

let current = language();
document.documentElement.lang = current;

/** The text for `key` in the current language; `{name}` placeholders are replaced from `params`. */
export function t(key: MessageKey, params: Record<string, string | number> = {}) {
  return catalogues[current][key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export const hasMessage = (key: string): key is MessageKey => key in catalogues.en;

/** Translation of a server error code; unknown codes are shown as sent. */
export function serverError(code: string) {
  const key = `error.${code}`;
  return hasMessage(key) ? t(key) : code;
}

/** Book or note titles as a list: 《…》 joined by 、 in Chinese, quoted and comma-separated otherwise. */
export function titles(items: string[]) {
  return current === 'zh' ? items.map(item => `《${item}》`).join('、') : items.map(item => `“${item}”`).join(', ');
}

/** Date and time in the current language. */
export function formatDate(value: number) {
  return new Date(value).toLocaleString(current === 'zh' ? 'zh-CN' : current === 'la' ? 'la' : 'en-GB', { hour12: false });
}

/** A language selector; `changed` re-renders the page after a choice. */
export function languageSelect(changed: () => void) {
  const select = document.createElement('select');
  select.className = 'language-select';
  select.setAttribute('aria-label', t('language.label'));
  for (const code of LANGUAGES) select.add(new Option(catalogues[code][`language.${code}`], code, false, code === current));
  select.addEventListener('change', () => { setLanguage(select.value as Language); changed(); });
  return select;
}
