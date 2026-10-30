// The sandbox service: the only process with Docker access. It runs one command in a throwaway container from a listed image
// and returns the output; Tabularius reaches it over an internal network with a shared token.
import { timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingMessage } from 'node:http';

const OUTPUT_LIMIT = 20_000;
const MAX_TIMEOUT = 300;

export interface SandboxRequest { image: string; command: string; files?: Record<string, string>; network?: boolean; timeout?: number }
export interface SandboxResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }

/** One call to the Docker Engine API over its Unix socket. */
function docker(socket: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method, path, headers: body ? { 'content-type': 'application/json' } : {} }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** Splits Docker's multiplexed log stream (8-byte frame headers) into stdout and stderr. */
function demultiplex(data: Buffer) {
  const out: Buffer[] = []; const err: Buffer[] = [];
  for (let i = 0; i + 8 <= data.length;) {
    const size = data.readUInt32BE(i + 4);
    (data[i] === 2 ? err : out).push(data.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString('utf8').slice(0, OUTPUT_LIMIT), stderr: Buffer.concat(err).toString('utf8').slice(0, OUTPUT_LIMIT) };
}

export class SandboxError extends Error {}

export async function runInSandbox(socket: string, images: string[], input: SandboxRequest): Promise<SandboxResult> {
  if (!images.includes(input.image)) throw new SandboxError(`image ${input.image} is not available; available: ${images.join(', ')}`);
  if (typeof input.command !== 'string' || !input.command.trim()) throw new SandboxError('command must be a non-empty string');
  const files = Object.entries(input.files ?? {});
  for (const [name] of files) if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new SandboxError(`invalid file name ${name}`);
  const timeout = Math.min(Math.max(Number(input.timeout) || 60, 1), MAX_TIMEOUT);
  // Files travel base64-encoded in environment variables and are decoded into /work before the command runs.
  const prefix = files.map((_, i) => `printf %s "$TABULARIUS_FILE_${i}" | base64 -d > "$TABULARIUS_NAME_${i}" && `).join('');
  const created = await docker(socket, 'POST', '/containers/create', {
    Image: input.image, Labels: { 'tabularius.sandbox': '1' }, Cmd: ['sh', '-c', `${prefix}${input.command}`], User: '65534:65534', WorkingDir: '/work',
    Env: files.flatMap(([name, content], i) => [`TABULARIUS_NAME_${i}=${name}`, `TABULARIUS_FILE_${i}=${Buffer.from(content).toString('base64')}`]),
    NetworkDisabled: !input.network,
    HostConfig: {
      NetworkMode: input.network ? 'bridge' : 'none', ReadonlyRootfs: true,
      Tmpfs: { '/work': 'rw,size=64m,mode=1777', '/tmp': 'rw,size=64m,mode=1777' },
      Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 128,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
    },
  });
  if (created.status === 404) throw new SandboxError(`image ${input.image} is not pulled on this host`);
  if (created.status !== 201) throw new Error(`Docker create: ${created.status} ${created.data.toString().slice(0, 200)}`);
  const id = (JSON.parse(created.data.toString()) as { Id: string }).Id;
  try {
    const started = await docker(socket, 'POST', `/containers/${id}/start`);
    if (started.status !== 204) throw new Error(`Docker start: ${started.status} ${started.data.toString().slice(0, 200)}`);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void docker(socket, 'POST', `/containers/${id}/kill`); }, timeout * 1000);
    const waited = await docker(socket, 'POST', `/containers/${id}/wait`);
    clearTimeout(timer);
    const exitCode = timedOut ? null : (JSON.parse(waited.data.toString()) as { StatusCode: number }).StatusCode;
    const logs = await docker(socket, 'GET', `/containers/${id}/logs?stdout=1&stderr=1`);
    return { ...demultiplex(logs.data), exitCode, timedOut };
  } finally {
    await docker(socket, 'DELETE', `/containers/${id}?force=1`);
  }
}

/** Starts the service; returns the bound port. */
export function serveSandbox(options: { socket: string; images: string[]; token: string; port: number; host?: string }) {
  const expected = Buffer.from(`Bearer ${options.token}`);
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const given = Buffer.from(req.headers.authorization ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(401, { error: 'Unauthorized' });
    if (req.method !== 'POST' || req.url !== '/run') return send(404, { error: 'Route not found' });
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) return send(413, { error: 'Request too large' }); chunks.push(chunk); }
    try { send(200, await runInSandbox(options.socket, options.images, JSON.parse(Buffer.concat(chunks).toString()))); } catch (error) {
      if (error instanceof SandboxError || error instanceof SyntaxError) send(400, { error: (error as Error).message });
      else { console.error('Sandbox run failed:', (error as Error).message); send(500, { error: 'Sandbox failed' }); }
    }
  });
  return new Promise<{ port: number; close: () => Promise<void> }>(resolve => server.listen(options.port, options.host ?? '0.0.0.0', () => resolve({
    port: (server.address() as { port: number }).port, close: () => new Promise(done => server.close(() => done())),
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.TABULARIUM_SANDBOX_TOKEN;
  if (!token || token.length < 32) throw new Error('TABULARIUM_SANDBOX_TOKEN must be at least 32 characters');
  const images = (process.env.TABULARIUS_SANDBOX_IMAGES || 'python:3.13-slim,node:24-slim,alpine:3').split(',').map(image => image.trim()).filter(Boolean);
  const { port } = await serveSandbox({ socket: process.env.DOCKER_SOCKET || '/var/run/docker.sock', images, token, port: Number(process.env.SANDBOX_PORT || 3100) });
  console.log(`Tabularius sandbox listening on ${port}; images: ${images.join(', ')}`);
}
