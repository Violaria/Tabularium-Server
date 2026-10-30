import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Embedder } from './search.js';
import type { Params } from './params.js';
import type { WebOptions } from './web.js';

// Conversations are stored in a small neutral form so they survive a change of provider. An assistant turn also keeps the
// provider's own content (Anthropic thinking, fallback and web blocks; OpenAI response items), replayed verbatim to the same
// provider. `web` (a search or fetch the provider ran) and `source` (a cited page) are for display only.
export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string }
  | { type: 'web'; name: string; input: Record<string, unknown> }
  | { type: 'source'; url: string; title: string };
export interface Message { role: 'user' | 'assistant'; parts: Part[]; native?: { provider: string; content: unknown } }
export interface Tool { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] } }
/** `paused`: the provider paused a long server-side turn; send it back unchanged to continue. */
export interface Turn { parts: Part[]; native: { provider: string; content: unknown }; paused?: boolean }
export interface Provider {
  name: 'anthropic' | 'openai' | 'vllm'; model: string;
  /** Whether the provider searches the web itself; the others get client-side search tools. */
  nativeWeb: boolean;
  turn(system: string, tools: Tool[], messages: Message[], onText: (text: string) => void, options?: TurnOptions): Promise<Turn>;
}
/** `web`: the provider's own web tools with these limits; `params`: checked model parameters (see params.ts). */
export interface TurnOptions { web?: WebOptions; params?: Params }

/** Cited pages, once each, in order of first citation. */
function sources(list: { url: string; title?: string | null }[]): Part[] {
  const seen = new Set<string>();
  return list.filter(s => s.url && !seen.has(s.url) && seen.add(s.url)).map(s => ({ type: 'source', url: s.url, title: s.title ?? '' }));
}
export class ProviderError extends Error {}

// Models that accept server-side fallbacks on a safety decline.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** Anthropic Messages API; the key and an optional base URL come from ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL. */
export function anthropic(model: string): Provider {
  const client = new Anthropic();
  const toBlocks = (message: Message): Anthropic.Beta.BetaContentBlockParam[] => message.parts.flatMap((part): Anthropic.Beta.BetaContentBlockParam[] =>
    part.type === 'text' ? [{ type: 'text', text: part.text }]
      : part.type === 'tool_call' ? [{ type: 'tool_use', id: part.id, name: part.name, input: part.input }]
        : part.type === 'tool_result' ? [{ type: 'tool_result', tool_use_id: part.id, content: part.content }] : []);
  // Server-side web tools: the API searches and fetches; domain rules and use limits travel with the tool definitions.
  const webTools = (web: WebOptions) => {
    const domains = web.allowed.length ? { allowed_domains: web.allowed } : web.blocked.length ? { blocked_domains: web.blocked } : {};
    return [
      { type: 'web_search_20260318' as const, name: 'web_search' as const, max_uses: web.maxUses, ...domains },
      { type: 'web_fetch_20260318' as const, name: 'web_fetch' as const, max_uses: web.maxUses * 2, citations: { enabled: true }, max_content_tokens: 50_000, ...domains },
    ];
  };
  return {
    name: 'anthropic', model, nativeWeb: true,
    async turn(system, tools, messages, onText, { web, params = {} } = {}) {
      const fallback = FALLBACK_MODELS.has(model);
      const stream = client.beta.messages.stream({
        model, max_tokens: (params.max_tokens as number | undefined) ?? 64000,
        thinking: { type: 'adaptive' }, output_config: { effort: (params.effort as 'medium' | undefined) ?? 'medium' },
        // Compaction summarises early context server-side near the window's limit; its block is replayed with the turn.
        betas: ['compact-2026-01-12', ...(fallback ? ['server-side-fallback-2026-07-01'] : [])],
        context_management: { edits: [{ type: 'compact_20260112' }] },
        ...(fallback ? { fallbacks: 'default' as const } : {}),
        cache_control: { type: 'ephemeral' },
        system,
        tools: [...tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters, eager_input_streaming: true })),
          ...(web ? webTools(web) : [])],
        // Turns from another provider that left nothing readable here (only its own web activity) are skipped.
        messages: messages.map(message => ({
          role: message.role,
          content: message.role === 'assistant' && message.native?.provider === 'anthropic'
            ? message.native.content as Anthropic.Beta.BetaContentBlockParam[] : toBlocks(message),
        })).filter(message => message.content.length),
      });
      stream.on('text', text => onText(text));
      let final;
      try { final = await stream.finalMessage(); } catch (error) {
        if (error instanceof Anthropic.APIError) throw new ProviderError(`Anthropic ${error.status ?? ''} ${error.message}`.trim());
        throw new ProviderError(`Anthropic: ${(error as Error).message}`);
      }
      if (final.stop_reason === 'refusal') throw new ProviderError('The model declined to answer');
      const calls = final.content.filter(block => block.type === 'tool_use');
      if (final.stop_reason === 'max_tokens' && calls.length) throw new ProviderError('The answer was cut off');
      const parts: Part[] = [];
      const cited: { url: string; title?: string | null }[] = [];
      for (const block of final.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text });
          for (const citation of block.citations ?? []) if (citation.type === 'web_search_result_location') cited.push(citation);
        } else if (block.type === 'tool_use') parts.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input as Record<string, unknown> });
        else if (block.type === 'server_tool_use' && (block.name === 'web_search' || block.name === 'web_fetch')) parts.push({ type: 'web', name: block.name, input: block.input as Record<string, unknown> });
        else if (block.type === 'web_fetch_tool_result' && block.content.type === 'web_fetch_result') cited.push({ url: block.content.url, title: block.content.content.title });
      }
      return { parts: [...parts, ...sources(cited)], native: { provider: 'anthropic', content: final.content }, paused: final.stop_reason === 'pause_turn' };
    },
  };
}

