// LLM settings, for administrators: providers with their keys and models, recipes (a model with parameters and a prompt)
// with the default one, the server's default prompt, and the knowledge base (RAGFlow). Keys are shown only by their last
// four characters.
import { t } from './i18n.js';
import { api, ApiError, confirmAction, escape, message, run, scroller, tip } from './core.js';
import { FormError, modelName, modelOptions, paramForm, PROVIDER_NAMES as NAMES, type ModelOption, type Params, type ProviderName, type Rule } from './params.js';

interface ModelEntry { id: string; name: string; context?: number; vision?: boolean }
interface ProviderView { configured: boolean; keySet: boolean; keyHint: string; models: ModelEntry[]; url: string }
interface Knowledge { url: string; datasets: string[]; limit: number; threshold: number; weight: number; keyword: boolean; topK: number; rerank: string }
interface RecipeView { id?: string; name: string; model: string; params: Params; prompt: string }
interface SettingsView {
  prompt: string; defaultPrompt: string; recipes: RecipeView[]; defaultRecipe: string;
  providers: Record<ProviderName, ProviderView>; knowledge: Knowledge;
  embedding: { url: string; keySet: boolean; hint: string; model: string; batch: number };
  web: { enabled: boolean; searxng: string; allowed: string[]; blocked: string[]; maxUses: number; intranet: string[] };
  limits: { modeLimit: 'read-only' | 'restricted' | 'full'; sshTimeout: number; sandboxImages: string[]; attachmentMegabytes: number };
}
interface Overview { rules: Record<ProviderName, Record<string, Rule>> }
const PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'vllm'];
/** Recipes and providers open in the page: a redraw after saving keeps them open. */
const openRecipes = new Set<string>();
const openProviders = new Set<ProviderName>();

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
  /** One added provider: its key (and vLLM address), a test, and the models chosen from its list. */
  const providerItem = (name: ProviderName) => {
    const item = view.providers[name];
    const summary = [item.keySet ? t('ai.keySet', { hint: item.keyHint }) : name === 'vllm' ? item.url : '', t('ai.modelCount', { count: item.models.length })].filter(Boolean).join(' · ');
    return `<details class="llm-recipe llm-provider" data-provider="${name}"${openProviders.has(name) ? ' open' : ''}><summary title="${escape(summary)}"><strong>${NAMES[name]}</strong></summary>
      <form class="stack" data-key>
        <div class="recipe-fields">${name === 'vllm' ? `<label><span>${t('ai.url')}${tip(t('ai.urlHint'))}</span><input name="url" value="${escape(item.url)}" placeholder="http://vllm:8000/v1"></label>` : ''}
          <label>${name === 'vllm' ? `<span>${t('ai.keyOptional')}${tip(t('ai.keyOptionalHint'))}</span>` : t('ai.key')}<input type="password" data-bwignore data-1p-ignore data-lpignore="true" name="key" autocomplete="off" placeholder="${item.keySet ? escape(t('ai.keySet', { hint: item.keyHint })) : ''}"></label></div>
        <div class="actions"><button class="primary" type="submit">${t('common.save')}</button><button type="button" data-test-provider>${t('ai.testConnection')}</button><span class="test-status" aria-live="polite"></span>
          <span class="actions-end">${item.keySet ? `<button type="button" data-clear-key>${t('ai.clearKey')}</button>` : ''}<button type="button" class="danger" data-remove-provider>${t('ai.removeProvider')}</button></span></div>
      </form>
      <fieldset class="model-list"><legend>${t('ai.models')}${tip(t('ai.modelsHint'))}</legend>
        <div data-models>${item.models.length ? modelRows(name, item.models, item.models) : `<small>${t('ai.noModelsChosen')}</small>`}</div>
        <div class="actions"><button type="button" data-fetch>${t('ai.fetchModels')}</button><button type="button" data-test-models>${t('ai.testModels')}</button>
          <span class="actions-end"><button class="primary" type="button" data-save-models>${t('ai.saveModels')}</button></span></div></fieldset></details>`;
  };
  /**
   * Model ticks: `offered` as listed (or the chosen ones before the list is fetched), ticked when chosen, each with whether it
   * reads images (Anthropic and OpenAI models do by default, local ones are marked here); a test result shows at the row's end.
   */
  const modelRows = (name: ProviderName, offered: ModelEntry[], chosen: ModelEntry[]) => offered.map(model => {
    const picked = chosen.find(item => item.id === model.id);
    const vision = picked?.vision ?? name !== 'vllm';
    return `<div class="model-row" data-model="${escape(model.id)}"><label class="check"><input type="checkbox" name="model" value="${escape(model.id)}" data-name="${escape(model.name)}"${model.context ? ` data-context="${model.context}"` : ''} ${picked ? 'checked' : ''}> <span>${escape(model.name)}${model.name !== model.id ? ` <small class="mono">${escape(model.id)}</small>` : ''}</span></label><label class="check model-vision"><input type="checkbox" name="vision" ${vision ? 'checked' : ''}> <small>${t('ai.vision')}</small></label><span class="model-test" aria-live="polite"></span></div>`;
  }).join('');
  /** The form for adding a provider: its type (the ones not added yet), then key and address. */
  const newProvider = (available: ProviderName[]) => `<details class="llm-recipe llm-provider" data-new open><summary><strong>${t('ai.newProvider')}</strong></summary>
    <form class="stack" data-add><div class="recipe-fields">
      <label>${t('ai.providerType')}<select name="type">${available.map(name => `<option value="${name}">${NAMES[name]}</option>`).join('')}</select></label>
      <label data-for="vllm" ${available[0] === 'vllm' ? '' : 'hidden'}><span>${t('ai.url')}${tip(t('ai.urlHint'))}</span><input name="url" placeholder="http://vllm:8000/v1"></label>
      <label><span>${t('ai.key')}</span><input type="password" data-bwignore data-1p-ignore data-lpignore="true" name="key" autocomplete="off"></label></div>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button><button type="button" data-cancel>${t('ai.recipeCancel')}</button></div></form></details>`;
  const datasetList = (datasets: { id: string; name: string; description: string }[], chosen: string[]) => datasets.map(item =>
    `<label class="check dataset"><input type="checkbox" name="dataset" value="${escape(item.id)}" ${chosen.includes(item.id) ? 'checked' : ''}> <span><strong>${escape(item.name)}</strong><small>${escape(item.description)}</small></span></label>`).join('');
  /** The models ticked under providers that are set up: what a recipe can be based on. */
  const models: ModelOption[] = PROVIDERS.flatMap(name => view.providers[name].configured
    ? view.providers[name].models.map(model => ({ id: `${name}/${model.id}`, provider: name, model: model.id, name: model.name })) : []);
  const recipeItem = (recipe: RecipeView, index: number) => {
    const available = models.some(model => model.id === recipe.model);
    const isDefault = recipe.id !== undefined && recipe.id === view.defaultRecipe;
    return `<details class="llm-recipe" data-index="${index}"${!recipe.id || openRecipes.has(recipe.id) ? ' open' : ''}><summary title="${escape(available ? `${NAMES[models.find(model => model.id === recipe.model)!.provider]} · ${modelName(models, recipe.model)}` : recipe.model)}"><strong>${escape(recipe.name || t('ai.recipeNew'))}</strong>`
      + `${isDefault ? `<span class="badge">${t('ai.recipeDefault')}</span>` : ''}`
      + `${recipe.model && !available ? `<span class="badge warn">${t('ai.recipeUnavailable')}</span>` : ''}</summary>
      <form class="stack"><div class="recipe-fields">
        <label>${t('ai.recipeName')}<input name="name" required maxlength="60" value="${escape(recipe.name)}"></label>
        <label>${t('ai.recipeModel')}<select name="model" required>${modelOptions(models, available ? recipe.model : '', t('ai.recipeChooseModel'))}</select></label>
      </div>
      <label><span>${t('ai.recipePrompt')}${tip(t('ai.recipePromptHint'))}</span><textarea name="prompt" rows="4">${escape(recipe.prompt)}</textarea></label>
      <h4>${t('ai.recipeParams')}${tip(t('ai.recipeParamsHint'))}</h4><div data-params></div>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button>${recipe.id && !isDefault ? `<button type="button" data-default>${t('ai.recipeMakeDefault')}</button>` : ''}`
      + `${recipe.id ? `<button type="button" class="danger" data-delete>${t('ai.recipeDelete')}</button>` : `<button type="button" data-cancel>${t('ai.recipeCancel')}</button>`}</div></form></details>`;
  };
  const k = view.knowledge;
  // Drawn again after saving: stay where the page was.
  const scrolled = scroller().scrollTop;
  const added = PROVIDERS.filter(name => view.providers[name].configured);
  body.innerHTML = `<section class="card"><div class="card-head"><h2>${t('ai.providersTitle')}${tip(t('ai.providersDesc'))}</h2>${added.length < PROVIDERS.length ? `<button type="button" id="add-provider">${t('ai.addProvider')}</button>` : ''}</div>
      <div id="providers" class="llm-recipes">${added.length ? added.map(providerItem).join('') : `<p class="muted">${t('ai.noProviders')}</p>`}</div></section>
    <section class="card"><div class="card-head"><h2>${t('ai.recipesTitle')}${tip(t('ai.recipesDesc'))}</h2>${models.length ? `<button type="button" id="add-recipe">${t('ai.recipeAdd')}</button>` : ''}</div>
      <div id="recipes" class="llm-recipes">${view.recipes.length ? view.recipes.map(recipeItem).join('') : `<p class="muted">${models.length ? t('ai.recipesNone') : t('ai.recipesNeedModels')}</p>`}</div></section>
    <section class="card"><h2>${t('ai.promptTitle')}${tip(t('ai.promptDesc'))}</h2><form id="server-prompt" class="stack"><textarea name="prompt" rows="16" spellcheck="false">${escape(view.prompt)}</textarea>
      <div class="actions"><button class="primary" type="submit">${t('common.save')}</button><button type="button" id="restore-prompt">${t('ai.restorePrompt')}</button></div></form></section>
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
        <label>${t('ai.key')}<input type="password" data-bwignore data-1p-ignore data-lpignore="true" name="key" autocomplete="off" placeholder="${view.embedding.keySet ? escape(t('ai.keySet', { hint: view.embedding.hint })) : ''}"></label>
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
        <label><span>${t('ai.attachmentLimit')}${tip(t('ai.attachmentLimitHint'))}</span><input name="attachmentMegabytes" type="number" min="1" max="100" value="${view.limits.attachmentMegabytes}"></label>
      </div><div class="actions"><button class="primary" type="submit">${t('common.save')}</button></div></form></section>`;

  scroller().scrollTop = scrolled;
  const recipes: RecipeView[] = [...view.recipes];
  /** Saves the whole list with one recipe changed (or removed), then draws the page again where it was. */
  const saveRecipes = async (list: RecipeView[], defaultRecipe?: string) => {
    await save({ recipes: list.map(({ id, name, model, params, prompt }) => ({ ...(id ? { id } : {}), name, model, params, prompt })), ...(defaultRecipe !== undefined ? { defaultRecipe } : {}) });
    await renderAiSettings(body);
    message(t('ai.saved'));
  };
  const bindRecipe = (item: HTMLElement) => {
    const index = Number(item.dataset.index);
    const recipe = recipes[index];
    item.addEventListener('toggle', () => { if (recipe.id) { if ((item as HTMLDetailsElement).open) openRecipes.add(recipe.id); else openRecipes.delete(recipe.id); } });
    const recipeForm = item.querySelector('form')!;
    const select = recipeForm.querySelector<HTMLSelectElement>('select[name="model"]')!;
    const paramsRoot = item.querySelector<HTMLElement>('[data-params]')!;
    let provider: ProviderName | undefined;
    let read: () => Params = () => ({});
    // The parameter form follows the model's provider; values set for another provider do not carry over.
    const drawParams = () => {
      const next = select.value ? models.find(model => model.id === select.value)!.provider : undefined;
      if (next === provider) return;
      const current = next && recipe.model.startsWith(`${next}/`) ? recipe.params : {};
      provider = next;
      if (next) read = paramForm(paramsRoot, next, overview.rules[next], {}, current);
      else { paramsRoot.innerHTML = `<p class="muted">${t('ai.recipeChooseModel')}</p>`; read = () => ({}); }
    };
    drawParams();
    select.addEventListener('change', drawParams);
    recipeForm.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(recipeForm);
      let params: Params;
      try { params = read(); } catch (error) { if (error instanceof FormError) { message(error.message, true); return; } throw error; }
      const updated = { ...recipe, name: String(data.get('name')).trim(), model: String(data.get('model')), prompt: String(data.get('prompt')), params };
      // The first recipe becomes the default, so Tabularius can answer.
      void run(() => saveRecipes(recipes.map((other, i) => i === index ? updated : other), view.defaultRecipe ? undefined : updated.id ?? ''));
    });
    item.querySelector('[data-default]')?.addEventListener('click', () => void run(() => saveRecipes(recipes, recipe.id)));
    item.querySelector('[data-cancel]')?.addEventListener('click', () => { recipes.splice(index, 1); void renderAiSettings(body); });
    item.querySelector('[data-delete]')?.addEventListener('click', () => void run(async () => {
      if (!await confirmAction({ title: t('ai.recipeDeleteTitle', { name: recipe.name }), body: t('ai.recipeDeleteBody'), action: t('ai.recipeDelete'), danger: true })) return;
      await saveRecipes(recipes.filter((_, i) => i !== index));
    }));
  };
  for (const item of body.querySelectorAll<HTMLElement>('#recipes details.llm-recipe')) bindRecipe(item);
  document.getElementById('add-recipe')?.addEventListener('click', () => {
    // One new recipe at a time.
    if (recipes.some(recipe => !recipe.id)) return;
    recipes.push({ name: '', model: '', params: {}, prompt: '' });
    const list = document.getElementById('recipes')!;
    if (!list.querySelector('details')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', recipeItem(recipes[recipes.length - 1], recipes.length - 1));
    bindRecipe(list.lastElementChild as HTMLElement);
  });
  const providerSave = async (name: ProviderName, item: Record<string, unknown>) => {
    await save({ providers: { [name]: item } });
    openProviders.add(name);
    await renderAiSettings(body);
    message(t('ai.saved'));
  };
  for (const details of body.querySelectorAll<HTMLDetailsElement>('details.llm-provider[data-provider]')) {
    const name = details.dataset.provider as ProviderName;
    const chosen = view.providers[name].models;
    details.addEventListener('toggle', () => { if (details.open) openProviders.add(name); else openProviders.delete(name); });
    const keyForm = details.querySelector<HTMLFormElement>('form[data-key]')!;
    keyForm.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(keyForm);
      const item: Record<string, unknown> = {};
      const key = String(data.get('key') ?? '').trim();
      if (key) item.key = key;
      if (name === 'vllm') item.url = String(data.get('url')).trim();
      void run(() => providerSave(name, item));
    });
    // A test reads the provider's model list with the saved key: it shows, beside the button, whether the key and address work.
    details.querySelector('[data-test-provider]')!.addEventListener('click', event => void (async () => {
      const button = event.currentTarget as HTMLButtonElement;
      const status = details.querySelector<HTMLElement>('.test-status')!;
      button.disabled = true;
      status.innerHTML = `<span class="badge off">${t('ai.testing')}</span>`;
      try {
        const offered = await api<ModelEntry[]>(`/tabularius/settings/models/${name}`);
        status.innerHTML = `<span class="badge">${escape(t('ai.testProviderOk', { count: offered.length }))}</span>`;
      } catch (error) {
        status.innerHTML = `<span class="badge warn" title="${escape(error instanceof Error ? error.message : String(error))}">${t('ai.testFailed')}</span>`;
      } finally { button.disabled = false; }
    })());
    details.querySelector('[data-clear-key]')?.addEventListener('click', () => void run(async () => {
      if (!await confirmAction({ title: t('ai.clearKeyTitle', { provider: NAMES[name] }), body: t('ai.clearKeyBody'), action: t('ai.clearKey'), danger: true })) return;
      await providerSave(name, { key: '' });
    }));
    details.querySelector('[data-remove-provider]')!.addEventListener('click', () => void run(async () => {
      if (!await confirmAction({ title: t('ai.removeProviderTitle', { provider: NAMES[name] }), body: t('ai.removeProviderBody'), action: t('ai.removeProvider'), danger: true })) return;
      openProviders.delete(name);
      await save({ providers: { [name]: { key: '', url: '', models: [] } } });
      await renderAiSettings(body);
      message(t('ai.saved'));
    }));
    const list = details.querySelector<HTMLElement>('[data-models]')!;
    // Each ticked model answers one short request; the result shows at the end of its row.
    details.querySelector('[data-test-models]')!.addEventListener('click', event => void run(async () => {
      const button = event.currentTarget as HTMLButtonElement;
      const ticked = [...list.querySelectorAll<HTMLInputElement>('input[name="model"]:checked')];
      if (!ticked.length) { message(t('ai.testNoneTicked'), true); return; }
      button.disabled = true;
      try {
        for (const box of ticked) {
          const cell = box.closest('.model-row')!.querySelector<HTMLElement>('.model-test')!;
          cell.innerHTML = `<span class="badge off">${t('ai.testing')}</span>`;
          try {
            const result = await api<{ reply: string }>('/tabularius/settings/test', 'POST', { model: `${name}/${box.value}` });
            cell.innerHTML = `<span class="badge" title="${escape(result.reply)}">${t('ai.testPassed')}</span>`;
          } catch (error) {
            cell.innerHTML = `<span class="badge warn" title="${escape(error instanceof Error ? error.message : String(error))}">${t('ai.testFailed')}</span>`;
          }
        }
      } finally { button.disabled = false; }
    }));
    /** The provider's models as ticks; models chosen earlier that the provider no longer lists stay, ticked. */
    details.querySelector('[data-fetch]')!.addEventListener('click', () => void run(async () => {
      list.innerHTML = `<small>${t('ai.loadingModels')}</small>`;
      let offered: ModelEntry[];
      try { offered = await api<ModelEntry[]>(`/tabularius/settings/models/${name}`); }
      catch (error) { list.innerHTML = `<small class="error-text">${escape(t('ai.modelsFailed', { error: error instanceof Error ? error.message : String(error) }))}</small>`; return; }
      const all = [...chosen.filter(model => !offered.some(item => item.id === model.id)), ...offered];
      list.innerHTML = all.length ? modelRows(name, all, chosen) : `<small>${t('ai.noModelsListed')}</small>`;
    }));
    details.querySelector('[data-save-models]')!.addEventListener('click', () => void run(() => providerSave(name, {
      models: [...list.querySelectorAll<HTMLInputElement>('input[name="model"]:checked')].map(box =>
        ({ id: box.value, name: box.dataset.name ?? box.value, ...(box.dataset.context ? { context: Number(box.dataset.context) } : {}),
          vision: box.closest('.model-row')!.querySelector<HTMLInputElement>('input[name="vision"]')!.checked })),
    })));
  }
  document.getElementById('add-provider')?.addEventListener('click', () => {
    if (body.querySelector('details[data-new]')) return;
    const list = document.getElementById('providers')!;
    if (!list.querySelector('details')) list.innerHTML = '';
    list.insertAdjacentHTML('afterbegin', newProvider(PROVIDERS.filter(name => !view.providers[name].configured)));
    const fresh = list.querySelector<HTMLDetailsElement>('details[data-new]')!;
    const addForm = fresh.querySelector<HTMLFormElement>('form[data-add]')!;
    const type = addForm.querySelector<HTMLSelectElement>('select[name="type"]')!;
    type.addEventListener('change', () => { addForm.querySelector<HTMLElement>('[data-for="vllm"]')!.hidden = type.value !== 'vllm'; });
    fresh.querySelector('[data-cancel]')!.addEventListener('click', () => void renderAiSettings(body));
    addForm.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(addForm);
      const name = type.value as ProviderName;
      const key = String(data.get('key') ?? '').trim();
      const url = String(data.get('url') ?? '').trim();
      if (name === 'vllm' ? !url : !key) { message(name === 'vllm' ? t('ai.urlRequired') : t('ai.keyRequired'), true); return; }
      void run(() => providerSave(name, { ...(key ? { key } : {}), ...(name === 'vllm' ? { url } : {}) }));
    });
  });
  const promptForm = document.getElementById('server-prompt') as HTMLFormElement;
  promptForm.addEventListener('submit', event => { event.preventDefault(); void run(() => save({ prompt: String(new FormData(promptForm).get('prompt')) })); });
  document.getElementById('restore-prompt')!.addEventListener('click', () => { promptForm.querySelector('textarea')!.value = view.defaultPrompt; });
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
    void run(() => save({ limits: { modeLimit: data.get('modeLimit'), sshTimeout: Number(data.get('sshTimeout')), sandboxImages: lines(data.get('sandboxImages')), attachmentMegabytes: Number(data.get('attachmentMegabytes')) } }));
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
