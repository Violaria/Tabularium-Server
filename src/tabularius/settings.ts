// Tabularius's settings, edited by administrators on the web: the server's default prompt, the providers with their keys
// (sealed with TABULARIUS_SECRET_KEY, never returned), the models offered, the default model, the server's model
// parameters and the knowledge base. The first start imports what the environment configured; afterwards the
// application database is the source.
import type { DatabaseSync } from 'node:sqlite';
import { open, seal } from './client.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { anthropic, openai, vllm, type Provider } from './providers.js';
import { checkParams, ParamsError, type Params, type ProviderName } from './params.js';
import { DEFAULT_PROMPT } from './prompt.js';
import { KNOWLEDGE_DEFAULTS, listDatasets, ragflow, type KnowledgeBase, type KnowledgeSettings } from './knowledge.js';

export const PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'vllm'];
/** A model offered here: the provider's identifier, its name for people, and (vLLM) its context length. */
export interface ModelEntry { id: string; name: string; context?: number }
interface StoredProvider { key: string | null; hint: string; models: ModelEntry[]; url: string; context: number }
type Stored = Record<ProviderName, StoredProvider>;
export interface InitialSettings {
  providers?: Partial<Record<ProviderName, { key?: string; models: string[]; url?: string; context?: number }>>;
  defaultModel?: string;
  params?: Partial<Record<ProviderName, Params>>;
  knowledge?: { url: string; datasets: string[] };
}
export class SettingsError extends Error {}

const blank = (): StoredProvider => ({ key: null, hint: '', models: [], url: '', context: 32_768 });
/**
 * A model's name for people when the provider gives none (OpenAI lists identifiers only): "gpt-6.1-sol" reads
 * "GPT-6.1 Sol". Words starting with a digit, and o-series names such as "o3", keep their case.
 */
export function displayName(provider: ProviderName, id: string) {
  if (provider === 'vllm') return id;
  const words = id.split('-');
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === 'gpt') out.push(/^\d/.test(words[i + 1] ?? '') ? `GPT-${words[++i]}` : 'GPT');
    else if (/^\d|^o\d/.test(word)) out.push(word);
    else out.push(word.charAt(0).toUpperCase() + word.slice(1));
  }
  return out.join(' ');
}
// OpenAI lists every model of the account; these are not chat models.
const NOT_CHAT = /embedding|tts|whisper|dall-e|davinci|babbage|moderation|audio|realtime|transcribe|image|search|computer-use|sora/;
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
      return [name, { ...blank(), ...(given ? { key: given.key ? sealKey(given.key) : null, hint: given.key ? hintOf(given.key) : '', models: given.models.map(id => ({ id, name: displayName(name, id) })),
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
  // Lists saved before models carried names hold plain identifiers.
  const stored = () => {
    const all = read<Stored>('providers', { anthropic: blank(), openai: blank(), vllm: blank() });
    for (const name of PROVIDERS) all[name].models = all[name].models.map(item => typeof item === 'string' ? { id: item, name: displayName(name, item) } : item);
    return all;
  };
  /** A provider is usable once it has a key (Anthropic, OpenAI) or an address (vLLM). */
  const usable = (name: ProviderName, item: StoredProvider) => name === 'vllm' ? Boolean(item.url) : Boolean(item.key);
  function models() {
    const all = stored();
    return PROVIDERS.flatMap(name => usable(name, all[name]) ? all[name].models.map(model => ({ id: `${name}/${model.id}`, provider: name, model: model.id, name: model.name })) : []);
  }
  function defaultModel() {
    const list = models();
    // Only the administrator's choice: no model is picked on their behalf.
    const chosen = read('default_model', '');
    return list.some(item => item.id === chosen) ? chosen : '';
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
        const context = item.models.find(model => model.id === parsed.model)?.context ?? item.context;
        provider = parsed.provider === 'anthropic' ? anthropic(parsed.model, key)
          : parsed.provider === 'openai' ? openai(parsed.model, key) : vllm(parsed.model, item.url, key, context);
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
    /** The models a provider offers, asked from its API with the saved key (and address). */
    async available_models(name: ProviderName): Promise<ModelEntry[]> {
      const item = stored()[name];
      const key = item.key ? open(secret, Buffer.from(item.key, 'base64')) : undefined;
      if (name === 'anthropic') {
        if (!key) throw new SettingsError('Save the key first');
        const list: ModelEntry[] = [];
        for await (const model of new Anthropic({ apiKey: key }).models.list({ limit: 100 })) list.push({ id: model.id, name: model.display_name || displayName(name, model.id) });
        return list;
      }
      if (name === 'openai') {
        if (!key) throw new SettingsError('Save the key first');
        const list: ModelEntry[] = [];
        for await (const model of new OpenAI({ apiKey: key }).models.list()) if (!NOT_CHAT.test(model.id)) list.push({ id: model.id, name: displayName(name, model.id) });
        return list.sort((a, b) => b.id.localeCompare(a.id));
      }
      if (!item.url) throw new SettingsError('Save the address first');
      const list: ModelEntry[] = [];
      for await (const model of new OpenAI({ apiKey: key || 'none', baseURL: item.url }).models.list()) {
        const context = (model as unknown as { max_model_len?: number }).max_model_len;
        list.push({ id: model.id, name: model.id, ...(context ? { context } : {}) });
      }
      return list;
    },
    datasets: (url: string) => listDatasets(url),
    /** What the settings page shows: keys only as their last four characters. */
    view() {
      const all = stored();
      return {
        prompt: read('prompt', DEFAULT_PROMPT), defaultPrompt: DEFAULT_PROMPT, defaultModel: read('default_model', ''), params: read('params', {}),
        providers: Object.fromEntries(PROVIDERS.map(name => [name, { configured: usable(name, all[name]), keySet: Boolean(all[name].key), keyHint: all[name].hint,
          models: all[name].models, url: all[name].url }])),
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
            const valid = (model: unknown): model is ModelEntry => typeof model === 'object' && model !== null && typeof (model as ModelEntry).id === 'string'
              && /^[^\s/][^\s]{0,127}$/.test((model as ModelEntry).id) && typeof (model as ModelEntry).name === 'string' && (model as ModelEntry).name.length <= 128
              && ((model as ModelEntry).context === undefined || (Number.isInteger((model as ModelEntry).context) && (model as ModelEntry).context! > 0));
            if (!Array.isArray(item.models) || item.models.length > 100 || !item.models.every(valid)) throw new SettingsError('Invalid model list');
            next.models = (item.models as ModelEntry[]).filter((model, index, list) => list.findIndex(other => other.id === model.id) === index)
              .map(model => ({ id: model.id, name: model.name.trim() || displayName(name, model.id), ...(model.context ? { context: model.context } : {}) }));
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
