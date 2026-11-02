import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import type { Embedder } from './search.js';
import { anthropicEdits, geminiSafety, merge, place, type Params, type ProviderName } from './params.js';
import type { WebOptions } from './web.js';

// Conversations are stored in a small neutral form so they survive a change of provider. An assistant turn also keeps the
// provider's own content (Anthropic thinking, fallback and web blocks; OpenAI response items), replayed verbatim to the same
// provider. `web` (a search or fetch the provider ran) and `source` (a cited page) are for display only. A user message
// stores its attachments as `attachment` references; before a request they are expanded into `image` parts (base64) and
// text, which are never stored.
export type Part =
  | { type: 'text'; text: string }
  | { type: 'attachment'; id: string; name: string; kind: 'image' | 'text' }
  | { type: 'image'; mime: string; data: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string }
  | { type: 'web'; name: string; input: Record<string, unknown> }
  | { type: 'source'; url: string; title: string };
export interface Message { role: 'user' | 'assistant'; parts: Part[]; native?: { provider: string; model?: string; content: unknown } }
export interface Tool { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] } }
/** `paused`: the provider paused a long server-side turn; send it back unchanged to continue. */
export interface Turn { parts: Part[]; native: { provider: string; model?: string; content: unknown }; paused?: boolean }
export interface Provider {
  name: ProviderName; model: string;
  /** Whether the provider searches the web itself; the others get client-side search tools. */
  nativeWeb: boolean;
  turn(system: string, tools: Tool[], messages: Message[], onText: (text: string) => void, options?: TurnOptions): Promise<Turn>;
}
/**
 * `web`: the provider's own web tools with these limits; `params`: checked model parameters (see params.ts); `answerOnly`: the
 * tool limit is reached, so the model must answer without calling tools.
 */
export interface TurnOptions { web?: WebOptions; params?: Params; answerOnly?: boolean }

/** Cited pages, once each, in order of first citation. */
function sources(list: { url: string; title?: string | null }[]): Part[] {
  const seen = new Set<string>();
  return list.filter(s => s.url && !seen.has(s.url) && seen.add(s.url)).map(s => ({ type: 'source', url: s.url, title: s.title ?? '' }));
}
export class ProviderError extends Error {}
/**
 * Whether an assistant turn's own items can be replayed: only to the provider and model that made them (older turns did
 * not record the model). After a switch the neutral parts are sent instead.
 */
const own = (message: Message, provider: string, model: string) =>
  message.native?.provider === provider && (message.native.model === undefined || message.native.model === model);

