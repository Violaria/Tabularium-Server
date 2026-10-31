// Tabularius's settings, edited by administrators on the web: the server's default prompt, the providers with their keys
// (sealed with TABULARIUS_SECRET_KEY, never returned), the models offered, the default model, the server's model
// parameters and the knowledge base. The first start imports what the environment configured; afterwards the
// application database is the source.
import type { DatabaseSync } from 'node:sqlite';
import { open, seal } from './client.js';
import { anthropic, openai, vllm, type Provider } from './providers.js';
import { checkParams, ParamsError, type Params, type ProviderName } from './params.js';
import { DEFAULT_PROMPT } from './prompt.js';
import { KNOWLEDGE_DEFAULTS, listDatasets, ragflow, type KnowledgeBase, type KnowledgeSettings } from './knowledge.js';

export const PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'vllm'];
interface StoredProvider { key: string | null; hint: string; models: string[]; url: string; context: number }
type Stored = Record<ProviderName, StoredProvider>;
export interface InitialSettings {
  providers?: Partial<Record<ProviderName, { key?: string; models: string[]; url?: string; context?: number }>>;
  defaultModel?: string;
  params?: Partial<Record<ProviderName, Params>>;
  knowledge?: { url: string; datasets: string[] };
}
export class SettingsError extends Error {}

const blank = (): StoredProvider => ({ key: null, hint: '', models: [], url: '', context: 32_768 });
/** "provider/model"; the model part may itself contain slashes (vLLM model names often do). */
export function parseModel(id: string) {
  const at = id.indexOf('/');
  const provider = id.slice(0, at) as ProviderName;
  return at > 0 && PROVIDERS.includes(provider) ? { provider, model: id.slice(at + 1) } : undefined;
}

