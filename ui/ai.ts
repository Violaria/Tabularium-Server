// AI settings, for administrators: providers with their keys and models, the default model, the server's default prompt,
// the server's model parameters, and the knowledge base (RAGFlow). Keys are shown only by their last four characters.
import { t } from './i18n.js';
import { api, ApiError, escape, message } from './core.js';
import { FormError, paramForm, type Params, type ProviderName, type Rule } from './params.js';

interface ProviderView { configured: boolean; keySet: boolean; keyHint: string; models: string[]; url: string; context: number }
interface Knowledge { url: string; datasets: string[]; limit: number; threshold: number; weight: number; keyword: boolean; topK: number; rerank: string }
interface SettingsView {
  prompt: string; defaultPrompt: string; defaultModel: string; params: Partial<Record<ProviderName, Params>>;
  providers: Record<ProviderName, ProviderView>; knowledge: Knowledge;
}
interface Overview { models: { id: string; provider: ProviderName; model: string }[]; rules: Record<ProviderName, Record<string, Rule>> }
const PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'vllm'];
const NAMES: Record<ProviderName, string> = { anthropic: 'Anthropic', openai: 'OpenAI', vllm: 'vLLM' };

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
      ${name === 'vllm' ? `<label>${t('ai.context')}<input name="context" type="number" min="2048" step="1024" value="${item.context}"></label>` : ''}
      <label>${t('ai.models')}<textarea name="models" rows="3" spellcheck="false">${escape(item.models.join('\n'))}</textarea><small>${t('ai.modelsHint')}</small></label>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button>${item.configured ? item.models.map(model => `<button type="button" data-test="${escape(`${name}/${model}`)}">${escape(t('ai.test', { model }))}</button>`).join('') : ''}</div></form>`;
  };
  const datasetList = (datasets: { id: string; name: string; description: string }[], chosen: string[]) => datasets.map(item =>
    `<label class="check dataset"><input type="checkbox" name="dataset" value="${escape(item.id)}" ${chosen.includes(item.id) ? 'checked' : ''}> <span><strong>${escape(item.name)}</strong><small>${escape(item.description)}</small></span></label>`).join('');
  const k = view.knowledge;
  body.innerHTML = `<section class="card"><h2>${t('ai.modelsTitle')}</h2><p>${t('ai.modelsDesc')}</p>
      <label class="inline-select">${t('ai.defaultModel')}<select id="default-model">${overview.models.map(item => `<option value="${escape(item.id)}" ${item.id === view.defaultModel ? 'selected' : ''}>${escape(item.id)}</option>`).join('')}</select></label></section>
    <div class="providers">${PROVIDERS.map(providerCard).join('')}</div>
    <section class="card"><h2>${t('ai.promptTitle')}</h2><p>${t('ai.promptDesc')}</p><form id="server-prompt" class="stack"><textarea name="prompt" rows="16" spellcheck="false">${escape(view.prompt)}</textarea>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button><button type="button" id="restore-prompt">${t('ai.restorePrompt')}</button></div></form></section>
    <section class="card"><h2>${t('ai.paramsTitle')}</h2><p>${t('ai.paramsDesc')}</p>${PROVIDERS.map(name => `<details class="param-provider"${name === overview.models[0]?.provider ? ' open' : ''}><summary>${NAMES[name]}</summary><div data-params="${name}"></div></details>`).join('')}
      <button class="primary" type="button" id="save-params">${t('common.save')}</button></section>
    <section class="card"><h2>${t('ai.knowledgeTitle')}</h2><p>${t('ai.knowledgeDesc')}</p><form id="knowledge" class="stack">
      <div class="inline-form"><label>${t('ai.mcpUrl')}<input name="url" value="${escape(k.url)}" placeholder="http://ragflow:9382/mcp"></label><button type="button" id="read-datasets">${t('ai.readDatasets')}</button></div>
      <fieldset class="datasets"><legend>${t('ai.datasets')}</legend><div id="datasets">${k.datasets.length ? k.datasets.map(id => `<label class="check dataset"><input type="checkbox" name="dataset" value="${escape(id)}" checked> <span class="mono">${escape(id)}</span></label>`).join('') : `<small>${t('ai.noDatasets')}</small>`}</div></fieldset>
      <div class="recipe-fields">
        <label>${t('ai.kLimit')}<input name="limit" type="number" min="1" max="50" step="1" value="${k.limit}"></label>
        <label>${t('ai.kThreshold')}<input name="threshold" type="number" min="0" max="1" step="0.05" value="${k.threshold}"></label>
        <label>${t('ai.kWeight')}<input name="weight" type="number" min="0" max="1" step="0.05" value="${k.weight}"></label>
        <label>${t('ai.kTopK')}<input name="topK" type="number" min="1" max="1024" step="1" value="${k.topK}"></label>
        <label>${t('ai.kRerank')}<input name="rerank" value="${escape(k.rerank)}" placeholder="${t('ai.kRerankHint')}"></label>
        <label class="check"><input type="checkbox" name="keyword" ${k.keyword ? 'checked' : ''}> ${t('ai.kKeyword')}</label>
      </div><small>${t('ai.knowledgeHint')}</small>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form>
      <form id="knowledge-test" class="inline-form"><label>${t('ai.kTest')}<input name="question" required></label><button type="submit">${t('ai.kTestRun')}</button></form><div id="knowledge-results"></div></section>`;

  const run = (action: () => Promise<void>) => action().catch(error => message(error instanceof Error ? error.message : String(error), true));
  document.getElementById('default-model')!.addEventListener('change', event => void run(() => save({ defaultModel: (event.target as HTMLSelectElement).value })));
  for (const form of body.querySelectorAll<HTMLFormElement>('form.provider')) {
    const name = form.dataset.provider as ProviderName;
    form.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(form);
      const item: Record<string, unknown> = { models: String(data.get('models')).split('\n').map(line => line.trim()).filter(Boolean) };
      const key = String(data.get('key') ?? '');
      if (data.get('clear')) item.key = ''; else if (key) item.key = key;
      if (name === 'vllm') { item.url = String(data.get('url')).trim(); item.context = Number(data.get('context')); }
      void run(async () => { await save({ providers: { [name]: item } }); await renderAiSettings(body); message(t('ai.saved')); });
    });
    for (const button of form.querySelectorAll<HTMLButtonElement>('[data-test]')) button.addEventListener('click', () => void run(async () => {
      button.disabled = true;
      try {
        const result = await api<{ reply: string }>('/tabularius/settings/test', 'POST', { model: button.dataset.test });
        message(t('ai.testOk', { model: button.dataset.test!, reply: result.reply }));
      } finally { button.disabled = false; }
    }));
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
