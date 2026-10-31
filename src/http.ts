// Request and response helpers shared by the gateway's route modules.
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
export async function body(req: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request body too large');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'Invalid JSON'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail(400, 'Expected JSON object');
  return parsed;
}
export async function raw(req: IncomingMessage, limit: number) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function payload(req: IncomingMessage, limit: number) {
  const data = await raw(req, limit);
  try { return { data, parsed: JSON.parse(data.toString()) }; } catch { return fail(400, 'Invalid JSON'); }
}
export function field(data: Record<string, unknown>, key: string, max = 128, min = 1): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(400, `Invalid ${key}`);
  return value as string;
}