export function createSettings(db: DatabaseSync, secret: Buffer, initial: InitialSettings = {}) {
  const read = <T>(name: string, fallback: T): T => {
    const row = db.prepare('SELECT value FROM tabularius_settings WHERE key=?').get(name) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  };
  const write = (name: string, value: unknown) =>
    db.prepare('INSERT INTO tabularius_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value));
  const sealKey = (key: string) => seal(secret, key).toString('base64');
  const hintOf = (key: string) => key.length > 8 ? key.slice(-4) : '';

  // The first start with these settings takes the environment's configuration.
  if (!db.prepare("SELECT 1 FROM tabularius_settings WHERE key='providers'").get()) {
    const providers = Object.fromEntries(PROVIDERS.map(name => {
      const given = initial.providers?.[name];
      return [name, { ...blank(), ...(given ? { key: given.key ? sealKey(given.key) : null, hint: given.key ? hintOf(given.key) : '', models: given.models,
        url: given.url ?? '', context: given.context ?? 32_768 } : {}) }];
    })) as Stored;
    db.exec('BEGIN');
    write('providers', providers);
    write('prompt', DEFAULT_PROMPT);
    write('default_model', initial.defaultModel ?? '');
    write('params', initial.params ?? {});
    write('knowledge', initial.knowledge ? { ...KNOWLEDGE_DEFAULTS, ...initial.knowledge } : null);
    db.exec('COMMIT');
  }

  let cache = new Map<string, Provider>();
  let knowledgeBase: KnowledgeBase | undefined;
  const stored = () => read<Stored>('providers', { anthropic: blank(), openai: blank(), vllm: blank() });
  /** A provider is usable once it has a key (Anthropic, OpenAI) or an address (vLLM). */
  const usable = (name: ProviderName, item: StoredProvider) => name === 'vllm' ? Boolean(item.url) : Boolean(item.key);
  function models() {
    const all = stored();
    return PROVIDERS.flatMap(name => usable(name, all[name]) ? all[name].models.map(model => ({ id: `${name}/${model}`, provider: name, model })) : []);
  }
  function defaultModel() {
    const list = models();
    const chosen = read('default_model', '');
    return list.some(item => item.id === chosen) ? chosen : list[0]?.id ?? '';
  }
  const knowledgeSettings = () => read<KnowledgeSettings | null>('knowledge', null);

  return {
    models, defaultModel,
    prompt: () => read('prompt', DEFAULT_PROMPT),
    /** The server's parameters for one provider. */
    params: (name: ProviderName): Params => read<Partial<Record<ProviderName, Params>>>('params', {})[name] ?? {},
    available: (id: string) => models().some(item => item.id === id),
    /** The provider for a model offered here; created on first use and again after the settings change. */
    provider(id: string): Provider {
      const parsed = parseModel(id);
      if (!parsed || !models().some(item => item.id === id)) throw new SettingsError('Model not available');
      let provider = cache.get(id);
      if (!provider) {
        const item = stored()[parsed.provider];
        const key = item.key ? open(secret, Buffer.from(item.key, 'base64')) : undefined;
        provider = parsed.provider === 'anthropic' ? anthropic(parsed.model, key)
          : parsed.provider === 'openai' ? openai(parsed.model, key) : vllm(parsed.model, item.url, key, item.context);
        cache.set(id, provider);
      }
      return provider;
    },
    knowledge(): KnowledgeBase | undefined {
      const settings = knowledgeSettings();
      if (!settings?.url) return undefined;
      knowledgeBase ??= ragflow(settings);
      return knowledgeBase;
    },
    knowledgeConfigured: () => Boolean(knowledgeSettings()?.url),
    datasets: (url: string) => listDatasets(url),
    /** What the settings page shows: keys only as their last four characters. */
    view() {
      const all = stored();
      return {
        prompt: read('prompt', DEFAULT_PROMPT), defaultPrompt: DEFAULT_PROMPT, defaultModel: read('default_model', ''), params: read('params', {}),
        providers: Object.fromEntries(PROVIDERS.map(name => [name, { configured: usable(name, all[name]), keySet: Boolean(all[name].key), keyHint: all[name].hint,
          models: all[name].models, url: all[name].url, context: all[name].context }])),
        knowledge: knowledgeSettings() ?? { url: '', datasets: [], ...KNOWLEDGE_DEFAULTS },
      };
    },
    /** Saves what the page sent. A key is replaced only when one is given; an empty key removes it. */
    async update(data: Record<string, unknown>) {
      const all = stored();
      if (data.providers !== undefined) {
        const given = data.providers as Record<string, Record<string, unknown>>;
        if (typeof given !== 'object' || given === null) throw new SettingsError('Invalid providers');
        for (const name of PROVIDERS) {
          const item = given[name];
          if (item === undefined) continue;
          const next = { ...all[name] };
          if (item.key !== undefined) {
            if (typeof item.key !== 'string' || item.key.length > 512) throw new SettingsError('Invalid key');
            next.key = item.key ? sealKey(item.key.trim()) : null;
            next.hint = item.key ? hintOf(item.key.trim()) : '';
          }
          if (item.models !== undefined) {
            if (!Array.isArray(item.models) || item.models.length > 50 || !item.models.every(model => typeof model === 'string' && /^[^\s/][^\s]{0,127}$/.test(model)))
              throw new SettingsError('Invalid model list');
            next.models = [...new Set(item.models as string[])];
          }
          if (item.url !== undefined) {
            if (typeof item.url !== 'string' || (item.url && !/^https?:\/\/\S+$/.test(item.url))) throw new SettingsError('Invalid address');
            next.url = item.url.replace(/\/$/, '');
          }
          if (item.context !== undefined) {
            if (!Number.isInteger(item.context) || (item.context as number) < 2048 || (item.context as number) > 2_000_000) throw new SettingsError('Invalid context length');
            next.context = item.context as number;
          }
          all[name] = next;
        }
      }
      if (data.prompt !== undefined && (typeof data.prompt !== 'string' || data.prompt.length > 60_000)) throw new SettingsError('Invalid prompt');
      let params: Record<string, Params> | undefined;
      if (data.params !== undefined) {
        if (typeof data.params !== 'object' || data.params === null) throw new SettingsError('Invalid parameters');
        params = {};
        for (const name of PROVIDERS) {
          try { params[name] = checkParams(name, (data.params as Record<string, unknown>)[name]); } catch (error) {
            if (error instanceof ParamsError) throw new SettingsError(`Invalid parameters: ${error.message}`);
            throw error;
          }
        }
      }
      let knowledge: KnowledgeSettings | null | undefined;
      if (data.knowledge !== undefined) {
        const k = data.knowledge as Record<string, unknown> | null;
        if (k === null || !k.url) knowledge = null;
        else {
          const numberIn = (value: unknown, min: number, max: number, integer = false) => typeof value === 'number' && value >= min && value <= max && (!integer || Number.isInteger(value));
          if (typeof k.url !== 'string' || !/^https?:\/\/\S+$/.test(k.url) || !Array.isArray(k.datasets) || !k.datasets.every(id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id))
            || !numberIn(k.limit, 1, 50, true) || !numberIn(k.threshold, 0, 1) || !numberIn(k.weight, 0, 1) || typeof k.keyword !== 'boolean'
            || !numberIn(k.topK, 1, 1024, true) || typeof k.rerank !== 'string' || k.rerank.length > 128) throw new SettingsError('Invalid knowledge base settings');
          knowledge = { url: k.url, datasets: k.datasets as string[], limit: k.limit as number, threshold: k.threshold as number, weight: k.weight as number,
            keyword: k.keyword, topK: k.topK as number, rerank: k.rerank };
        }
      }
      if (data.defaultModel !== undefined && typeof data.defaultModel !== 'string') throw new SettingsError('Invalid default model');
      db.exec('BEGIN');
      write('providers', all);
      if (data.prompt !== undefined) write('prompt', data.prompt);
      if (params) write('params', params);
      if (knowledge !== undefined) write('knowledge', knowledge);
      if (data.defaultModel !== undefined) write('default_model', data.defaultModel);
      db.exec('COMMIT');
      if (data.defaultModel && !models().some(item => item.id === data.defaultModel)) write('default_model', '');
      // Later requests use the new settings.
      cache = new Map();
      if (knowledge !== undefined) { await knowledgeBase?.close().catch(() => {}); knowledgeBase = undefined; }
    },
    async close() { await knowledgeBase?.close(); },
  };
}
export type Settings = ReturnType<typeof createSettings>;