/**
 * OpenAI Responses API, with OpenAI's own web search. Nothing is stored at OpenAI (`store: false`); response items, with
 * encrypted reasoning, are replayed from our copy. The key comes from OPENAI_API_KEY.
 */
export function openai(model: string): Provider {
  const client = new OpenAI();
  const toItems = (message: Message): OpenAI.Responses.ResponseInputItem[] => {
    if (message.role === 'assistant') {
      if (message.native?.provider === 'openai') return message.native.content as OpenAI.Responses.ResponseInputItem[];
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
      return [...(text ? [{ role: 'assistant' as const, content: text }] : []),
        ...message.parts.flatMap(part => part.type === 'tool_call'
          ? [{ type: 'function_call' as const, call_id: part.id, name: part.name, arguments: JSON.stringify(part.input) }] : [])];
    }
    return message.parts.flatMap((part): OpenAI.Responses.ResponseInputItem[] => part.type === 'tool_result'
      ? [{ type: 'function_call_output', call_id: part.id, output: part.content }]
      : part.type === 'text' ? [{ role: 'user', content: part.text }] : []);
  };
  return {
    name: 'openai', model, nativeWeb: true,
    async turn(system, tools, messages, onText, { web, params = {} } = {}) {
      let response: OpenAI.Responses.Response | undefined;
      try {
        const stream = await client.responses.create({
          model, stream: true, store: false, include: ['reasoning.encrypted_content'], truncation: 'auto',
          ...(params.reasoning_effort ? { reasoning: { effort: params.reasoning_effort as OpenAI.ReasoningEffort } } : {}),
          ...(params.verbosity ? { text: { verbosity: params.verbosity as 'low' | 'medium' | 'high' } } : {}),
          ...(params.max_output_tokens ? { max_output_tokens: params.max_output_tokens as number } : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature as number } : {}),
          ...(params.top_p !== undefined ? { top_p: params.top_p as number } : {}),
          instructions: system, input: messages.flatMap(toItems),
          tools: [...tools.map(tool => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
            ...(web ? [{ type: 'web_search' as const, ...(web.allowed.length ? { filters: { allowed_domains: web.allowed } } : {}) }] : [])],
        });
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') onText(event.delta);
          else if (event.type === 'response.completed' || event.type === 'response.incomplete') response = event.response;
          else if (event.type === 'response.failed') throw new ProviderError(`OpenAI: ${event.response.error?.message ?? 'the response failed'}`);
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof OpenAI.APIError) throw new ProviderError(`OpenAI ${error.status ?? ''} ${error.message}`.trim());
        throw new ProviderError(`OpenAI: ${(error as Error).message}`);
      }
      if (!response) throw new ProviderError('OpenAI: the stream ended without a response');
      const parts: Part[] = [];
      const cited: { url: string; title?: string | null }[] = [];
      for (const item of response.output) {
        if (item.type === 'message') for (const content of item.content) {
          if (content.type !== 'output_text') continue;
          parts.push({ type: 'text', text: content.text });
          for (const annotation of content.annotations) if (annotation.type === 'url_citation') cited.push(annotation);
        } else if (item.type === 'function_call') {
          let input: Record<string, unknown>;
          try { input = JSON.parse(item.arguments || '{}'); } catch { input = { invalid: item.arguments }; }
          parts.push({ type: 'tool_call', id: item.call_id, name: item.name, input });
        } else if (item.type === 'web_search_call') {
          const action = item.action as { type: string; query?: string; queries?: string[]; url?: string | null };
          parts.push({ type: 'web', name: action.type === 'search' ? 'web_search' : 'web_fetch', input: action.type === 'search' ? { query: action.query ?? action.queries?.join(' / ') ?? '' } : { url: action.url ?? '' } });
        }
      }
      return { parts: [...parts, ...sources(cited)], native: { provider: 'openai', content: response.output } };
    },
  };
}

/**
 * vLLM's Chat Completions, for local models. vLLM adds `reasoning` to the streamed deltas and accepts it back on assistant
 * messages, where chat templates such as Qwen3's keep the thinking of the turns since the last question (interleaved
 * thinking during tool calls), so it is stored and replayed. Tool calls need the server's --enable-auto-tool-choice and a
 * --tool-call-parser for the model. Sampling defaults come from the model's generation_config on the server.
 */
