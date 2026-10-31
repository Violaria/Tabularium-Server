// Model parameters each provider accepts, checked before they reach the API, and the source of the parameter form in
// the web pages. Current Claude models take no sampling parameters (temperature, top_p, top_k are rejected); effort is
// the control. OpenAI's reasoning models take effort and verbosity; vLLM takes the usual sampling parameters, a
// thinking switch for the model's chat template, and further fields of its own (custom parameters).
export type Params = Record<string, unknown>;
export type ProviderName = 'anthropic' | 'openai' | 'vllm';
export type Rule =
  | { kind: 'number'; min: number; max: number; step: number; integer?: boolean; initial: number }
  | { kind: 'enum'; values: string[]; initial: string }
  | { kind: 'boolean'; initial: boolean }
  | { kind: 'list'; initial: string[] };

const number = (min: number, max: number, step: number, initial: number, integer = false): Rule => ({ kind: 'number', min, max, step, integer, initial });
const choice = (initial: string, ...values: string[]): Rule => ({ kind: 'enum', values, initial });

/** `initial` is the value a parameter starts from when the form switches it from default to custom. */
export const PARAMS: Record<ProviderName, Record<string, Rule>> = {
  anthropic: { effort: choice('medium', 'low', 'medium', 'high', 'xhigh', 'max'), max_tokens: number(1024, 128_000, 1024, 64_000, true) },
  openai: {
    reasoning_effort: choice('medium', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'), verbosity: choice('medium', 'low', 'medium', 'high'),
    max_output_tokens: number(256, 128_000, 256, 16_000, true), temperature: number(0, 2, 0.05, 1), top_p: number(0, 1, 0.05, 1),
  },
  vllm: {
    temperature: number(0, 2, 0.05, 0.7), top_p: number(0, 1, 0.05, 0.8), top_k: number(-1, 200, 1, 20, true), min_p: number(0, 1, 0.01, 0),
    presence_penalty: number(-2, 2, 0.05, 0), frequency_penalty: number(-2, 2, 0.05, 0), repetition_penalty: number(0.5, 2, 0.01, 1),
    max_tokens: number(1, 131_072, 256, 8192, true), min_tokens: number(0, 8192, 1, 0, true), seed: number(0, 2 ** 31 - 1, 1, 0, true),
    stop: { kind: 'list', initial: [] }, enable_thinking: { kind: 'boolean', initial: true },
  },
};
/** Fields the server fills in itself; a custom vLLM parameter cannot replace them. */
const RESERVED = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'n', 'chat_template_kwargs', 'response_format']);
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

export class ParamsError extends Error {}

/** Checks parameters for one provider; unknown names (custom ones only for vLLM) and out-of-range values are errors. */
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
      if (provider !== 'vllm') throw new ParamsError(`${name} is not a parameter of ${provider}; allowed: ${Object.keys(rules).join(', ')}`);
      if (!NAME.test(name) || RESERVED.has(name)) throw new ParamsError(`${name} cannot be set`);
      if (JSON.stringify(item).length > 2000) throw new ParamsError(`${name}: value too long`);
      continue;
    }
    const ok = rule.kind === 'number' ? typeof item === 'number' && Number.isFinite(item) && item >= rule.min && item <= rule.max && (!rule.integer || Number.isInteger(item))
      : rule.kind === 'enum' ? rule.values.includes(item as string)
        : rule.kind === 'boolean' ? typeof item === 'boolean'
          : Array.isArray(item) && item.length <= 8 && item.every(entry => typeof entry === 'string' && entry.length > 0 && entry.length <= 64);
    if (!ok) throw new ParamsError(`${name}: ${rule.kind === 'number' ? `a number from ${rule.min} to ${rule.max}` : rule.kind === 'enum' ? rule.values.join(', ') : rule.kind === 'list' ? 'up to 8 texts' : `a ${rule.kind}`}`);
  }
  return value as Params;
}

/** Parameters as they go into a vLLM request: the thinking switch becomes a chat-template argument. */
export function vllmBody(params: Params) {
  const { enable_thinking: thinking, ...rest } = params;
  return thinking === undefined ? rest : { ...rest, chat_template_kwargs: { enable_thinking: thinking } };
}
