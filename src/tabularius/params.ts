// Model parameters each provider accepts, checked before they reach the API, and the source of the parameter form in
// the web pages. Each table holds every generation and request-control parameter of the provider's official API
// (checked on 2026-11-02 against the API references and, for vLLM, Ollama and TensorRT-LLM, their sources), except the
// fields the server fills in itself (model, messages, tools, streaming, output format, conversation state), the fields
// whose answers Tabularius cannot take (several sequences, audio and image output, background runs) and the fields every
// model now rejects (Claude's temperature, top_p and top_k).
//
// A rule says where its value goes: `at` is a dotted path in the request (by default the top-level field of the same
// name), `map` turns a choice into the value on the wire, `also` sets fixed fields next to it, `beta` names the
// Anthropic beta header it needs (one for every value, or per value). `at: false` marks the settings an adapter
// assembles itself, because they become array entries (Gemini's safety settings, the context-management edits).
export type Params = Record<string, unknown>;
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'vllm' | 'ollama' | 'tensorrt';
interface Placement { at?: string | false; map?: Record<string, unknown>; also?: Record<string, unknown>; beta?: string | Record<string, string> }
export type Rule = Placement & (
  | { kind: 'number'; min: number; max: number; step: number; integer?: boolean; initial: number }
  | { kind: 'enum'; values: string[]; initial: string }
  | { kind: 'boolean'; initial: boolean }
  | { kind: 'text'; max: number; initial: string }
  | { kind: 'list'; max: number; initial: string[] }
  | { kind: 'ints'; max: number; initial: number[] }
  | { kind: 'set'; values: string[]; initial: string[] }
  | { kind: 'bias'; initial: Record<string, number> });

const number = (min: number, max: number, step: number, initial: number, integer = false, place: Placement = {}): Rule =>
  ({ kind: 'number', min, max, step, integer, initial, ...place });
const integer = (min: number, max: number, step: number, initial: number, place: Placement = {}) => number(min, max, step, initial, true, place);
const choice = (values: string[], initial: string, place: Placement = {}): Rule => ({ kind: 'enum', values, initial, ...place });
const flag = (initial: boolean, place: Placement = {}): Rule => ({ kind: 'boolean', initial, ...place });
const text = (max: number, place: Placement = {}): Rule => ({ kind: 'text', max, initial: '', ...place });
const list = (max: number, place: Placement = {}): Rule => ({ kind: 'list', max, initial: [], ...place });
const ints = (max: number, place: Placement = {}): Rule => ({ kind: 'ints', max, initial: [], ...place });
const bias: Rule = { kind: 'bias', initial: {} };
const at = (path: string, place: Placement = {}): Placement => ({ at: path, ...place });
const upper = (values: string[]) => Object.fromEntries(values.map(value => [value, value.toUpperCase()]));
const ADAPTER: Placement = { at: false };

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const GEMINI_SAFETY = ['off', 'none', 'only_high', 'medium_and_above', 'low_and_above'];
const safetyRule = choice(GEMINI_SAFETY, 'off', ADAPTER);
/** Gemini's harm categories, by parameter. */
export const GEMINI_SAFETY_CATEGORIES: Record<string, string> = {
  safety_harassment: 'HARM_CATEGORY_HARASSMENT', safety_hate_speech: 'HARM_CATEGORY_HATE_SPEECH',
  safety_sexually_explicit: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', safety_dangerous_content: 'HARM_CATEGORY_DANGEROUS_CONTENT',
  safety_jailbreak: 'HARM_CATEGORY_JAILBREAK', safety_civic_integrity: 'HARM_CATEGORY_CIVIC_INTEGRITY',
};
const GEMINI_THRESHOLDS: Record<string, string> = {
  off: 'OFF', none: 'BLOCK_NONE', only_high: 'BLOCK_ONLY_HIGH', medium_and_above: 'BLOCK_MEDIUM_AND_ABOVE', low_and_above: 'BLOCK_LOW_AND_ABOVE',
};
const OPENAI_INCLUDE = ['web_search_call.action.sources', 'web_search_call.results', 'message.output_text.logprobs', 'message.input_image.image_url',
  'file_search_call.results', 'code_interpreter_call.outputs', 'computer_call_output.output.image_url'];
