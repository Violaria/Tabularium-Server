// AI settings, for administrators: providers with their keys and models, the default model, the server's default prompt,
// the server's model parameters, and the knowledge base (RAGFlow). Keys are shown only by their last four characters.
import { t } from './i18n.js';
import { api, ApiError, escape, message, tip } from './core.js';
import { FormError, modelName, modelOptions, paramForm, PROVIDER_NAMES as NAMES, type ModelOption, type Params, type ProviderName, type Rule } from './params.js';

interface ModelEntry { id: string; name: string; context?: number }
interface ProviderView { configured: boolean; keySet: boolean; keyHint: string; models: ModelEntry[]; url: string }
interface Knowledge { url: string; datasets: string[]; limit: number; threshold: number; weight: number; keyword: boolean; topK: number; rerank: string }
interface SettingsView {
  prompt: string; defaultPrompt: string; defaultModel: string; params: Partial<Record<ProviderName, Params>>;
  providers: Record<ProviderName, ProviderView>; knowledge: Knowledge;
  embedding: { url: string; keySet: boolean; hint: string; model: string; batch: number };
  web: { enabled: boolean; searxng: string; allowed: string[]; blocked: string[]; maxUses: number; intranet: string[] };
  limits: { modeLimit: 'read-only' | 'restricted' | 'full'; sshTimeout: number; sandboxImages: string[] };
}
interface Overview { models: ModelOption[]; rules: Record<ProviderName, Record<string, Rule>> }
const PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'vllm'];

