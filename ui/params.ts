// The model parameter form, built from the server's rule table (like Open WebUI's advanced parameters): one row per
// parameter, "Default" until it is switched to a custom value, then a control for its type. vLLM also takes custom
// parameters (a name and a JSON value). Only the parameters set to a custom value are saved.
import { catalogues, hasMessage, language, t } from './i18n.js';
import { escape, tip } from './core.js';

export type Rule =
  | { kind: 'number'; min: number; max: number; step: number; integer?: boolean; initial: number }
  | { kind: 'enum'; values: string[]; initial: string }
  | { kind: 'boolean'; initial: boolean }
  | { kind: 'list'; initial: string[] };
export type Params = Record<string, unknown>;
export type ProviderName = 'anthropic' | 'openai' | 'vllm';
export class FormError extends Error {}

const label = (name: string) => { const key = `param.${name}`; return hasMessage(key) ? t(key) : name; };
/** The parameter's English name, shown next to a Chinese or Latin one (as Open WebUI does); nothing in English. */
const englishName = (name: string) => {
  const key = `param.${name}`;
  return language() === 'en' || !hasMessage(key) ? '' : catalogues.en[key];
};
/** Providers as their makers write them. */
export const PROVIDER_NAMES: Record<ProviderName, string> = { anthropic: 'Anthropic', openai: 'OpenAI', vllm: 'vLLM' };
export interface ModelOption { id: string; provider: ProviderName; model: string; name: string }
/** The models as select options, grouped under their provider's name; `empty` adds a first option with the value ''. */
export function modelOptions(models: ModelOption[], selected: string, empty?: string) {
  const groups = (Object.keys(PROVIDER_NAMES) as ProviderName[]).map(provider => [provider, models.filter(m => m.provider === provider)] as const).filter(([, list]) => list.length);
  return (empty === undefined ? '' : `<option value="" ${selected ? '' : 'selected'}>${escape(empty)}</option>`)
    + groups.map(([provider, list]) => `<optgroup label="${PROVIDER_NAMES[provider]}">${list.map(m => `<option value="${escape(m.id)}" ${m.id === selected ? 'selected' : ''}>${escape(m.name)}</option>`).join('')}</optgroup>`).join('');
}
/** A model's name, from the models offered. */
export const modelName = (models: ModelOption[], id: string) => models.find(m => m.id === id)?.name ?? id;
const hint = (name: string) => { const key = `param.${name}Hint`; return hasMessage(key) ? t(key) : ''; };
const valueLabel = (value: string) => { const key = `param.value.${value}`; return hasMessage(key) ? t(key) : value; };
const shown = (rule: Rule, value: unknown) =>
  value === undefined ? '' : rule.kind === 'boolean' ? (value ? t('param.on') : t('param.off')) : rule.kind === 'enum' ? valueLabel(String(value))
    : rule.kind === 'list' ? (value as string[]).join(', ') || '—' : String(value);

/**
 * Draws the form into `root`. `defaults` are what applies when a parameter is left at default (the next level up);
 * returns a reader that throws FormError for a value out of range.
 */