const gen = (field: string, place: Placement = {}) => at(`generationConfig.${field}`, place);

/** `initial` is the value a parameter starts from when the form switches it from default to custom. */
export const PARAMS: Record<ProviderName, Record<string, Rule>> = {
  // Messages API (beta endpoint). Without parameters the server asks for adaptive thinking at medium effort.
  anthropic: {
    effort: choice(EFFORT, 'medium', at('output_config.effort')),
    max_tokens: integer(1, 128_000, 1024, 64_000),
    stop_sequences: list(16),
    task_budget: integer(20_000, 1_000_000, 1000, 64_000, at('output_config.task_budget.total', { also: { 'output_config.task_budget.type': 'tokens' }, beta: 'task-budgets-2026-03-13' })),
    thinking: choice(['adaptive', 'disabled', 'between_tools', 'enabled'], 'adaptive', at('thinking.type')),
    thinking_budget: integer(1024, 127_999, 1024, 16_000, at('thinking.budget_tokens', { also: { 'thinking.type': 'enabled' } })),
    thinking_display: choice(['summarized', 'omitted', 'updates'], 'summarized', at('thinking.display', { beta: { updates: 'thinking-display-updates-2026-08-18' } })),
    service_tier: choice(['auto', 'standard_only'], 'auto'),
    speed: choice(['standard', 'fast'], 'standard', { beta: 'fast-mode-2026-02-01' }),
    inference_geo: choice(['global', 'us'], 'global'),
    fallbacks: choice(['default', 'none'], 'default', ADAPTER),
    cache_ttl: choice(['5m', '1h'], '5m', at('cache_control.ttl')),
    compaction_trigger: integer(1000, 1_000_000, 1000, 150_000, ADAPTER),
    compaction_instructions: text(4000, ADAPTER),
    clear_tool_uses: flag(true, ADAPTER),
    clear_tool_uses_trigger: integer(1, 1_000_000, 1000, 100_000, ADAPTER),
    clear_tool_uses_keep: integer(0, 100, 1, 3, ADAPTER),
    clear_tool_uses_at_least: integer(0, 1_000_000, 1000, 0, ADAPTER),
    clear_tool_inputs: flag(true, ADAPTER),
    clear_thinking_keep: integer(1, 100, 1, 1, ADAPTER),
  },
  // Responses API. Without parameters the server sends truncation "auto", store false and the encrypted reasoning.
  openai: {
    reasoning_effort: choice(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium', at('reasoning.effort')),
    reasoning_summary: choice(['auto', 'concise', 'detailed'], 'auto', at('reasoning.summary')),
    reasoning_mode: choice(['standard', 'pro'], 'standard', at('reasoning.mode')),
    reasoning_context: choice(['auto', 'current_turn', 'all_turns'], 'auto', at('reasoning.context')),
    verbosity: choice(['low', 'medium', 'high'], 'medium', at('text.verbosity')),
    max_output_tokens: integer(16, 1_048_576, 256, 16_000),
    temperature: number(0, 2, 0.05, 1), top_p: number(0, 1, 0.05, 1), top_logprobs: integer(0, 20, 1, 5),
    max_tool_calls: integer(1, 1000, 1, 20), parallel_tool_calls: flag(true),
    service_tier: choice(['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast'], 'auto'),
    truncation: choice(['auto', 'disabled'], 'auto'),
    compact_threshold: integer(1000, 10_000_000, 1000, 200_000, ADAPTER),
    store: flag(false),
    include: { kind: 'set', values: OPENAI_INCLUDE, initial: [], ...ADAPTER },
    prompt_cache_key: text(256), prompt_cache_mode: choice(['implicit', 'explicit'], 'implicit', at('prompt_cache_options.mode')),
    prompt_cache_ttl: choice(['30m'], '30m', at('prompt_cache_options.ttl')), prompt_cache_retention: choice(['in_memory', '24h'], '24h'),
    safety_identifier: text(128),
    moderation_model: text(128, at('moderation.model')),
    moderation_input: choice(['score', 'block'], 'score', at('moderation.policy.input.mode')),
    moderation_output: choice(['score', 'block'], 'score', at('moderation.policy.output.mode')),
    cyber_access: choice(['standard', 'daybreak_blue', 'daybreak_red'], 'standard', at('access_programs.cyber')),
    include_obfuscation: flag(true, at('stream_options.include_obfuscation')),
  },
  // generateContent; most fields sit in generationConfig.
  gemini: {
    temperature: number(0, 2, 0.05, 1, false, gen('temperature')), top_p: number(0, 1, 0.05, 0.95, false, gen('topP')),
    top_k: integer(1, 1000, 1, 64, gen('topK')), candidate_count: integer(1, 8, 1, 1, gen('candidateCount')),
    max_output_tokens: integer(1, 1_048_576, 256, 8192, gen('maxOutputTokens')), stop_sequences: list(5, gen('stopSequences')),
    seed: integer(0, 2 ** 31 - 1, 1, 0, gen('seed')),
    presence_penalty: number(-2, 2, 0.05, 0, false, gen('presencePenalty')), frequency_penalty: number(-2, 2, 0.05, 0, false, gen('frequencyPenalty')),
    response_logprobs: flag(true, gen('responseLogprobs')), logprobs: integer(0, 20, 1, 5, gen('logprobs')),
    thinking_level: choice(['minimal', 'low', 'medium', 'high'], 'high', gen('thinkingConfig.thinkingLevel', { map: upper(['minimal', 'low', 'medium', 'high']) })),
    thinking_budget: integer(-1, 65_536, 256, -1, gen('thinkingConfig.thinkingBudget')),
    include_thoughts: flag(true, gen('thinkingConfig.includeThoughts')),
    media_resolution: choice(['low', 'medium', 'high'], 'medium', gen('mediaResolution', { map: { low: 'MEDIA_RESOLUTION_LOW', medium: 'MEDIA_RESOLUTION_MEDIUM', high: 'MEDIA_RESOLUTION_HIGH' } })),
    enhanced_civic_answers: flag(true, gen('enableEnhancedCivicAnswers')),
    ...Object.fromEntries(Object.keys(GEMINI_SAFETY_CATEGORIES).map(name => [name, safetyRule])),
    service_tier: choice(['standard', 'flex', 'priority'], 'standard', at('serviceTier')),
    store: flag(false), cached_content: text(256, at('cachedContent')),
  },
  // Chat Completions; the thinking switch is an object of its own.
  deepseek: {
    thinking: flag(true, at('thinking.type', { map: { true: 'enabled', false: 'disabled' } })),
    reasoning_effort: choice(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'high'),
    max_tokens: integer(1, 393_216, 256, 8192),
    temperature: number(0, 2, 0.05, 1), top_p: number(0.01, 1, 0.01, 1), stop: list(16),
    logprobs: flag(true), top_logprobs: integer(0, 20, 1, 5),
    presence_penalty: number(-2, 2, 0.05, 0), frequency_penalty: number(-2, 2, 0.05, 0),
    user_id: text(128),
  },
  // OpenAI fields and vLLM's own sampling and request extensions; vLLM also takes custom parameters.
  vllm: {
    temperature: number(0, 2, 0.05, 0.7), top_p: number(0.01, 1, 0.01, 0.8), top_k: integer(-1, 1000, 1, 20), min_p: number(0, 1, 0.01, 0),
    presence_penalty: number(-2, 2, 0.05, 0), frequency_penalty: number(-2, 2, 0.05, 0), repetition_penalty: number(0.01, 5, 0.01, 1),
    max_tokens: integer(1, 1_048_576, 256, 8192), min_tokens: integer(0, 131_072, 1, 0), seed: integer(-1, 2 ** 31 - 1, 1, 0),
    stop: list(4), stop_token_ids: ints(64), include_stop_str_in_output: flag(true), ignore_eos: flag(false),
    bad_words: list(64), allowed_token_ids: ints(64), logit_bias: bias, length_penalty: number(0, 2, 0.05, 1),
    logprobs: flag(true), top_logprobs: integer(-1, 20, 1, 5), logprob_token_ids: ints(64),
    enable_thinking: flag(true, at('chat_template_kwargs.enable_thinking')),
    reasoning_effort: choice(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'),
    thinking_token_budget: integer(-1, 1_048_576, 256, 4096), include_reasoning: flag(true),
    repetition_detection_max: integer(0, 1000, 1, 32, at('repetition_detection.max_pattern_size')),
    repetition_detection_min: integer(0, 1000, 1, 1, at('repetition_detection.min_pattern_size')),
    repetition_detection_count: integer(2, 1000, 1, 4, at('repetition_detection.min_count')),
    skip_special_tokens: flag(true), spaces_between_special_tokens: flag(true), add_special_tokens: flag(false),
    truncate_prompt_tokens: integer(-1, 1_048_576, 256, 32_768), truncation_side: choice(['left', 'right'], 'left'),
    watermarking: flag(true), parallel_tool_calls: flag(true), priority: integer(-1_000_000, 1_000_000, 1, 0),
    cache_salt: text(128), session_id: text(256), stream_interval: integer(1, 1000, 1, 1),
  },
  // Ollama's /api/chat: thinking and request settings at the top, the rest in `options`.
  ollama: {
    think: choice(['on', 'off', 'low', 'medium', 'high', 'max'], 'on', { map: { on: true, off: false } }),
    keep_alive: text(16), logprobs: flag(true), top_logprobs: integer(0, 20, 1, 5), truncate: flag(true), shift: flag(true),
    num_ctx: integer(256, 1_048_576, 1024, 32_768, at('options.num_ctx')), num_predict: integer(-1, 1_048_576, 256, -1, at('options.num_predict')),
    temperature: number(0, 2, 0.05, 0.8, false, at('options.temperature')), top_p: number(0, 1, 0.05, 0.9, false, at('options.top_p')),
    top_k: integer(0, 1000, 1, 40, at('options.top_k')), min_p: number(0, 1, 0.01, 0, false, at('options.min_p')),
    typical_p: number(0, 1, 0.01, 1, false, at('options.typical_p')), seed: integer(-1, 2 ** 31 - 1, 1, 0, at('options.seed')),
    stop: list(16, at('options.stop')), repeat_last_n: integer(-1, 1_048_576, 1, 64, at('options.repeat_last_n')),
    repeat_penalty: number(0, 5, 0.01, 1, false, at('options.repeat_penalty')),
    presence_penalty: number(-2, 2, 0.05, 0, false, at('options.presence_penalty')), frequency_penalty: number(-2, 2, 0.05, 0, false, at('options.frequency_penalty')),
    num_keep: integer(-1, 1_048_576, 1, 4, at('options.num_keep')), draft_num_predict: integer(0, 64, 1, 4, at('options.draft_num_predict')),
    num_batch: integer(1, 65_536, 64, 512, at('options.num_batch')), num_gpu: integer(-1, 1000, 1, -1, at('options.num_gpu')),
    main_gpu: integer(0, 64, 1, 0, at('options.main_gpu')), use_mmap: flag(true, at('options.use_mmap')), num_thread: integer(0, 1024, 1, 0, at('options.num_thread')),
  },
  // trtllm-serve's Chat Completions, which rejects fields it does not know; it also takes custom parameters.
  tensorrt: {
    temperature: number(0, 2, 0.05, 1), top_p: number(0, 1, 0.01, 1), top_k: integer(0, 1000, 1, 0), top_p_min: number(0, 1, 0.01, 0),
    min_p: number(0, 1, 0.01, 0), repetition_penalty: number(0.01, 5, 0.01, 1),
    presence_penalty: number(-2, 2, 0.05, 0), frequency_penalty: number(-2, 2, 0.05, 0),
    max_tokens: integer(1, 1_048_576, 256, 8192), min_tokens: integer(0, 131_072, 1, 0), seed: integer(0, 2 ** 31 - 1, 1, 0),
    stop: list(16), stop_token_ids: ints(64), include_stop_str_in_output: flag(true), ignore_eos: flag(false),
    use_beam_search: flag(true), best_of: integer(1, 64, 1, 2), length_penalty: number(0, 2, 0.05, 1),
    early_stopping: choice(['true', 'false', 'never'], 'true', { map: { true: true, false: false } }),
    logit_bias: bias, logprobs: flag(true), top_logprobs: integer(0, 100, 1, 5),
    skip_special_tokens: flag(true), spaces_between_special_tokens: flag(true),
    truncate_prompt_tokens: integer(1, 1_048_576, 256, 32_768), prompt_ignore_length: integer(0, 1_048_576, 1, 0),
    enable_thinking: flag(true, at('chat_template_kwargs.enable_thinking')),
    reasoning_effort: choice(['none', 'low', 'medium', 'high', 'max'], 'medium'), thinking_token_budget: integer(-1, 1_048_576, 256, 4096),
    thinking: choice(['enabled', 'disabled'], 'enabled', at('thinking.type')), thinking_effort: choice(['low', 'high', 'max'], 'high', at('thinking.effort')),
    priority: number(0, 1, 0.05, 0.5), cache_salt: text(128), parallel_tool_calls: flag(true),
  },
};
/** Providers that take custom parameters (a name and a JSON value). */
export const CUSTOM: ProviderName[] = ['vllm', 'tensorrt'];
/** Fields the server fills in itself; a custom parameter cannot replace them. */
const RESERVED = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'n', 'chat_template_kwargs', 'response_format']);
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