export async function renderAiSettings(body: HTMLElement) {
  let view: SettingsView; let overview: Overview;
  try {
    [view, overview] = await Promise.all([api<SettingsView>('/tabularius/settings'), api<Overview>('/tabularius')]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) { body.innerHTML = `<section class="card"><div class="empty">${t('ai.notConfigured')}</div></section>`; return; }
    throw error;
  }
  const save = async (data: Record<string, unknown>, done = t('ai.saved')) => {
    view = await api<SettingsView>('/tabularius/settings', 'PUT', data);
    message(done);
  };
  const providerCard = (name: ProviderName) => {
    const item = view.providers[name];
    const keyField = `<label>${name === 'vllm' ? t('ai.keyOptional') : t('ai.key')}<input type="password" name="key" autocomplete="off" placeholder="${item.keySet ? escape(t('ai.keySet', { hint: item.keyHint })) : ''}"></label>`
      + (item.keySet ? `<label class="check"><input type="checkbox" name="clear"> ${t('ai.clearKey')}</label>` : '');
    return `<form class="card stack provider" data-provider="${name}"><div class="provider-head"><h3>${NAMES[name]}</h3><span class="badge ${item.configured ? '' : 'off'}">${item.configured ? t('ai.ready') : t('ai.notSet')}</span></div>
      ${name === 'vllm' ? `<label>${t('ai.url')}<input name="url" value="${escape(item.url)}" placeholder="http://vllm:8000/v1"></label>` : ''}${keyField}
      <fieldset class="model-list"><legend>${t('ai.models')}${item.configured ? `<button type="button" class="link" data-refresh>${t('ai.refreshModels')}</button>` : ''}</legend>
        <div data-models>${item.configured ? `<small>${t('ai.loadingModels')}</small>` : `<small>${t('ai.modelsAfterKey')}</small>`}</div></fieldset>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form>`;
  };
  const datasetList = (datasets: { id: string; name: string; description: string }[], chosen: string[]) => datasets.map(item =>
    `<label class="check dataset"><input type="checkbox" name="dataset" value="${escape(item.id)}" ${chosen.includes(item.id) ? 'checked' : ''}> <span><strong>${escape(item.name)}</strong><small>${escape(item.description)}</small></span></label>`).join('');
  const k = view.knowledge;
  // Drawn again after saving: stay where the page was.
  const scrolled = window.scrollY;
  body.innerHTML = `<section class="card"><h2>${t('ai.modelsTitle')}${tip(t('ai.modelsDesc'))}</h2>
      <label class="inline-select">${t('ai.defaultModel')}<select id="default-model">${modelOptions(overview.models, view.defaultModel, t('ai.defaultNone'))}</select></label></section>
    <div class="providers">${PROVIDERS.map(providerCard).join('')}</div>
    <section class="card"><h2>${t('ai.promptTitle')}${tip(t('ai.promptDesc'))}</h2><form id="server-prompt" class="stack"><textarea name="prompt" rows="16" spellcheck="false">${escape(view.prompt)}</textarea>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button><button type="button" id="restore-prompt">${t('ai.restorePrompt')}</button></div></form></section>
    <section class="card"><h2>${t('ai.paramsTitle')}${tip(t('ai.paramsDesc'))}</h2>${PROVIDERS.map(name => `<details class="param-provider"${name === overview.models[0]?.provider ? ' open' : ''}><summary>${NAMES[name]}</summary><div data-params="${name}"></div></details>`).join('')}
      <button class="primary" type="button" id="save-params">${t('common.save')}</button></section>
    <section class="card"><h2>${t('ai.knowledgeTitle')}${tip(`${t('ai.knowledgeDesc')} ${t('ai.knowledgeHint')}`)}</h2><form id="knowledge" class="stack">
      <div class="inline-form"><label>${t('ai.mcpUrl')}<input name="url" value="${escape(k.url)}" placeholder="http://ragflow:9382/mcp"></label><button type="button" id="read-datasets">${t('ai.readDatasets')}</button></div>
      <fieldset class="datasets"><legend>${t('ai.datasets')}</legend><div id="datasets">${k.datasets.length ? k.datasets.map(id => `<label class="check dataset"><input type="checkbox" name="dataset" value="${escape(id)}" checked> <span class="mono">${escape(id)}</span></label>`).join('') : `<small>${t('ai.noDatasets')}</small>`}</div></fieldset>
      <div class="recipe-fields">
        <label>${t('ai.kLimit')}<input name="limit" type="number" min="1" max="50" step="1" value="${k.limit}"></label>
        <label>${t('ai.kThreshold')}<input name="threshold" type="number" min="0" max="1" step="0.05" value="${k.threshold}"></label>
        <label>${t('ai.kWeight')}<input name="weight" type="number" min="0" max="1" step="0.05" value="${k.weight}"></label>
        <label>${t('ai.kTopK')}<input name="topK" type="number" min="1" max="1024" step="1" value="${k.topK}"></label>
        <label>${t('ai.kRerank')}<input name="rerank" value="${escape(k.rerank)}" placeholder="${t('ai.kRerankHint')}"></label>
        <label class="check"><input type="checkbox" name="keyword" ${k.keyword ? 'checked' : ''}> ${t('ai.kKeyword')}</label>
      </div>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form>
      <form id="knowledge-test" class="inline-form"><label>${t('ai.kTest')}<input name="question" required></label><button type="submit">${t('ai.kTestRun')}</button></form><div id="knowledge-results"></div></section>
    <section class="card"><h2>${t('ai.embeddingTitle')}${tip(t('ai.embeddingDesc'))}</h2><form id="embedding" class="stack"><div class="recipe-fields">
        <label><span>${t('ai.embeddingUrl')}${tip(t('ai.embeddingUrlHint'))}</span><input name="url" value="${escape(view.embedding.url)}" placeholder="http://infinity:7997/v1"></label>
        <label>${t('ai.key')}<input type="password" name="key" autocomplete="off" placeholder="${view.embedding.keySet ? escape(t('ai.keySet', { hint: view.embedding.hint })) : ''}"></label>
        <label><span>${t('ai.embeddingModel')}${tip(t('ai.embeddingModelHint'))}</span><select name="model" id="embedding-model"><option value="">${t('ai.embeddingNone')}</option>${view.embedding.model ? `<option value="${escape(view.embedding.model)}" selected>${escape(view.embedding.model)}</option>` : ''}</select></label>
        <label>${t('ai.embeddingBatch')}<input name="batch" type="number" min="1" max="2048" value="${view.embedding.batch}"></label>
      </div><div class="actions"><button class="primary" type="submit">${t('common.save')}</button><button type="button" id="embedding-refresh">${t('ai.refreshModels')}</button></div></form></section>
    <section class="card"><h2>${t('ai.webTitle')}${tip(t('ai.webDesc'))}</h2><form id="web" class="stack">
      <label class="check"><input type="checkbox" name="enabled" ${view.web.enabled ? 'checked' : ''}> ${t('ai.webEnabled')}</label>
      <div class="recipe-fields">
        <label><span>SearXNG${tip(t('ai.searxngHint'))}</span><input name="searxng" value="${escape(view.web.searxng)}" placeholder="http://searxng:8080"></label>
        <label>${t('ai.webMaxUses')}<input name="maxUses" type="number" min="1" max="50" value="${view.web.maxUses}"></label>
        <label><span>${t('ai.webAllowed')}${tip(t('ai.webDomainsHint'))}</span><textarea name="allowed" rows="3" spellcheck="false">${escape(view.web.allowed.join('\n'))}</textarea></label>
        <label><span>${t('ai.webBlocked')}${tip(t('ai.webDomainsHint'))}</span><textarea name="blocked" rows="3" spellcheck="false">${escape(view.web.blocked.join('\n'))}</textarea></label>
        <label><span>${t('ai.webIntranet')}${tip(t('ai.webIntranetHint'))}</span><textarea name="intranet" rows="3" spellcheck="false">${escape(view.web.intranet.join('\n'))}</textarea></label>
      </div><div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form></section>
    <section class="card"><h2>${t('ai.limitsTitle')}</h2><form id="limits" class="stack"><div class="recipe-fields">
        <label><span>${t('ai.modeLimit')}${tip(t('ai.modeLimitHint'))}</span><select name="modeLimit">${(['read-only', 'restricted', 'full'] as const).map(mode => `<option value="${mode}" ${mode === view.limits.modeLimit ? 'selected' : ''}>${t(`tabularius.mode.${mode}`)}</option>`).join('')}</select></label>
        <label>${t('ai.sshTimeout')}<input name="sshTimeout" type="number" min="5" max="3600" value="${view.limits.sshTimeout}"></label>
        <label><span>${t('ai.sandboxImages')}${tip(t('ai.sandboxImagesHint'))}</span><textarea name="sandboxImages" rows="3" spellcheck="false">${escape(view.limits.sandboxImages.join('\n'))}</textarea></label>
      </div><div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form></section>`;

  window.scrollTo(0, scrolled);
  const run = (action: () => Promise<void>) => action().catch(error => message(error instanceof Error ? error.message : String(error), true));
  document.getElementById('default-model')!.addEventListener('change', event => void run(() => save({ defaultModel: (event.target as HTMLSelectElement).value })));
  for (const form of body.querySelectorAll<HTMLFormElement>('form.provider')) {
    const name = form.dataset.provider as ProviderName;
    form.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(form);
      // The ticked models, with the names (and vLLM context lengths) the provider's list gave.
      const item: Record<string, unknown> = { models: [...form.querySelectorAll<HTMLInputElement>('input[name="model"]:checked')].map(box =>
        ({ id: box.value, name: box.dataset.name ?? box.value, ...(box.dataset.context ? { context: Number(box.dataset.context) } : {}) })) };
      const key = String(data.get('key') ?? '');
      if (data.get('clear')) item.key = ''; else if (key) item.key = key;
      if (name === 'vllm') item.url = String(data.get('url')).trim();
      void run(async () => { await save({ providers: { [name]: item } }); await renderAiSettings(body); message(t('ai.saved')); });
    });
    const list = form.querySelector<HTMLElement>('[data-models]')!;
    const chosen = view.providers[name].models;
    /** The provider's models as ticks; models chosen earlier that the provider no longer lists stay, ticked. */
    const load = async () => {
      list.innerHTML = `<small>${t('ai.loadingModels')}</small>`;
      let offered: ModelEntry[];
      try { offered = await api<ModelEntry[]>(`/tabularius/settings/models/${name}`); }
      catch (error) { list.innerHTML = `<small class="error-text">${escape(t('ai.modelsFailed', { error: error instanceof Error ? error.message : String(error) }))}</small>`; return; }
      const all = [...chosen.filter(model => !offered.some(item => item.id === model.id)), ...offered];
      list.innerHTML = all.length ? all.map(model => {
        const on = chosen.some(item => item.id === model.id);
        return `<div class="model-row"><label class="check"><input type="checkbox" name="model" value="${escape(model.id)}" data-name="${escape(model.name)}"${model.context ? ` data-context="${model.context}"` : ''} ${on ? 'checked' : ''}> <span>${escape(model.name)}${model.name !== model.id ? ` <small class="mono">${escape(model.id)}</small>` : ''}</span></label>`
          + (on ? `<button type="button" class="link" data-test="${escape(`${name}/${model.id}`)}">${t('ai.testShort')}</button>` : '') + '</div>';
      }).join('') : `<small>${t('ai.noModelsListed')}</small>`;
      for (const button of list.querySelectorAll<HTMLButtonElement>('[data-test]')) button.addEventListener('click', () => void run(async () => {
        button.disabled = true;
        try {
          const result = await api<{ reply: string }>('/tabularius/settings/test', 'POST', { model: button.dataset.test });
          message(t('ai.testOk', { model: modelName(overview.models, button.dataset.test!), reply: result.reply }));
        } finally { button.disabled = false; }
      }));
    };
    if (view.providers[name].configured) void load();
    form.querySelector('[data-refresh]')?.addEventListener('click', () => void load());
  }
  const promptForm = document.getElementById('server-prompt') as HTMLFormElement;
  promptForm.addEventListener('submit', event => { event.preventDefault(); void run(() => save({ prompt: String(new FormData(promptForm).get('prompt')) })); });
  document.getElementById('restore-prompt')!.addEventListener('click', () => { promptForm.querySelector('textarea')!.value = view.defaultPrompt; });
  const readers = Object.fromEntries(PROVIDERS.map(name => [name, paramForm(body.querySelector<HTMLElement>(`[data-params="${name}"]`)!, name, overview.rules[name], {}, view.params[name] ?? {})]));
  document.getElementById('save-params')!.addEventListener('click', () => void run(async () => {
    try { await save({ params: Object.fromEntries(PROVIDERS.map(name => [name, readers[name]()])) }); }
    catch (error) { if (error instanceof FormError) message(error.message, true); else throw error; }
  }));
  const knowledge = document.getElementById('knowledge') as HTMLFormElement;
  document.getElementById('read-datasets')!.addEventListener('click', () => void run(async () => {
    const url = String(new FormData(knowledge).get('url')).trim();
    const chosen = [...knowledge.querySelectorAll<HTMLInputElement>('input[name="dataset"]:checked')].map(input => input.value);
    const datasets = await api<{ id: string; name: string; description: string }[]>('/tabularius/settings/datasets', 'POST', { url });
    document.getElementById('datasets')!.innerHTML = datasets.length ? datasetList(datasets, chosen) : `<small>${t('ai.noDatasets')}</small>`;
  }));
  knowledge.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(knowledge);
    const url = String(data.get('url')).trim();
    void run(() => save({ knowledge: url ? { url, datasets: data.getAll('dataset').map(String), limit: Number(data.get('limit')), threshold: Number(data.get('threshold')),
      weight: Number(data.get('weight')), topK: Number(data.get('topK')), rerank: String(data.get('rerank')).trim(), keyword: data.get('keyword') === 'on' } : null }));
  });
  const lines = (value: FormDataEntryValue | null) => String(value ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const embedding = document.getElementById('embedding') as HTMLFormElement;
  const embeddingModels = async () => {
    const select = document.getElementById('embedding-model') as HTMLSelectElement;
    const models = await api<{ id: string; name: string }[]>('/tabularius/settings/embedding-models');
    const chosen = select.value;
    select.innerHTML = `<option value="">${t('ai.embeddingNone')}</option>` + [...(chosen && !models.some(m => m.id === chosen) ? [{ id: chosen, name: chosen }] : []), ...models]
      .map(m => `<option value="${escape(m.id)}" ${m.id === chosen ? 'selected' : ''}>${escape(m.name)}</option>`).join('');
  };
  if (view.embedding.url || view.embedding.keySet) void run(embeddingModels);
  document.getElementById('embedding-refresh')!.addEventListener('click', () => void run(embeddingModels));
  embedding.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(embedding);
    const key = String(data.get('key') ?? '');
    void run(async () => { await save({ embedding: { url: String(data.get('url')).trim(), model: String(data.get('model') ?? ''), batch: Number(data.get('batch')), ...(key ? { key } : {}) } }); await renderAiSettings(body); message(t('ai.saved')); });
  });
  const webForm = document.getElementById('web') as HTMLFormElement;
  webForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(webForm);
    void run(() => save({ web: { enabled: data.get('enabled') === 'on', searxng: String(data.get('searxng')).trim(), maxUses: Number(data.get('maxUses')),
      allowed: lines(data.get('allowed')), blocked: lines(data.get('blocked')), intranet: lines(data.get('intranet')) } }));
  });
  const limitsForm = document.getElementById('limits') as HTMLFormElement;
  limitsForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(limitsForm);
    void run(() => save({ limits: { modeLimit: data.get('modeLimit'), sshTimeout: Number(data.get('sshTimeout')), sandboxImages: lines(data.get('sandboxImages')) } }));
  });
  const test = document.getElementById('knowledge-test') as HTMLFormElement;
  test.addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const results = await api<{ document: string; dataset: string; similarity: number }[]>('/tabularius/settings/knowledge', 'POST', { question: String(new FormData(test).get('question')) });
      document.getElementById('knowledge-results')!.innerHTML = results.length
        ? `<table><thead><tr><th>${t('ai.kDocument')}</th><th>${t('ai.datasets')}</th><th>${t('ai.kSimilarity')}</th></tr></thead><tbody>${results.map(r => `<tr><td>${escape(r.document)}</td><td>${escape(r.dataset)}</td><td>${r.similarity.toFixed(2)}</td></tr>`).join('')}</tbody></table>`
        : `<p class="muted">${t('ai.kNone')}</p>`;
    });
  });
}
