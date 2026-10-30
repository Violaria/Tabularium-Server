import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Embedder } from './search.js';

// Conversations are stored in a small neutral form so they survive a change of provider. An assistant turn also keeps the
// provider's own content (Anthropic thinking and fallback blocks), replayed verbatim to the same provider.
export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string };
export interface Message { role: 'user' | 'assistant'; parts: Part[]; native?: { provider: string; content: unknown } }
export interface Tool { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] } }
export interface Turn { parts: Part[]; native: { provider: string; content: unknown } }
export interface Provider {
  name: 'anthropic' | 'openai'; model: string;
  turn(system: string, tools: Tool[], messages: Message[], onText: (text: string) => void): Promise<Turn>;
}
export class ProviderError extends Error {}

// Models that accept server-side fallbacks on a safety decline.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** Anthropic Messages API; the key and an optional base URL come from ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL. */
export function anthropic(model: string): Provider {
  const client = new Anthropic();
  const toBlocks = (message: Message): Anthropic.Beta.BetaContentBlockParam[] => message.parts.map(part =>
    part.type === 'text' ? { type: 'text', text: part.text }
      : part.type === 'tool_call' ? { type: 'tool_use', id: part.id, name: part.name, input: part.input }
        : { type: 'tool_result', tool_use_id: part.id, content: part.content });
  return {
    name: 'anthropic', model,
    async turn(system, tools, messages, onText) {
      const fallback = FALLBACK_MODELS.has(model);
      const stream = client.beta.messages.stream({
        model, max_tokens: 64000,
        thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        cache_control: { type: 'ephemeral' },
        system,
        tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters, eager_input_streaming: true })),
        messages: messages.map(message => ({
          role: message.role,
          content: message.role === 'assistant' && message.native?.provider === 'anthropic'
            ? message.native.content as Anthropic.Beta.BetaContentBlockParam[] : toBlocks(message),
        })),
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
      for (const block of final.content) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') parts.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
      return { parts, native: { provider: 'anthropic', content: final.content } };
    },
  };
}

/** OpenAI Chat Completions; the key and an optional base URL come from OPENAI_API_KEY and OPENAI_BASE_URL. */
export function openai(model: string): Provider {
  const client = new OpenAI();
  const toMessages = (message: Message): OpenAI.Chat.ChatCompletionMessageParam[] => {
    if (message.role === 'assistant') {
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
      const calls = message.parts.flatMap(part => part.type === 'tool_call'
        ? [{ id: part.id, type: 'function' as const, function: { name: part.name, arguments: JSON.stringify(part.input) } }] : []);
      return [{ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
    }
    return message.parts.map(part => part.type === 'tool_result'
      ? { role: 'tool' as const, tool_call_id: part.id, content: part.content }
      : { role: 'user' as const, content: part.type === 'text' ? part.text : '' });
  };
  return {
    name: 'openai', model,
    async turn(system, tools, messages, onText) {
      const calls: { id: string; name: string; arguments: string }[] = [];
      let text = '';
      try {
        const stream = await client.chat.completions.create({
          model, stream: true,
          messages: [{ role: 'system', content: system }, ...messages.flatMap(toMessages)],
          tools: tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) { text += delta.content; onText(delta.content); }
          for (const call of delta?.tool_calls ?? []) {
            const entry = calls[call.index] ??= { id: '', name: '', arguments: '' };
            entry.id ||= call.id ?? '';
            entry.name += call.function?.name ?? '';
            entry.arguments += call.function?.arguments ?? '';
          }
        }
      } catch (error) {
        if (error instanceof OpenAI.APIError) throw new ProviderError(`OpenAI ${error.status ?? ''} ${error.message}`.trim());
        throw new ProviderError(`OpenAI: ${(error as Error).message}`);
      }
      const parts: Part[] = text ? [{ type: 'text', text }] : [];
      for (const call of calls) {
        let input: Record<string, unknown>;
        try { input = JSON.parse(call.arguments || '{}'); } catch { input = { invalid: call.arguments }; }
        parts.push({ type: 'tool_call', id: call.id, name: call.name, input });
      }
      return { parts, native: { provider: 'openai', content: null } };
    },
  };
}

/** Embeddings through an OpenAI-compatible endpoint: OpenAI itself, or a local service at TABULARIUS_EMBEDDING_URL. */
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