// Models that accept server-side fallbacks on a safety decline.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** Anthropic Messages API; an optional base URL comes from ANTHROPIC_BASE_URL. */
export function anthropic(model: string, apiKey?: string): Provider {
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}) });
  const toBlocks = (message: Message): Anthropic.Beta.BetaContentBlockParam[] => message.parts.flatMap((part): Anthropic.Beta.BetaContentBlockParam[] =>
    part.type === 'text' ? [{ type: 'text', text: part.text }]
      : part.type === 'image' ? [{ type: 'image', source: { type: 'base64', media_type: part.mime as 'image/png', data: part.data } }]
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
    async turn(system, tools, messages, onText, { web, params = {}, answerOnly = false } = {}) {
      // Refusal fallbacks are on for the models that take them unless the recipe turns them off (or on for another model).
      const fallback = params.fallbacks === undefined ? FALLBACK_MODELS.has(model) : params.fallbacks === 'default';
      const placed = place('anthropic', params);
      const context = anthropicEdits(params);
      // Adaptive thinking at medium effort, prompt caching and compaction unless the parameters say otherwise; compaction
      // summarises early context server-side near the window's limit, and its block is replayed with the turn.
      const request = merge({
        model, max_tokens: 64000, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
        betas: [...new Set(['compact-2026-01-12', ...(fallback ? ['server-side-fallback-2026-07-01'] : []), ...placed.betas, ...context.betas])],
        context_management: { edits: context.edits },
        ...(fallback ? { fallbacks: 'default' } : {}),
        cache_control: { type: 'ephemeral' },
      }, placed.fields) as unknown as Omit<Anthropic.Beta.Messages.MessageCreateParamsStreaming, 'system' | 'tools' | 'messages' | 'stream'>;
      const stream = client.beta.messages.stream({
        ...request,
        system,
        // A request without tools (a connection test) leaves the fields out: the APIs reject an empty list.
        ...(tools.length || web ? {
          tools: [...tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters, eager_input_streaming: true })),
            ...(web ? webTools(web) : [])],
          ...(answerOnly ? { tool_choice: { type: 'none' as const } } : {}),
        } : {}),
        // Turns from another provider that left nothing readable here (only its own web activity) are skipped.
        messages: messages.map(message => ({
          role: message.role,
          content: message.role === 'assistant' && own(message, 'anthropic', model)
            ? message.native!.content as Anthropic.Beta.BetaContentBlockParam[] : toBlocks(message),
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
      return { parts: [...parts, ...sources(cited)], native: { provider: 'anthropic', model, content: final.content }, paused: final.stop_reason === 'pause_turn' };
    },
  };
}

/**
 * OpenAI Responses API, with OpenAI's own web search. Nothing is stored at OpenAI (`store: false`); response items, with
 * encrypted reasoning, are replayed from our copy.
 */
export function openai(model: string, apiKey?: string): Provider {
  const client = new OpenAI({ ...(apiKey ? { apiKey } : {}) });
  const toItems = (message: Message): OpenAI.Responses.ResponseInputItem[] => {
    if (message.role === 'assistant') {
      if (own(message, 'openai', model)) return message.native!.content as OpenAI.Responses.ResponseInputItem[];
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
      return [...(text ? [{ role: 'assistant' as const, content: text }] : []),
        ...message.parts.flatMap(part => part.type === 'tool_call'
          ? [{ type: 'function_call' as const, call_id: part.id, name: part.name, arguments: JSON.stringify(part.input) }] : [])];
    }
    return message.parts.flatMap((part): OpenAI.Responses.ResponseInputItem[] => part.type === 'tool_result'
      ? [{ type: 'function_call_output', call_id: part.id, output: part.content }]
      : part.type === 'text' ? [{ role: 'user', content: part.text }]
        : part.type === 'image' ? [{ role: 'user', content: [{ type: 'input_image', image_url: `data:${part.mime};base64,${part.data}`, detail: 'auto' }] }] : []);
  };
  return {
    name: 'openai', model, nativeWeb: true,
    async turn(system, tools, messages, onText, { web, params = {}, answerOnly = false } = {}) {
      let response: OpenAI.Responses.Response | undefined;
      try {
        // Nothing stored at OpenAI and the encrypted reasoning returned, unless the parameters say otherwise; extra output
        // (`include`) is added to it, with the token log probabilities when top_logprobs is set.
        const include = [...new Set(['reasoning.encrypted_content', ...((params.include as string[] | undefined) ?? []),
          ...(params.top_logprobs !== undefined ? ['message.output_text.logprobs'] : [])])];
        const request = merge({
          store: false, include, truncation: 'auto',
          ...(params.compact_threshold !== undefined ? { context_management: [{ type: 'compaction', compact_threshold: params.compact_threshold }] } : {}),
        }, place('openai', params).fields) as unknown as Omit<OpenAI.Responses.ResponseCreateParamsStreaming, 'model' | 'stream' | 'input'>;
        const stream = await client.responses.create({
          ...request, model, stream: true,
          instructions: system, input: messages.flatMap(toItems),
          ...(tools.length || web ? {
            tools: [...tools.map(tool => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
              ...(web ? [{ type: 'web_search' as const, ...(web.allowed.length ? { filters: { allowed_domains: web.allowed } } : {}) }] : [])],
            ...(answerOnly ? { tool_choice: 'none' as const } : {}),
          } : {}),
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
      return { parts: [...parts, ...sources(cited)], native: { provider: 'openai', model, content: response.output } };
    },
  };
}

/**
 * vLLM's Chat Completions, for local models. vLLM adds `reasoning` to the streamed deltas and accepts it back on assistant
 * messages, where chat templates such as Qwen3's keep the thinking of the turns since the last question (interleaved
 * thinking during tool calls), so it is stored and replayed. Tool calls need the server's --enable-auto-tool-choice and a
 * --tool-call-parser for the model. Sampling defaults come from the model's generation_config on the server.
 */
export const vllm = (model: string, baseURL: string, apiKey?: string, contextTokens = 32_768) =>
  localChat('vllm', 'vLLM', 'reasoning', model, baseURL, apiKey, contextTokens);

/**
 * TensorRT-LLM's `trtllm-serve` Chat Completions, for local models. With the server's --reasoning_parser the thinking
 * comes in `reasoning_content` and is replayed under that name; tool calls need its --tool_parser. It rejects fields it
 * does not know, so only the parameters of its table (and custom ones the administrator adds) are sent.
 */
export const tensorrt = (model: string, baseURL: string, apiKey?: string, contextTokens = 32_768) =>
  localChat('tensorrt', 'TensorRT-LLM', 'reasoning_content', model, baseURL, apiKey, contextTokens);

/** A local Chat Completions server: the thinking field, replayed to the same model, differs between servers. */
function localChat(name: 'vllm' | 'tensorrt', label: string, field: 'reasoning' | 'reasoning_content', model: string, baseURL: string, apiKey: string | undefined, contextTokens: number): Provider {
  const client = new OpenAI({ baseURL, apiKey: apiKey || 'none' });
  type Assistant = OpenAI.Chat.ChatCompletionAssistantMessageParam & { reasoning?: string; reasoning_content?: string };
  const toMessages = (message: Message): OpenAI.Chat.ChatCompletionMessageParam[] => {
    if (message.role === 'assistant') {
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
      const calls = message.parts.flatMap(part => part.type === 'tool_call'
        ? [{ id: part.id, type: 'function' as const, function: { name: part.name, arguments: JSON.stringify(part.input) } }] : []);
      const reasoning = own(message, name, model) ? (message.native!.content as { reasoning?: string }).reasoning : undefined;
      if (!text && !calls.length) return [];
      const assistant: Assistant = { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { [field]: reasoning } : {}) };
      return [assistant];
    }
    return message.parts.flatMap((part): OpenAI.Chat.ChatCompletionMessageParam[] => part.type === 'tool_result'
      ? [{ role: 'tool', tool_call_id: part.id, content: part.content }]
      : part.type === 'text' ? [{ role: 'user', content: part.text }]
        : part.type === 'image' ? [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.data}` } }] }] : []);
  };
  return {
    name, model, nativeWeb: false,
    async turn(system, tools, messages, onText, { params = {}, answerOnly = false } = {}) {
      const calls: { id: string; name: string; arguments: string }[] = [];
      let text = ''; let reasoning = '';
      try {
        // The server's own fields (top_k, min_p, chat_template_kwargs, ...) go in the body next to the standard ones.
        const stream = await client.chat.completions.create({
          ...place(name, params).fields,
          model, stream: true,
          messages: [{ role: 'system', content: system }, ...fit(messages, contextTokens - estimate(system) - estimate(JSON.stringify(tools))).flatMap(toMessages),
            // With tool_choice none alone Qwen often still tries a call, which the server drops, leaving an empty answer.
            ...(answerOnly ? [{ role: 'user' as const, content: ANSWER_NOW }] : [])],
          ...(tools.length ? {
            tools: tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
            ...(answerOnly ? { tool_choice: 'none' as const } : {}),
          } : {}),
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming);
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning?: string; reasoning_content?: string }) | undefined;
          if (delta?.[field]) reasoning += delta[field];
          if (delta?.content) { text += delta.content; onText(delta.content); }
          for (const call of delta?.tool_calls ?? []) {
            const entry = calls[call.index] ??= { id: '', name: '', arguments: '' };
            entry.id ||= call.id ?? '';
            entry.name += call.function?.name ?? '';
            entry.arguments += call.function?.arguments ?? '';
          }
        }
      } catch (error) {
        if (error instanceof OpenAI.APIError) throw new ProviderError(`${label} ${error.status ?? ''} ${error.message}`.trim());
        throw new ProviderError(`${label}: ${(error as Error).message}`);
      }
      const parts: Part[] = text ? [{ type: 'text', text }] : [];
      for (const call of calls) parts.push({ type: 'tool_call', id: call.id, name: call.name, input: argumentsOf(call.arguments) });
      return { parts, native: { provider: name, model, content: { reasoning } } };
    },
  };
}

/** A tool call's arguments as an object; text that is not JSON is kept for the model to see. */
function argumentsOf(text: string): Record<string, unknown> {
  try { return JSON.parse(text || '{}'); } catch { return { invalid: text }; }
}
/** The names of the tools called, by call ID, for providers whose tool results carry the name. */
function callNames(messages: Message[]) {
  const names = new Map<string, string>();
  for (const message of messages) for (const part of message.parts) if (part.type === 'tool_call') names.set(part.id, part.name);
  return names;
}

/**
 * Gemini API (generateContent over REST, streamed as server-sent events). A model turn's parts are stored as given and
 * replayed to the same model: function calls carry a thoughtSignature that Gemini 3 and later require back in the same
 * turn. After a switch of model the neutral parts are sent, function calls with the placeholder signature the API
 * accepts for calls it did not make. Tool results go back together in one user turn as functionResponse parts. Web
 * search is Gemini's own Google Search, unless `nativeSearch` is off (a domain list is configured, which Google Search
 * cannot apply): then the server's SearXNG tools are offered instead. The base address can be replaced with
 * GEMINI_BASE_URL.
 */
export function gemini(model: string, apiKey: string, nativeSearch = true): Provider {
  const base = (process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  interface GeminiPart { text?: string; thought?: boolean; thoughtSignature?: string; inlineData?: { mimeType: string; data: string };
    functionCall?: { id?: string; name: string; args?: Record<string, unknown> }; functionResponse?: { id?: string; name: string; response: Record<string, unknown> } }
  interface Content { role: 'user' | 'model'; parts: GeminiPart[] }
  const toContents = (messages: Message[]): Content[] => {
    const names = callNames(messages);
    const contents: Content[] = [];
    for (const message of messages) {
      if (message.role === 'assistant') {
        if (own(message, 'gemini', model)) { contents.push({ role: 'model', parts: message.native!.content as GeminiPart[] }); continue; }
        const parts: GeminiPart[] = message.parts.flatMap((part): GeminiPart[] => part.type === 'text' ? [{ text: part.text }]
          : part.type === 'tool_call' ? [{ functionCall: { id: part.id, name: part.name, args: part.input }, thoughtSignature: 'skip_thought_signature_validator' }] : []);
        if (parts.length) contents.push({ role: 'model', parts });
        continue;
      }
      const parts: GeminiPart[] = message.parts.flatMap((part): GeminiPart[] => part.type === 'text' ? [{ text: part.text }]
        : part.type === 'image' ? [{ inlineData: { mimeType: part.mime, data: part.data } }]
        : part.type === 'tool_result' ? [{ functionResponse: { id: part.id, name: names.get(part.id) ?? 'tool', response: { result: part.content } } }] : []);
      if (parts.length) contents.push({ role: 'user', parts });
    }
    return contents;
  };
  return {
    name: 'gemini', model, nativeWeb: nativeSearch,
    async turn(system, tools, messages, onText, { web, params = {}, answerOnly = false } = {}) {
      const stored: GeminiPart[] = [];
      const queries: string[] = [];
      const cited: { url: string; title?: string | null }[] = [];
      try {
        const response = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: toContents(messages),
            tools: [...(tools.length ? [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] : []),
              ...(web ? [{ googleSearch: {} }] : [])],
            ...(tools.length && answerOnly ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
            ...place('gemini', params).fields,
            ...(geminiSafety(params).length ? { safetySettings: geminiSafety(params) } : {}),
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          let detail = body.slice(0, 500);
          try { detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* the body as it came */ }
          throw new ProviderError(`Gemini ${response.status} ${detail}`.trim());
        }
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        const take = (data: string) => {
          const chunk = JSON.parse(data) as { candidates?: { content?: { parts?: GeminiPart[] }; groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: { web?: { uri: string; title?: string } }[] } }[]; error?: { message: string } };
          if (chunk.error) throw new ProviderError(`Gemini: ${chunk.error.message}`);
          const candidate = chunk.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (part.text !== undefined && !part.thought) {
              if (part.text) onText(part.text);
              // Adjacent text arrives in pieces; one part keeps the text and the signature that came last.
              const last = stored.at(-1);
              if (last && last.text !== undefined && !last.thought && !last.functionCall) {
                last.text += part.text;
                if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
                continue;
              }
            }
            stored.push({ ...part });
          }
          for (const query of candidate?.groundingMetadata?.webSearchQueries ?? []) if (!queries.includes(query)) queries.push(query);
          for (const item of candidate?.groundingMetadata?.groundingChunks ?? []) if (item.web?.uri) cited.push({ url: item.web.uri, title: item.web.title });
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
            if (data) take(data);
          }
        }
        if (buffer.trim().startsWith('data:')) take(buffer.trim().slice(5).trim());
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(`Gemini: ${(error as Error).message}`);
      }
      const parts: Part[] = [...queries.map((query): Part => ({ type: 'web', name: 'web_search', input: { query } }))];
      const text = stored.flatMap(part => part.text !== undefined && !part.thought ? [part.text] : []).join('');
      if (text) parts.push({ type: 'text', text });
      for (const part of stored) if (part.functionCall)
        parts.push({ type: 'tool_call', id: part.functionCall.id ?? `call_${randomUUID()}`, name: part.functionCall.name, input: part.functionCall.args ?? {} });
      // Calls without an ID get one here, kept in the stored parts so the replay and the results match.
      let index = 0;
      const calls = parts.filter(part => part.type === 'tool_call');
      for (const part of stored) if (part.functionCall) part.functionCall.id = calls[index++].id;
      return { parts: [...parts, ...sources(cited)], native: { provider: 'gemini', model, content: stored } };
    },
  };
}

/**
 * DeepSeek's Chat Completions (with the OpenAI SDK, as DeepSeek documents). Thinking models return `reasoning_content`
 * beside the answer; a request with tools must carry it back for every earlier turn (it is ignored otherwise), so it is
 * stored and replayed to the same model. Web search goes through SearXNG. DEEPSEEK_BASE_URL replaces the address.
 */
export function deepseek(model: string, apiKey: string): Provider {
  const client = new OpenAI({ apiKey, baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com' });
  type Assistant = OpenAI.Chat.ChatCompletionAssistantMessageParam & { reasoning_content?: string };
  const toMessages = (message: Message): OpenAI.Chat.ChatCompletionMessageParam[] => {
    if (message.role === 'assistant') {
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
      const calls = message.parts.flatMap(part => part.type === 'tool_call'
        ? [{ id: part.id, type: 'function' as const, function: { name: part.name, arguments: JSON.stringify(part.input) } }] : []);
      const reasoning = own(message, 'deepseek', model) ? (message.native!.content as { reasoning?: string }).reasoning : undefined;
      if (!text && !calls.length) return [];
      const assistant: Assistant = { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) };
      return [assistant];
    }
    return message.parts.flatMap((part): OpenAI.Chat.ChatCompletionMessageParam[] => part.type === 'tool_result'
      ? [{ role: 'tool', tool_call_id: part.id, content: part.content }]
      : part.type === 'text' ? [{ role: 'user', content: part.text }]
        : part.type === 'image' ? [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.data}` } }] }] : []);
  };
  return {
    name: 'deepseek', model, nativeWeb: false,
    async turn(system, tools, messages, onText, { params = {}, answerOnly = false } = {}) {
      const calls: { id: string; name: string; arguments: string }[] = [];
      let text = ''; let reasoning = '';
      try {
        const stream = await client.chat.completions.create({
          ...place('deepseek', params).fields,
          model, stream: true,
          messages: [{ role: 'system', content: system }, ...messages.flatMap(toMessages)],
          ...(tools.length ? {
            tools: tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
            ...(answerOnly ? { tool_choice: 'none' as const } : {}),
          } : {}),
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming);
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string }) | undefined;
          if (delta?.reasoning_content) reasoning += delta.reasoning_content;
          if (delta?.content) { text += delta.content; onText(delta.content); }
          for (const call of delta?.tool_calls ?? []) {
            const entry = calls[call.index] ??= { id: '', name: '', arguments: '' };
            entry.id ||= call.id ?? '';
            entry.name += call.function?.name ?? '';
            entry.arguments += call.function?.arguments ?? '';
          }
        }
      } catch (error) {
        if (error instanceof OpenAI.APIError) throw new ProviderError(`DeepSeek ${error.status ?? ''} ${error.message}`.trim());
        throw new ProviderError(`DeepSeek: ${(error as Error).message}`);
      }
      const parts: Part[] = text ? [{ type: 'text', text }] : [];
      for (const call of calls) parts.push({ type: 'tool_call', id: call.id, name: call.name, input: argumentsOf(call.arguments) });
      return { parts, native: { provider: 'deepseek', model, content: { reasoning } } };
    },
  };
}

