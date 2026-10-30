// Model parameters each provider accepts, checked before they reach the API. Current Claude models take no sampling
// parameters (temperature, top_p, top_k are rejected); effort is the control. OpenAI's reasoning models take effort and
// verbosity; vLLM takes the usual sampling parameters and keyword arguments for the model's chat template.
export type Params = Record<string, unknown>;
type Rule = { kind: 'number'; min: number; max: number; integer?: boolean } | { kind: 'enum'; values: string[] } | { kind: 'object' } | { kind: 'boolean' };

const number = (min: number, max: number, integer = false): Rule => ({ kind: 'number', min, max, integer });
const choice = (...values: string[]): Rule => ({ kind: 'enum', values });

export const PARAMS: Record<'anthropic' | 'openai' | 'vllm', Record<string, Rule>> = {
  anthropic: { effort: choice('low', 'medium', 'high', 'xhigh', 'max'), max_tokens: number(1024, 128_000, true) },
  openai: {
    reasoning_effort: choice('none', 'minimal', 'low', 'medium', 'high', 'xhigh'), verbosity: choice('low', 'medium', 'high'),
    max_output_tokens: number(256, 128_000, true), temperature: number(0, 2), top_p: number(0, 1),
  },
  vllm: {
    temperature: number(0, 2), top_p: number(0, 1), top_k: number(-1, 1000, true), min_p: number(0, 1),
    presence_penalty: number(-2, 2), frequency_penalty: number(-2, 2), repetition_penalty: number(0.5, 2),
    max_tokens: number(1, 1_000_000, true), seed: number(0, 2 ** 31 - 1, true), chat_template_kwargs: { kind: 'object' },
  },
};

export class ParamsError extends Error {}

/** Parses a JSON object of parameters for one provider; unknown names and out-of-range values are errors. */
export function checkParams(provider: keyof typeof PARAMS, text: string): Params {
  if (!text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ParamsError('Parameters must be a JSON object'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ParamsError('Parameters must be a JSON object');
  const rules = PARAMS[provider];
  for (const [name, item] of Object.entries(value)) {
    const rule = rules[name];
    if (!rule) throw new ParamsError(`${name} is not a parameter of ${provider}; allowed: ${Object.keys(rules).join(', ')}`);
    const ok = rule.kind === 'number' ? typeof item === 'number' && Number.isFinite(item) && item >= rule.min && item <= rule.max && (!rule.integer || Number.isInteger(item))
      : rule.kind === 'enum' ? rule.values.includes(item as string)
        : rule.kind === 'boolean' ? typeof item === 'boolean'
          : typeof item === 'object' && item !== null && !Array.isArray(item);
    if (!ok) throw new ParamsError(`${name}: ${rule.kind === 'number' ? `a number from ${rule.min} to ${rule.max}` : rule.kind === 'enum' ? rule.values.join(', ') : `a ${rule.kind}`}`);
  }
  return value as Params;
}