export class ParamsError extends Error {}

const describe = (rule: Rule) => rule.kind === 'number' ? `a number from ${rule.min} to ${rule.max}` : rule.kind === 'enum' ? rule.values.join(', ')
  : rule.kind === 'list' ? `up to ${rule.max} texts` : rule.kind === 'ints' ? `up to ${rule.max} integers` : rule.kind === 'text' ? `a text of up to ${rule.max} characters`
    : rule.kind === 'set' ? `some of ${rule.values.join(', ')}` : rule.kind === 'bias' ? 'token IDs with a number from -100 to 100, at most 300' : `a ${rule.kind}`;
function valid(rule: Rule, item: unknown) {
  switch (rule.kind) {
    case 'number': return typeof item === 'number' && Number.isFinite(item) && item >= rule.min && item <= rule.max && (!rule.integer || Number.isInteger(item));
    case 'enum': return rule.values.includes(item as string);
    case 'boolean': return typeof item === 'boolean';
    case 'text': return typeof item === 'string' && item.trim().length > 0 && item.length <= rule.max;
    case 'list': return Array.isArray(item) && item.length <= rule.max && item.every(entry => typeof entry === 'string' && entry.length > 0 && entry.length <= 256);
    case 'ints': return Array.isArray(item) && item.length <= rule.max && item.every(entry => Number.isInteger(entry));
    case 'set': return Array.isArray(item) && item.every(entry => rule.values.includes(entry as string));
    case 'bias': return isBias(item);
  }
}