/**
 * Ollama's own chat API (/api/chat, streamed as JSON lines), for local models. Its OpenAI-compatible endpoint cannot set
 * the context length, and Ollama cuts an overlong prompt from the start, losing the system prompt; so every request sends
 * `num_ctx` (the recipe's, else `contextTokens`) and older turns are left out to fit it. Thinking (`message.thinking`) is
 * stored and replayed to the same model; tool results carry the tool's name; images go in the message's `images`.
 */
export function ollama(model: string, baseURL: string, apiKey?: string, contextTokens = 32_768): Provider {
  const base = baseURL.replace(/\/$/, '');
  interface OllamaMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; thinking?: string; images?: string[];
    tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]; tool_name?: string }
  const toMessages = (message: Message, names: Map<string, string>): OllamaMessage[] => {
    if (message.role === 'assistant') {
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
      const calls = message.parts.flatMap(part => part.type === 'tool_call' ? [{ function: { name: part.name, arguments: part.input } }] : []);
      const thinking = own(message, 'ollama', model) ? (message.native!.content as { thinking?: string }).thinking : undefined;
      if (!text && !calls.length) return [];
      return [{ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}), ...(thinking ? { thinking } : {}) }];
    }
    return message.parts.flatMap((part): OllamaMessage[] => part.type === 'tool_result' ? [{ role: 'tool', content: part.content, tool_name: names.get(part.id) ?? 'tool' }]
      : part.type === 'text' ? [{ role: 'user', content: part.text }]
        : part.type === 'image' ? [{ role: 'user', content: '', images: [part.data] }] : []);
  };
  return {
    name: 'ollama', model, nativeWeb: false,
    async turn(system, tools, messages, onText, { params = {}, answerOnly = false } = {}) {
      // `think`, keep_alive and the like at the top, sampling and loading settings in `options`.
      const { options = {}, ...top } = place('ollama', params).fields as { options?: Record<string, unknown> };
      const context = (options.num_ctx as number | undefined) ?? contextTokens;
      const kept = fit(messages, context - estimate(system) - estimate(JSON.stringify(tools)) - ((options.num_predict as number) > 0 ? options.num_predict as number : 0));
      const names = callNames(kept);
      const calls: { name: string; arguments: Record<string, unknown> }[] = [];
      let text = ''; let thinking = '';
      try {
        const response = await fetch(`${base}/api/chat`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            ...top, model, stream: true, options: { ...options, num_ctx: context },
            messages: [{ role: 'system', content: system }, ...kept.flatMap(message => toMessages(message, names)),
              // Ollama has no tool_choice: the last round goes without tools and with the instruction to answer.
              ...(answerOnly ? [{ role: 'user', content: ANSWER_NOW }] : [])],
            ...(tools.length && !answerOnly ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          let detail = body.slice(0, 500);
          try { detail = (JSON.parse(body) as { error?: string }).error ?? detail; } catch { /* the body as it came */ }
          throw new ProviderError(`Ollama ${response.status} ${detail}`.trim());
        }
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        const take = (line: string) => {
          const chunk = JSON.parse(line) as { message?: OllamaMessage; error?: string };
          if (chunk.error) throw new ProviderError(`Ollama: ${chunk.error}`);
          if (chunk.message?.thinking) thinking += chunk.message.thinking;
          if (chunk.message?.content) { text += chunk.message.content; onText(chunk.message.content); }
          for (const call of chunk.message?.tool_calls ?? []) calls.push({ name: call.function.name, arguments: call.function.arguments ?? {} });
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
            if (line) take(line);
          }
        }
        if (buffer.trim()) take(buffer.trim());
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(`Ollama: ${(error as Error).message}`);
      }
      const parts: Part[] = text ? [{ type: 'text', text }] : [];
      for (const call of calls) parts.push({ type: 'tool_call', id: `call_${randomUUID()}`, name: call.name, input: call.arguments });
      return { parts, native: { provider: 'ollama', model, content: { thinking } } };
    },
  };
}

