// Tabularius's settings, edited by administrators on the web: the server's default prompt, the providers with their keys
// (sealed with TABULARIUS_SECRET_KEY, never returned), the models offered, the recipes (a model with parameters and a
// prompt) with the default one, and the knowledge base. The first start imports what the environment configured;
// afterwards the application database is the source.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { open, seal } from './client.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { anthropic, deepseek, gemini, ollama, openai, vllm, type Provider } from './providers.js';
import { checkParams, ParamsError, type Params, type ProviderName } from './params.js';
import { FORMER_PROMPT_LINES, PROMPT_TEMPLATE } from './prompt.js';
import { embedder as createEmbedder } from './providers.js';
import type { Embedder } from './search.js';
import type { Mode } from './index.js';
import { KNOWLEDGE_DEFAULTS, listDatasets, ragflow, type KnowledgeBase, type KnowledgeSettings } from './knowledge.js';

export const PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'gemini', 'deepseek', 'vllm', 'ollama'];
/** Providers on this network, reached at an address with an optional key; the others need a key. */
const LOCAL: ProviderName[] = ['vllm', 'ollama'];
/** A model offered here: the provider's identifier, its name for people, and (vLLM) its context length. */
/** `vision`: whether the model reads images (the APIs do not say; the administrator marks it). */
export interface ModelEntry { id: string; name: string; context?: number; vision?: boolean }
/**
 * Anthropic, OpenAI and Gemini chat models read images; DeepSeek and vLLM models are marked by the administrator; Ollama
 * reports it per model (the model list carries it).
 */
const visionDefault = (name: ProviderName) => name === 'anthropic' || name === 'openai' || name === 'gemini';
/** Ollama's context length when neither the recipe nor a smaller model limit sets one; Ollama advises 32k for tool use. */
const OLLAMA_CONTEXT = 32_768;
interface StoredProvider { key: string | null; hint: string; models: ModelEntry[]; url: string; context: number }
type Stored = Record<ProviderName, StoredProvider>;
export interface InitialSettings {
  providers?: Partial<Record<ProviderName, { key?: string; models: string[]; url?: string; context?: number }>>;
  defaultModel?: string;
  params?: Partial<Record<ProviderName, Params>>;
  knowledge?: { url: string; datasets: string[] };
  embedding?: { url?: string; key?: string; model: string; batch?: number };
  web?: WebSettings;
  limits?: Partial<Limits>;
}
/** Web lookup: Claude and OpenAI search themselves; other models use SearXNG and the server's fetch. */
export interface WebSettings { enabled: boolean; searxng: string; allowed: string[]; blocked: string[]; maxUses: number; intranet: string[] }
/** The highest permission mode, how long a command may run over SSH, and the images the sandbox may run. */
export interface Limits { modeLimit: Mode; sshTimeout: number; sandboxImages: string[]; attachmentMegabytes: number }
interface StoredEmbedding { url: string; key: string | null; hint: string; model: string; batch: number }
/** A named way of answering: a model offered here, its parameters and a prompt added to the vault's. */
export interface Recipe { id: string; name: string; model: string; params: Params; prompt: string }
export class SettingsError extends Error {}

const blank = (): StoredProvider => ({ key: null, hint: '', models: [], url: '', context: 32_768 });
/**
 * A model's name for people when the provider gives none (OpenAI lists identifiers only): "gpt-6.1-sol" reads
 * "GPT-6.1 Sol". Words starting with a digit, and o-series names such as "o3", keep their case.
 */
export function displayName(provider: ProviderName, id: string) {
  if (LOCAL.includes(provider)) return id;
  const words = id.split('-');
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === 'gpt') out.push(/^\d/.test(words[i + 1] ?? '') ? `GPT-${words[++i]}` : 'GPT');
    else if (word === 'deepseek') out.push('DeepSeek');
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