/** Checks parameters for one provider; unknown names (custom ones only for vLLM and TensorRT-LLM) and out-of-range values are errors. */
export function checkParams(provider: ProviderName, value: unknown): Params {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new ParamsError('Parameters must be a JSON object'); }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ParamsError('Parameters must be a JSON object');
  const rules = PARAMS[provider];
  for (const [name, item] of Object.entries(value)) {
    const rule = rules[name];
    if (!rule) {
      if (!CUSTOM.includes(provider)) throw new ParamsError(`${name} is not a parameter of ${provider}; allowed: ${Object.keys(rules).join(', ')}`);
      if (!NAME.test(name) || RESERVED.has(name)) throw new ParamsError(`${name} cannot be set`);
      if (JSON.stringify(item).length > 2000) throw new ParamsError(`${name}: value too long`);
      continue;
    }
    if (!valid(rule, item)) throw new ParamsError(`${name}: ${describe(rule)}`);
  }
  return value as Params;
}

/** Logit bias: token IDs (as object keys) with a bias from -100 to 100. */
function isBias(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 300 && entries.every(([token, bias]) => /^\d{1,9}$/.test(token) && typeof bias === 'number' && bias >= -100 && bias <= 100);
}

/** Sets `value` at a dotted path in `target`, creating the objects on the way. */
function put(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys.at(-1)!] = value;
}
/** Merges `extra` into `base`, object by object (arrays and values replace). */
export function merge(base: Record<string, unknown>, extra: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key];
    out[key] = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? merge(existing as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return out;
}