// Sent only in the request, never stored, so it is not taken for one of the user's questions.
const ANSWER_NOW = 'The tool limit for this answer is reached. Answer now with what you have found, without calling tools.';

// About three characters per token, a cautious average for mixed Chinese and English.
const estimate = (text: string) => Math.ceil(text.length / 3);
// A picture of up to 1568 pixels on its long side, generously.
const IMAGE_TOKENS = 1600;

/**
 * Keeps the history within three quarters of `budget` tokens by dropping whole exchanges from the start. An exchange runs
 * from one of the user's questions to the next, so a tool call is never separated from its result; the current exchange
 * is always kept.
 */
export function fit(messages: Message[], budget: number): Message[] {
  // An image costs about the same whatever its encoded length: a fixed estimate instead of its base64 size.
  const size = (message: Message) => message.parts.reduce((sum, part) => sum + (part.type === 'image' ? IMAGE_TOKENS : estimate(JSON.stringify(part))), 0)
    + estimate(JSON.stringify(message.native?.content ?? ''));
  const starts = messages.flatMap((message, i) => message.role === 'user' && message.parts.some(part => part.type === 'text' || part.type === 'image') ? [i] : []);
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
  const client = new OpenAI({ ...(url ? { baseURL: url } : {}), apiKey: key || 'none' });
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
