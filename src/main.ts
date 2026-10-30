import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createGateway } from './server.js';
import type { SmtpConfig } from './smtp.js';
import { ragflow } from './tabularius/knowledge.js';
import { anthropic, embedder, openai, vllm } from './tabularius/providers.js';
import { MODES, type Mode } from './tabularius/index.js';
import { checkParams } from './tabularius/params.js';
import type { TabulariusConfig } from './tabularius/index.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
// Compose passes unset variables as empty strings, so empty means default throughout.
const security = (process.env.TABULARIUM_SMTP_SECURITY || 'tls') as SmtpConfig['security'];
if (!['tls', 'starttls', 'none'].includes(security)) throw new Error('TABULARIUM_SMTP_SECURITY must be tls, starttls or none');
const smtp: SmtpConfig | undefined = process.env.TABULARIUM_SMTP_HOST ? {
  host: process.env.TABULARIUM_SMTP_HOST, security,
  port: Number(process.env.TABULARIUM_SMTP_PORT || { tls: 465, starttls: 587, none: 25 }[security]),
  user: process.env.TABULARIUM_SMTP_USER || undefined, password: process.env.TABULARIUM_SMTP_PASSWORD || undefined,
  from: required('TABULARIUM_SMTP_FROM'),
} : undefined;
const database = resolve(process.env.TABULARIUM_DATABASE ?? 'data/tabularium.sqlite');
await mkdir(dirname(database), { recursive: true });
// Tabularius, the AI curator, is enabled by choosing a provider; its data lives next to the application database.
const provider = process.env.TABULARIUS_PROVIDER;
if (provider && !['anthropic', 'openai', 'vllm'].includes(provider)) throw new Error('TABULARIUS_PROVIDER must be anthropic, openai or vllm');
const list = (name: string) => (process.env[name] ?? '').split(',').map(item => item.trim()).filter(Boolean);
let tabularius: TabulariusConfig | undefined;
if (provider) {
  const key = Buffer.from(required('TABULARIUS_SECRET_KEY'), 'base64');
  if (key.length !== 32) throw new Error('TABULARIUS_SECRET_KEY must be 32 bytes in base64 (openssl rand -base64 32)');
  tabularius = {
    key, root: resolve(dirname(database), 'tabularius'),
    cli: resolve(process.env.TABULARIUS_CLI || new URL('../cli/index.cjs', import.meta.url).pathname),
    provider: provider === 'anthropic' ? anthropic(process.env.TABULARIUS_MODEL || 'claude-opus-5-5')
      : provider === 'openai' ? openai(required('TABULARIUS_MODEL'))
        : vllm(required('TABULARIUS_MODEL'), required('TABULARIUS_VLLM_URL'), process.env.TABULARIUS_VLLM_KEY || undefined),
    embedder: process.env.TABULARIUS_EMBEDDING_MODEL
      ? embedder(process.env.TABULARIUS_EMBEDDING_MODEL, process.env.TABULARIUS_EMBEDDING_URL || undefined, process.env.TABULARIUS_EMBEDDING_KEY || undefined,
        Number(process.env.TABULARIUS_EMBEDDING_BATCH || 64)) : undefined,
    knowledge: process.env.TABULARIUS_RAGFLOW_MCP_URL
      ? ragflow(process.env.TABULARIUS_RAGFLOW_MCP_URL, list('TABULARIUS_RAGFLOW_DATASETS')) : undefined,
    web: process.env.TABULARIUS_WEB === 'on' ? {
      options: { allowed: list('TABULARIUS_WEB_ALLOWED_DOMAINS'), blocked: list('TABULARIUS_WEB_BLOCKED_DOMAINS'), maxUses: Number(process.env.TABULARIUS_WEB_MAX_USES || 5) },
      searxng: process.env.TABULARIUS_SEARXNG_URL || undefined, intranet: list('TABULARIUS_INTRANET'),
    } : undefined,
    modeLimit: (process.env.TABULARIUS_MODE_LIMIT || 'read-only') as Mode,
    params: checkParams(provider as 'anthropic' | 'openai' | 'vllm', process.env.TABULARIUS_MODEL_PARAMS ?? ''),
  };
  if (!MODES.includes(tabularius.modeLimit)) throw new Error('TABULARIUS_MODE_LIMIT must be read-only, restricted or full');
  const web = tabularius.web;
  if (web?.options.allowed.length && web.options.blocked.length) throw new Error('Set TABULARIUS_WEB_ALLOWED_DOMAINS or TABULARIUS_WEB_BLOCKED_DOMAINS, not both');
  if (web && provider === 'openai' && web.options.blocked.length) throw new Error("OpenAI's web search supports only TABULARIUS_WEB_ALLOWED_DOMAINS");
  if (web && provider === 'vllm' && !web.searxng) throw new Error('TABULARIUS_WEB with vllm needs TABULARIUS_SEARXNG_URL');
}
const gateway = await createGateway({
  database,
  publicUrl: process.env.TABULARIUM_PUBLIC_URL,
  bootstrapUser: process.env.TABULARIUM_ADMIN_USER,
  bootstrapPassword: process.env.TABULARIUM_ADMIN_PASSWORD,
  auditDays: process.env.TABULARIUM_AUDIT_DAYS ? Number(process.env.TABULARIUM_AUDIT_DAYS) : undefined,
  smtp,
  tabularius,
  kindleDomains: process.env.TABULARIUM_KINDLE_DOMAINS ? process.env.TABULARIUM_KINDLE_DOMAINS.split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean) : undefined,
  kindleDaily: process.env.TABULARIUM_KINDLE_DAILY ? Number(process.env.TABULARIUM_KINDLE_DAILY) : undefined,
  origins: (process.env.TABULARIUM_ORIGINS ?? 'app://obsidian.md,capacitor://localhost,http://localhost').split(','),
  couch: {
    url: required('COUCHDB_URL').replace(/\/$/, ''),
    adminUser: required('COUCHDB_ADMIN_USER'), adminPassword: required('COUCHDB_ADMIN_PASSWORD'),
    syncUser: required('COUCHDB_SYNC_USER'), syncPassword: required('COUCHDB_SYNC_PASSWORD'),
  },
});
const url = await gateway.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
console.log(`Tabularium listening on ${url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void gateway.close(); });