/**
 * The request fields for the parameters (to merge over the adapter's own request) and the beta headers they need.
 * Fixed fields (`also`) are set first, so a parameter of their own (Claude's thinking type) wins. Custom parameters go
 * to the top level as written; the settings an adapter assembles (`at: false`) are left out.
 */
export function place(provider: ProviderName, params: Params) {
  const rules = PARAMS[provider];
  const fields: Record<string, unknown> = {};
  const betas = new Set<string>();
  // An empty list or set means nothing to send.
  const known = Object.entries(params).filter(([name, value]) => rules[name] && !(Array.isArray(value) && !value.length));
  for (const [name] of known) for (const [path, value] of Object.entries(rules[name].also ?? {})) put(fields, path, value);
  for (const [name, value] of known) {
    const rule = rules[name];
    if (rule.at === false) continue;
    const wire = rule.map && String(value) in rule.map ? rule.map[String(value)] : value;
    put(fields, rule.at ?? name, wire);
    if (typeof rule.beta === 'string') betas.add(rule.beta);
    else if (rule.beta?.[String(value)]) betas.add(rule.beta[String(value)]);
  }
  for (const [name, value] of Object.entries(params)) if (!rules[name]) fields[name] = value;
  return { fields, betas: [...betas] };
}

/** Gemini's safetySettings from the parameters, one entry per category set. */
export function geminiSafety(params: Params) {
  return Object.entries(GEMINI_SAFETY_CATEGORIES).flatMap(([name, category]) =>
    params[name] === undefined ? [] : [{ category, threshold: GEMINI_THRESHOLDS[params[name] as string] }]);
}

