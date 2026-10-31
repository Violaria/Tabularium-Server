import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface KnowledgeChunk { content: string; document_name: string; dataset_name: string; similarity: number }
export interface KnowledgeBase { search(question: string): Promise<KnowledgeChunk[]>; close(): Promise<void> }
export interface Dataset { id: string; name: string; description: string }

/**
 * How Tabularius searches RAGFlow: the MCP address, the datasets it may search (the MCP server in self-host mode does not
 * check callers, so this list is Tabularius's own limit) and RAGFlow's retrieval options.
 */
export interface KnowledgeSettings {
  url: string; datasets: string[];
  /** Passages returned (page_size), the minimum similarity, the weight of vector against keyword similarity, keyword
   *  search, candidates before ranking (top_k) and an optional rerank model. */
  limit: number; threshold: number; weight: number; keyword: boolean; topK: number; rerank: string;
}
export const KNOWLEDGE_DEFAULTS = { limit: 8, threshold: 0.2, weight: 0.7, keyword: false, topK: 1024, rerank: '' };

async function connect(url: string) {
  const client = new Client({ name: 'tabularius', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');

/** The datasets RAGFlow offers, for the administrator to choose from. */
export async function listDatasets(url: string): Promise<Dataset[]> {
  const client = await connect(url);
  try {
    const result = await client.callTool({ name: 'ragflow_list_datasets', arguments: { page_size: 1000 } });
    const body = text(result);
    if (result.isError) throw new Error(`RAGFlow: ${body.slice(0, 300)}`);
    // One JSON object per line, or a JSON array.
    const items = body.trim().startsWith('[') ? JSON.parse(body) as Dataset[]
      : body.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line) as Dataset);
    return items.map(item => ({ id: String(item.id), name: String(item.name ?? ''), description: String(item.description ?? '') }));
  } finally {
    await client.close();
  }
}

/**
 * RAGFlow retrieval over MCP with the given settings. The connection is opened on first use and reused; a failed call
 * reconnects once, so a RAGFlow restart costs one retry.
 */
export function ragflow(settings: KnowledgeSettings): KnowledgeBase {
  let client: Client | undefined;
  async function call(question: string) {
    client ??= await connect(settings.url);
    const result = await client.callTool({ name: 'ragflow_retrieval', arguments: {
      question, dataset_ids: settings.datasets, page_size: settings.limit, similarity_threshold: settings.threshold,
      vector_similarity_weight: settings.weight, keyword: settings.keyword, top_k: settings.topK, ...(settings.rerank ? { rerank_id: settings.rerank } : {}),
    } });
    const body = text(result);
    if (result.isError) throw new Error(`RAGFlow: ${body.slice(0, 300)}`);
    return (JSON.parse(body) as { chunks?: KnowledgeChunk[] }).chunks ?? [];
  }
  return {
    async search(question) {
      try { return await call(question); } catch {
        await client?.close().catch(() => {});
        client = undefined;
        return call(question);
      }
    },
    async close() {
      await client?.close();
      client = undefined;
    },
  };
}