export function vllm(model: string, baseURL: string, apiKey?: string, contextTokens = 32_768): Provider {
  const client = new OpenAI({ baseURL, apiKey: apiKey || 'none' });
  type Assistant = OpenAI.Chat.ChatCompletionAssistantMessageParam & { reasoning?: string };
  const toMessages = (message: Message): OpenAI.Chat.ChatCompletionMessageParam[] => {
    if (message.role === 'assistant') {
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
      const calls = message.parts.flatMap(part => part.type === 'tool_call'
        ? [{ id: part.id, type: 'function' as const, function: { name: part.name, arguments: JSON.stringify(part.input) } }] : []);
      const reasoning = message.native?.provider === 'vllm' ? (message.native.content as { reasoning?: string }).reasoning : undefined;
      if (!text && !calls.length) return [];
      const assistant: Assistant = { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning } : {}) };
      return [assistant];
    }
    return message.parts.flatMap((part): OpenAI.Chat.ChatCompletionMessageParam[] => part.type === 'tool_result'
      ? [{ role: 'tool', tool_call_id: part.id, content: part.content }]
      : part.type === 'text' ? [{ role: 'user', content: part.text }] : []);
  };
  return {
    name: 'vllm', model, nativeWeb: false,
    async turn(system, tools, messages, onText, { params = {} } = {}) {
      const calls: { id: string; name: string; arguments: string }[] = [];
      let text = ''; let reasoning = '';
      try {
        // vLLM's own fields (top_k, min_p, repetition_penalty, chat_template_kwargs) go in the body next to the standard ones.
        const stream = await client.chat.completions.create({
          ...params,
          model, stream: true,
          messages: [{ role: 'system', content: system }, ...fit(messages, contextTokens - estimate(system) - estimate(JSON.stringify(tools))).flatMap(toMessages)],
          tools: tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming);
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning?: string }) | undefined;
          if (delta?.reasoning) reasoning += delta.reasoning;
          if (delta?.content) { text += delta.content; onText(delta.content); }
          for (const call of delta?.tool_calls ?? []) {
            const entry = calls[call.index] ??= { id: '', name: '', arguments: '' };
            entry.id ||= call.id ?? '';
            entry.name += call.function?.name ?? '';
            entry.arguments += call.function?.arguments ?? '';
          }
        }
      } catch (error) {
        if (error instanceof OpenAI.APIError) throw new ProviderError(`vLLM ${error.status ?? ''} ${error.message}`.trim());
        throw new ProviderError(`vLLM: ${(error as Error).message}`);
      }
      const parts: Part[] = text ? [{ type: 'text', text }] : [];
      for (const call of calls) {
        let input: Record<string, unknown>;
        try { input = JSON.parse(call.arguments || '{}'); } catch { input = { invalid: call.arguments }; }
        parts.push({ type: 'tool_call', id: call.id, name: call.name, input });
      }
      return { parts, native: { provider: 'vllm', content: { reasoning } } };
    },
  };
}

// About three characters per token, a cautious average for mixed Chinese and English.
const estimate = (text: string) => Math.ceil(text.length / 3);

/**
 * Keeps the history within three quarters of `budget` tokens by dropping whole exchanges from the start. An exchange runs
 * from one of the user's questions to the next, so a tool call is never separated from its result; the current exchange
 * is always kept.
 */
export function fit(messages: Message[], budget: number): Message[] {
  const size = (message: Message) => estimate(JSON.stringify(message.parts)) + estimate(JSON.stringify(message.native?.content ?? ''));
  const starts = messages.flatMap((message, i) => message.role === 'user' && message.parts.some(part => part.type === 'text') ? [i] : []);
  let total = messages.reduce((sum, message) => sum + size(message), 0);
  let from = 0;
  for (const start of starts.slice(1)) {
    if (total <= budget * 0.75) break;
    total -= messages.slice(from, start).reduce((sum, message) => sum + size(message), 0);
    from = start;
  }
  if (!from) return messages;
  return [{ role: 'user', parts: [{ type: 'text', text: '(The earlier part of this conversation was left out to fit the context window.)' }] }, ...messages.slice(from)];
}

/** Embeddings through the OpenAI embeddings API shape: OpenAI itself, or a local service (Infinity, vLLM) at TABULARIUS_EMBEDDING_URL. */
export function embedder(model: string, url?: string, key?: string, batch = 64): Embedder {
  const client = new OpenAI({ ...(url ? { baseURL: url } : {}), apiKey: key || process.env.OPENAI_API_KEY || 'none' });
  return {
    model,
    async embed(texts) {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batch) {
        const response = await client.embeddings.create({ model, input: texts.slice(i, i + batch) });
        for (const item of response.data.sort((a, b) => a.index - b.index)) vectors.push(Float32Array.from(item.embedding));
      }
      return vectors;
    },
  };
}