/**
 * Claude's context-management edits: compaction is always on (its trigger and instructions are parameters); clearing old
 * thinking and old tool results are added when set. Thinking clearing comes first, as the API requires.
 */
export function anthropicEdits(params: Params) {
  const edits: Record<string, unknown>[] = [];
  if (params.clear_thinking_keep !== undefined) edits.push({ type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: params.clear_thinking_keep } });
  if (params.clear_tool_uses === true) edits.push({
    type: 'clear_tool_uses_20250919',
    ...(params.clear_tool_uses_trigger !== undefined ? { trigger: { type: 'input_tokens', value: params.clear_tool_uses_trigger } } : {}),
    ...(params.clear_tool_uses_keep !== undefined ? { keep: { type: 'tool_uses', value: params.clear_tool_uses_keep } } : {}),
    ...(params.clear_tool_uses_at_least !== undefined ? { clear_at_least: { type: 'input_tokens', value: params.clear_tool_uses_at_least } } : {}),
    ...(params.clear_tool_inputs !== undefined ? { clear_tool_inputs: params.clear_tool_inputs } : {}),
  });
  edits.push({
    type: 'compact_20260112',
    ...(params.compaction_trigger !== undefined ? { trigger: { type: 'input_tokens', value: params.compaction_trigger } } : {}),
    ...(params.compaction_instructions !== undefined ? { instructions: params.compaction_instructions } : {}),
  });
  return { edits, betas: edits.length > 1 ? ['context-management-2025-06-27'] : [] };
}