export function paramForm(root: HTMLElement, provider: ProviderName, rules: Record<string, Rule>, defaults: Params, current: Params) {
  const values: Params = { ...current };
  const custom = Object.entries(current).filter(([name]) => !rules[name]).map(([name, value]) => ({ name, value: JSON.stringify(value) }));
  const draw = () => {
    root.innerHTML = `<div class="params">${Object.entries(rules).map(([name, rule]) => {
      const set = values[name] !== undefined;
      const title = hint(name);
      return `<div class="param" data-param="${escape(name)}"><div class="param-head"><span class="param-name"${title ? ` title="${escape(title)}" tabindex="0"` : ''}>${escape(label(name))}${englishName(name) ? ` <span class="param-en">${escape(englishName(name))}</span>` : ''}</span>`
        + `<button type="button" class="param-toggle${set ? ' custom' : ''}" data-toggle aria-pressed="${set}">${set && rule.kind === 'boolean' ? shown(rule, values[name])
          : set ? t('param.custom') : `${t('param.default')}${defaults[name] !== undefined ? ` · ${escape(shown(rule, defaults[name]))}` : ''}`}</button></div>`
        + (set && rule.kind !== 'boolean' ? `<div class="param-control">${control(name, rule, values[name])}</div>` : '') + '</div>';
    }).join('')}${provider === 'vllm' ? `<div class="custom-params"><h4>${t('param.customTitle')}${tip(t('param.customHint'))}</h4>${custom.map((item, index) =>
      `<div class="custom-param" data-custom="${index}"><input aria-label="${t('param.customName')}" placeholder="${t('param.customName')}" value="${escape(item.name)}" data-field="name"><input aria-label="${t('param.customValue')}" placeholder='{"a": 1}' value="${escape(item.value)}" data-field="value"><button type="button" class="link" data-remove>${t('param.remove')}</button></div>`).join('')}<button type="button" data-add>${t('param.add')}</button></div>` : ''}</div>`;
    for (const row of root.querySelectorAll<HTMLElement>('[data-param]')) {
      const name = row.dataset.param!;
      const rule = rules[name];
      row.querySelector('[data-toggle]')!.addEventListener('click', () => {
        // On and off settings cycle default → on → off; the others switch between default and a custom value.
        if (rule.kind === 'boolean') values[name] = values[name] === undefined ? true : values[name] === true ? false : undefined;
        else values[name] = values[name] === undefined ? defaults[name] ?? rule.initial : undefined;
        if (values[name] === undefined) delete values[name];
        draw();
      });
      for (const input of row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
        input.addEventListener('input', () => {
          if (rule.kind === 'number') {
            const number = Number(input.value);
            values[name] = input.value === '' ? Number.NaN : number;
            for (const other of row.querySelectorAll<HTMLInputElement>('input')) if (other !== input) other.value = input.value;
          } else if (rule.kind === 'enum') values[name] = input.value;
        });
      }
      if (rule.kind === 'list') {
        const add = (text: string) => {
          const items = (values[name] as string[]) ?? [];
          if (text && !items.includes(text)) values[name] = [...items, text];
          draw();
          root.querySelector<HTMLInputElement>(`[data-param="${CSS.escape(name)}"] input`)?.focus();
        };
        const input = row.querySelector<HTMLInputElement>('input');
        input?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(input.value.trim()); } });
        for (const remove of row.querySelectorAll<HTMLButtonElement>('[data-tag]')) remove.addEventListener('click', () => {
          values[name] = (values[name] as string[]).filter(item => item !== remove.dataset.tag);
          draw();
        });
      }
    }
    for (const row of root.querySelectorAll<HTMLElement>('[data-custom]')) {
      const item = custom[Number(row.dataset.custom)];
      for (const input of row.querySelectorAll<HTMLInputElement>('input')) input.addEventListener('input', () => { item[input.dataset.field as 'name' | 'value'] = input.value; });
      row.querySelector('[data-remove]')!.addEventListener('click', () => { custom.splice(Number(row.dataset.custom), 1); draw(); });
    }
    root.querySelector('[data-add]')?.addEventListener('click', () => { custom.push({ name: '', value: '' }); draw(); });
  };
  draw();
  /** The custom values; throws when one is out of range or a custom parameter is not valid JSON. */
  return (): Params => {
    const result: Params = {};
    for (const [name, value] of Object.entries(values)) {
      const rule = rules[name];
      if (!rule) continue;
      if (rule.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value))))
        throw new FormError(t('param.outOfRange', { name: label(name), min: rule.min, max: rule.max }));
      result[name] = value;
    }
    for (const item of custom) {
      if (!item.name.trim()) continue;
      try { result[item.name.trim()] = JSON.parse(item.value); } catch { throw new FormError(t('param.invalidJson', { name: item.name })); }
    }
    return result;
  };
}

function control(name: string, rule: Rule, value: unknown) {
  if (rule.kind === 'number') {
    const attributes = `min="${rule.min}" max="${rule.max}" step="${rule.step}" value="${escape(String(value))}"`;
    return `<input type="range" aria-label="${escape(label(name))}" ${attributes}><input type="number" class="param-number" aria-label="${escape(label(name))}" ${attributes}>`;
  }
  if (rule.kind === 'enum') return `<select aria-label="${escape(label(name))}">${rule.values.map(item => `<option value="${escape(item)}" ${item === value ? 'selected' : ''}>${escape(valueLabel(item))}</option>`).join('')}</select>`;
  const items = (value as string[]) ?? [];
  return `<div class="tags">${items.map(item => `<span class="tag">${escape(item)}<button type="button" class="link" data-tag="${escape(item)}" aria-label="${escape(t('param.remove'))}">×</button></span>`).join('')}<input aria-label="${escape(label(name))}" placeholder="${escape(t('param.tagHint'))}"></div>`;
}

/** A parameter's name in the interface language. */
export const paramLabel = label;
