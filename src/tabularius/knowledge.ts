import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface KnowledgeChunk { content: string; document_name: string; dataset_name: string; similarity: number }
export interface KnowledgeBase { search(question: string): Promise<KnowledgeChunk[]>; close(): Promise<void> }

/**
 * RAGFlow retrieval over MCP, limited to the configured datasets. The connection is opened on first use and reused;
 * a failed call reconnects once, so a RAGFlow restart costs one retry.
 */
export function ragflow(url: string, datasets: string[], limit = 8): KnowledgeBase {
  let client: Client | undefined;
  async function connect() {
    const next = new Client({ name: 'tabularius', version: '1' });
    await next.connect(new StreamableHTTPClientTransport(new URL(url)));
    return next;
  }
  async function call(question: string) {
    client ??= await connect();
    const result = await client.callTool({ name: 'ragflow_retrieval', arguments: { question, dataset_ids: datasets, page_size: limit } });
    const text = (result.content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
    if (result.isError) throw new Error(`RAGFlow: ${text.slice(0, 300)}`);
    return (JSON.parse(text) as { chunks?: KnowledgeChunk[] }).chunks ?? [];
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