/** Gemini's models that generate content, with the names Google gives them. */
async function geminiModels(key: string): Promise<ModelEntry[]> {
  const base = (process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const list: ModelEntry[] = [];
  let page = '';
  do {
    const response = await fetch(`${base}/v1beta/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, { headers: { 'x-goog-api-key': key } });
    const body = await response.json() as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string; error?: { message: string } };
    if (!response.ok) throw new SettingsError(`Gemini ${response.status} ${body.error?.message ?? ''}`.trim());
    for (const model of body.models ?? []) if (model.supportedGenerationMethods?.includes('generateContent'))
      list.push({ id: model.name.replace(/^models\//, ''), name: model.displayName || model.name.replace(/^models\//, '') });
    page = body.nextPageToken ?? '';
  } while (page);
  return list;
}
/** The models Ollama has, each with its context length and whether it reads images (from /api/show). */
async function ollamaModels(url: string, key?: string): Promise<ModelEntry[]> {
  const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const ask = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new SettingsError(`Ollama ${response.status} ${(await response.text()).slice(0, 300)}`.trim());
    return await response.json() as T;
  };
  const { models } = await ask<{ models: { name: string }[] }>('/api/tags');
  return Promise.all(models.map(async ({ name }) => {
    const shown = await ask<{ model_info?: Record<string, unknown>; capabilities?: string[] }>('/api/show', { model: name });
    const context = Object.entries(shown.model_info ?? {}).find(([field]) => field.endsWith('.context_length'))?.[1];
    return { id: name, name, ...(typeof context === 'number' ? { context } : {}), vision: Boolean(shown.capabilities?.includes('vision')) };
  }));
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
  // Settings added after the first start are imported on their own first start.
  const missing = (name: string) => !db.prepare('SELECT 1 FROM tabularius_settings WHERE key=?').get(name);
  if (missing('embedding')) write('embedding', initial.embedding
    ? { url: initial.embedding.url ?? '', key: initial.embedding.key ? sealKey(initial.embedding.key) : null, hint: initial.embedding.key ? hintOf(initial.embedding.key) : '',
      model: initial.embedding.model, batch: initial.embedding.batch ?? 64 } satisfies StoredEmbedding : null);
  if (missing('web')) write('web', initial.web ?? { enabled: false, searxng: '', allowed: [], blocked: [], maxUses: 5, intranet: [] });
  if (missing('limits')) write('limits', { modeLimit: 'read-only', sshTimeout: 60, sandboxImages: ['python:3.13-slim', 'node:24-slim', 'alpine:3'], attachmentMegabytes: 20, ...initial.limits } satisfies Limits);
  let embedderCache: { key: string; embedder: Embedder } | undefined;

  // The first start with these settings takes the environment's configuration.
  if (!db.prepare("SELECT 1 FROM tabularius_settings WHERE key='providers'").get()) {
    const providers = Object.fromEntries(PROVIDERS.map(name => {
      const given = initial.providers?.[name];
      return [name, { ...blank(), ...(given ? { key: given.key ? sealKey(given.key) : null, hint: given.key ? hintOf(given.key) : '', models: given.models.map(id => ({ id, name: displayName(name, id) })),
        url: given.url ?? '', context: given.context ?? 32_768 } : {}) }];
    })) as Stored;
    db.exec('BEGIN');
    write('providers', providers);
    write('prompt', '');
    write('default_model', initial.defaultModel ?? '');
    write('params', initial.params ?? {});
    write('knowledge', initial.knowledge ? { ...KNOWLEDGE_DEFAULTS, ...initial.knowledge } : null);
    db.exec('COMMIT');
  }

  // Lines of the default prompt that changed with a release, replaced where the stored prompt still has them as written.
  // The vault prompts too: the curation rules may have been moved there.
  const updateLines = (prompt: string) => FORMER_PROMPT_LINES.reduce((text, [former, current]) => text.replace(former, current), prompt);
  const storedPrompt = read('prompt', '');
  if (updateLines(storedPrompt) !== storedPrompt) write('prompt', updateLines(storedPrompt));
  for (const { vault_id, prompt } of db.prepare('SELECT vault_id, prompt FROM tabularius_vaults').all() as { vault_id: string; prompt: string }[])
    if (updateLines(prompt) !== prompt) db.prepare('UPDATE tabularius_vaults SET prompt=? WHERE vault_id=?').run(updateLines(prompt), vault_id);

  let cache = new Map<string, Provider>();
  let knowledgeBase: KnowledgeBase | undefined;
  // Lists saved before models carried names hold plain identifiers.
  const stored = () => {
    // Providers added after the settings were saved start blank.
    const all = { ...Object.fromEntries(PROVIDERS.map(name => [name, blank()])), ...read<Partial<Stored>>('providers', {}) } as Stored;
    for (const name of PROVIDERS) all[name].models = all[name].models.map(item => typeof item === 'string' ? { id: item, name: displayName(name, item) } : item)
      // Models chosen before image support was marked get the provider's default.
      .map(item => ({ ...item, vision: item.vision ?? visionDefault(name) }));
    return all;
  };
  /** A provider is usable once it has a key, or an address for a local one. */
  const usable = (name: ProviderName, item: StoredProvider) => LOCAL.includes(name) ? Boolean(item.url) : Boolean(item.key);
  function models() {
    const all = stored();
    return PROVIDERS.flatMap(name => usable(name, all[name]) ? all[name].models.map(model => ({ id: `${name}/${model.id}`, provider: name, model: model.id, name: model.name, vision: model.vision ?? visionDefault(name) })) : []);
  }
  const recipes = () => read<Recipe[]>('recipes', []);
  /** A recipe that can answer now: it exists and its model is offered. */
  const usableRecipe = (id: string | null | undefined) => {
    if (!id) return undefined;
    const recipe = recipes().find(item => item.id === id);
    return recipe && models().some(item => item.id === recipe.model) ? recipe : undefined;
  };
  /** A recipe named after its model; a second one with the same name gets a number. */
  const nameFor = (model: string, taken: string[]) => {
    const parsed = parseModel(model)!;
    const base = models().find(item => item.id === model)?.name ?? displayName(parsed.provider, parsed.model);
    let name = base;
    for (let n = 2; taken.includes(name); n++) name = `${base} ${n}`;
    return name;
  };
  const knowledgeSettings = () => read<KnowledgeSettings | null>('knowledge', null);
  // Limits saved before attachments existed get their size limit.
  const limits = (): Limits => ({ attachmentMegabytes: 20, ...read<Partial<Limits>>('limits', { modeLimit: 'read-only', sshTimeout: 60, sandboxImages: [] }) } as Limits);

  return {
    models, recipes, usableRecipe,
    /** The administrator's default recipe, when it can answer; no recipe is picked on their behalf. */
    defaultRecipe: () => usableRecipe(read('default_recipe', ''))?.id ?? '',
    /**
     * Once, when recipes arrive: the default model with its provider's server parameters becomes the default recipe, and
     * each other model with parameters that `used` lists (a vault's or a conversation's) becomes a recipe. Returns the
     * recipe for each entry of `used`, so behaviour does not change.
     */
    upgradeToRecipes(used: { model: string; params: Params }[]) {
      if (!missing('recipes')) return undefined;
      const made: Recipe[] = [];
      const serverParams = read<Partial<Record<ProviderName, Params>>>('params', {});
      const recipeFor = (model: string, params: Params) => {
        const same = made.find(item => item.model === model && JSON.stringify(item.params) === JSON.stringify(params));
        if (same) return same.id;
        const recipe = { id: randomUUID(), name: nameFor(model, made.map(item => item.name)), model, params, prompt: '' };
        made.push(recipe);
        return recipe.id;
      };
      const defaultModel = read('default_model', '');
      const parsed = parseModel(defaultModel);
      const defaultId = parsed ? recipeFor(defaultModel, serverParams[parsed.provider] ?? {}) : '';
      const ids = used.map(item => parseModel(item.model) ? recipeFor(item.model, { ...serverParams[parseModel(item.model)!.provider], ...item.params }) : null);
      db.exec('BEGIN');
      write('recipes', made);
      write('default_recipe', defaultId);
      db.exec('COMMIT');
      return ids;
    },
    prompt: () => read('prompt', ''),
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
        // Gemini's own search cannot keep to a domain list; with one configured it searches through SearXNG instead.
        const web = read<WebSettings>('web', { enabled: false, searxng: '', allowed: [], blocked: [], maxUses: 5, intranet: [] });
        provider = parsed.provider === 'anthropic' ? anthropic(parsed.model, key)
          : parsed.provider === 'openai' ? openai(parsed.model, key)
          : parsed.provider === 'gemini' ? gemini(parsed.model, key!, !web.allowed.length && !web.blocked.length)
          : parsed.provider === 'deepseek' ? deepseek(parsed.model, key!)
          : parsed.provider === 'ollama' ? ollama(parsed.model, item.url, key, Math.min(item.models.find(model => model.id === parsed.model)?.context ?? OLLAMA_CONTEXT, OLLAMA_CONTEXT))
          : vllm(parsed.model, item.url, key, context);
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
    /** The embedding service for semantic search, or undefined for full-text search only. */
    embedder(): Embedder | undefined {
      const e = read<StoredEmbedding | null>('embedding', null);
      if (!e?.model) return undefined;
      const cacheKey = JSON.stringify(e);
      if (embedderCache?.key !== cacheKey) {
        const key = e.key ? open(secret, Buffer.from(e.key, 'base64')) : undefined;
        embedderCache = { key: cacheKey, embedder: createEmbedder(e.model, e.url || undefined, key, e.batch) };
      }
      return embedderCache.embedder;
    },
    web: () => read<WebSettings>('web', { enabled: false, searxng: '', allowed: [], blocked: [], maxUses: 5, intranet: [] }),
    limits: () => limits(),
    /** Embedding models offered by the configured service (OpenAI, or the OpenAI-compatible address). */
    async embeddingModels(): Promise<ModelEntry[]> {
      const e = read<StoredEmbedding | null>('embedding', null);
      const key = e?.key ? open(secret, Buffer.from(e.key, 'base64')) : undefined;
      if (!e?.url && !key) throw new SettingsError('Save the key first');
      const list: ModelEntry[] = [];
      for await (const model of new OpenAI({ apiKey: key || 'none', ...(e?.url ? { baseURL: e.url } : {}) }).models.list()) {
        if (e?.url || /embedding/.test(model.id)) list.push({ id: model.id, name: e?.url ? model.id : displayName('openai', model.id) });
      }
      return list;
    },
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
      if (name === 'gemini') {
        if (!key) throw new SettingsError('Save the key first');
        return geminiModels(key);
      }
      if (name === 'deepseek') {
        if (!key) throw new SettingsError('Save the key first');
        const list: ModelEntry[] = [];
        for await (const model of new OpenAI({ apiKey: key, baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com' }).models.list()) list.push({ id: model.id, name: displayName(name, model.id) });
        return list;
      }
      if (!item.url) throw new SettingsError('Save the address first');
      if (name === 'ollama') return ollamaModels(item.url, key);
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
        prompt: read('prompt', ''), promptTemplate: PROMPT_TEMPLATE, recipes: recipes(), defaultRecipe: read('default_recipe', ''),
        providers: Object.fromEntries(PROVIDERS.map(name => [name, { configured: usable(name, all[name]), keySet: Boolean(all[name].key), keyHint: all[name].hint,
          models: all[name].models, url: all[name].url }])),
        knowledge: knowledgeSettings() ?? { url: '', datasets: [], ...KNOWLEDGE_DEFAULTS },
        embedding: (({ key, ...rest }) => ({ ...rest, keySet: Boolean(key) }))(read<StoredEmbedding>('embedding', null as never) ?? { url: '', key: null, hint: '', model: '', batch: 64 }),
        web: read<WebSettings>('web', { enabled: false, searxng: '', allowed: [], blocked: [], maxUses: 5, intranet: [] }),
        limits: limits(),
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
              && ((model as ModelEntry).context === undefined || (Number.isInteger((model as ModelEntry).context) && (model as ModelEntry).context! > 0))
              && ((model as ModelEntry).vision === undefined || typeof (model as ModelEntry).vision === 'boolean');
            if (!Array.isArray(item.models) || item.models.length > 100 || !item.models.every(valid)) throw new SettingsError('Invalid model list');
            next.models = (item.models as ModelEntry[]).filter((model, index, list) => list.findIndex(other => other.id === model.id) === index)
              .map(model => ({ id: model.id, name: model.name.trim() || displayName(name, model.id), ...(model.context ? { context: model.context } : {}), vision: model.vision ?? visionDefault(name) }));
          }
          if (item.url !== undefined) {
            if (typeof item.url !== 'string' || (item.url && !/^https?:\/\/\S+$/.test(item.url))) throw new SettingsError('Invalid address');
            // A key belongs to its server: a new address without a new key drops the old one, so it is not sent elsewhere.
            if (item.url.replace(/\/$/, '') !== all[name].url && item.key === undefined) { next.key = null; next.hint = ''; }
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
      let recipeList: Recipe[] | undefined;
      if (data.recipes !== undefined) {
        if (!Array.isArray(data.recipes) || data.recipes.length > 100) throw new SettingsError('Invalid recipes');
        recipeList = (data.recipes as Record<string, unknown>[]).map(item => {
          const parsed = typeof item?.model === 'string' ? parseModel(item.model) : undefined;
          if (typeof item?.name !== 'string' || !item.name.trim() || item.name.length > 60 || !parsed || typeof item.prompt !== 'string' || item.prompt.length > 8000
            || (item.id !== undefined && (typeof item.id !== 'string' || !/^[\w-]{1,64}$/.test(item.id)))) throw new SettingsError('Invalid recipe');
          let params: Params;
          try { params = checkParams(parsed.provider, item.params ?? {}); } catch (error) {
            if (error instanceof ParamsError) throw new SettingsError(`${item.name}: ${error.message}`);
            throw error;
          }
          return { id: (item.id as string | undefined) ?? randomUUID(), name: item.name.trim(), model: item.model as string, params, prompt: item.prompt };
        });
        if (new Set(recipeList.map(item => item.name)).size !== recipeList.length) throw new SettingsError('Recipe names must differ');
        if (new Set(recipeList.map(item => item.id)).size !== recipeList.length) throw new SettingsError('Invalid recipe');
      }
      if (data.defaultRecipe !== undefined && typeof data.defaultRecipe !== 'string') throw new SettingsError('Invalid default recipe');
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
      let embedding: StoredEmbedding | undefined;
      if (data.embedding !== undefined) {
        const e = data.embedding as Record<string, unknown>;
        const previous = read<StoredEmbedding | null>('embedding', null) ?? { url: '', key: null, hint: '', model: '', batch: 64 };
        if (typeof e.url !== 'string' || (e.url && !/^https?:\/\/\S+$/.test(e.url)) || typeof e.model !== 'string' || e.model.length > 128
          || !Number.isInteger(e.batch) || (e.batch as number) < 1 || (e.batch as number) > 2048) throw new SettingsError('Invalid embedding settings');
        const sameServer = e.url.replace(/\/$/, '') === previous.url;
        embedding = { url: e.url.replace(/\/$/, ''), key: sameServer ? previous.key : null, hint: sameServer ? previous.hint : '', model: e.model, batch: e.batch as number };
        if (e.key !== undefined) {
          if (typeof e.key !== 'string' || e.key.length > 512) throw new SettingsError('Invalid key');
          embedding.key = e.key ? sealKey(e.key.trim()) : null; embedding.hint = e.key ? hintOf(e.key.trim()) : '';
        }
      }
      let web: WebSettings | undefined;
      if (data.web !== undefined) {
        const w = data.web as Record<string, unknown>;
        const list = (value: unknown) => Array.isArray(value) && value.length <= 200 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 255);
        if (typeof w.enabled !== 'boolean' || typeof w.searxng !== 'string' || (w.searxng && !/^https?:\/\/\S+$/.test(w.searxng)) || !list(w.allowed) || !list(w.blocked)
          || !list(w.intranet) || !Number.isInteger(w.maxUses) || (w.maxUses as number) < 1 || (w.maxUses as number) > 50) throw new SettingsError('Invalid web settings');
        if ((w.allowed as string[]).length && (w.blocked as string[]).length) throw new SettingsError('Set allowed or blocked domains, not both');
        web = { enabled: w.enabled, searxng: w.searxng.replace(/\/$/, ''), allowed: w.allowed as string[], blocked: w.blocked as string[], maxUses: w.maxUses as number, intranet: w.intranet as string[] };
      }
      let limits: Limits | undefined;
      if (data.limits !== undefined) {
        const l = data.limits as Record<string, unknown>;
        if (!['read-only', 'restricted', 'full'].includes(l.modeLimit as string) || !Number.isInteger(l.sshTimeout) || (l.sshTimeout as number) < 5 || (l.sshTimeout as number) > 3600
          || !Array.isArray(l.sandboxImages) || !l.sandboxImages.every(image => typeof image === 'string' && /^[\w./:@-]{1,200}$/.test(image))
          || !Number.isInteger(l.attachmentMegabytes) || (l.attachmentMegabytes as number) < 1 || (l.attachmentMegabytes as number) > 100) throw new SettingsError('Invalid limits');
        limits = { modeLimit: l.modeLimit as Mode, sshTimeout: l.sshTimeout as number, sandboxImages: l.sandboxImages as string[], attachmentMegabytes: l.attachmentMegabytes as number };
      }
      db.exec('BEGIN');
      write('providers', all);
      if (data.prompt !== undefined) write('prompt', data.prompt);
      if (recipeList) write('recipes', recipeList);
      if (data.defaultRecipe !== undefined) write('default_recipe', data.defaultRecipe);
      if (knowledge !== undefined) write('knowledge', knowledge);
      if (embedding) write('embedding', embedding);
      if (web) write('web', web);
      if (limits) write('limits', limits);
      db.exec('COMMIT');
      if (!recipes().some(item => item.id === read('default_recipe', ''))) write('default_recipe', '');
      // Later requests use the new settings.
      cache = new Map();
      if (knowledge !== undefined) { await knowledgeBase?.close().catch(() => {}); knowledgeBase = undefined; }
    },
    async close() { await knowledgeBase?.close(); },
  };
}
export type Settings = ReturnType<typeof createSettings>;
