import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/** Server-wide web settings: one of the domain lists, and the searches allowed per answer (fetches get twice as many). */
export interface WebOptions { allowed: string[]; blocked: string[]; maxUses: number }
export interface SearchResult { url: string; title: string; content: string }

const FETCH_LIMIT = 2 * 1024 * 1024;
const TEXT_LIMIT = 40_000;
const TIMEOUT_MS = 20_000;

// Addresses a fetch must never reach: private, loopback, link-local, carrier-grade NAT, unspecified and multicast ranges.
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) blocked.addSubnet(network, prefix, 'ipv4');
// IPv4-mapped IPv6 addresses are checked as the IPv4 address they carry: a ::ffff:0:0/96 rule would match every IPv4 address.
for (const [network, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) blocked.addSubnet(network, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  return !blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/** Which addresses a fetch may connect to: public only, public plus registered intranet hosts and networks, or any. */
export type AddressPolicy = (address: string, hostname: string) => boolean;
export function addressPolicy(mode: 'read-only' | 'restricted' | 'full', intranet: string[]): AddressPolicy {
  if (mode === 'full') return () => true;
  if (mode === 'read-only') return address => isPublicAddress(address);
  const networks = new BlockList();
  const hosts = new Set<string>();
  for (const entry of intranet) {
    const [network, prefix] = entry.split('/');
    const family = isIP(network);
    if (family) networks.addSubnet(network, Number(prefix ?? (family === 6 ? 128 : 32)), family === 6 ? 'ipv6' : 'ipv4');
    else hosts.add(entry.toLowerCase());
  }
  return (address, hostname) => isPublicAddress(address) || hosts.has(hostname.toLowerCase())
    || networks.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

export function domainAllowed(options: WebOptions, url: string) {
  const host = new URL(url).hostname.toLowerCase();
  const matches = (domain: string) => { const d = domain.toLowerCase().replace(/\/.*$/, ''); return host === d || host.endsWith(`.${d}`); };
  if (options.allowed.length) return options.allowed.some(matches);
  return !options.blocked.some(matches);
}

/** SearXNG's JSON API; results outside the domain rules are dropped. */
export async function searxng(base: string, options: WebOptions, query: string): Promise<SearchResult[]> {
  const response = await fetch(`${base.replace(/\/+$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`SearXNG ${response.status}`);
  const data = await response.json() as { results?: { url: string; title?: string; content?: string }[] };
  return (data.results ?? []).filter(r => /^https?:/.test(r.url) && domainAllowed(options, r.url)).slice(0, 8)
    .map(r => ({ url: r.url, title: r.title ?? '', content: r.content ?? '' }));
}

// Every connection resolves through the policy, so a redirect or DNS answer cannot lead to an address the mode does not allow.
const checkedLookup = (policy: AddressPolicy) => (hostname: string, options: object, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    if (addresses.some(a => !policy(a.address, hostname))) return callback(new Error(`${hostname} resolves to an address this mode does not allow`), '');
    if ((options as { all?: boolean }).all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

function get(url: URL, policy: AddressPolicy) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !policy(literal, literal)) return reject(new Error(`${url.hostname} is an address this mode does not allow`));
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      lookup: checkedLookup(policy) as never, headers: { 'user-agent': 'Tabularius/1', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1' },
      timeout: TIMEOUT_MS,
    }, resolve);
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    request.end();
  });
}

/** Plain text of an HTML page: scripts, styles and tags removed, common entities decoded, whitespace collapsed. */
export function htmlText(html: string) {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(br|p|div|li|h[1-6]|tr|pre|section|article|title|ul|ol|table|blockquote|header|footer|main|nav)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => code[0] === '#'
      ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : entities[code.toLowerCase()] ?? whole)
    .replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Fetches a public web page as text, following up to five redirects, each checked against the domain rules. */
export async function fetchPage(options: WebOptions, policy: AddressPolicy, address: string) {
  let url = new URL(address);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https URLs can be fetched');
    if (!domainAllowed(options, url.href)) throw new Error(`${url.hostname} is outside the allowed domains`);
    const response = await get(url, policy);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (hop >= 5) throw new Error('too many redirects');
      url = new URL(response.headers.location, url);
      continue;
    }
    if (status >= 400) { response.resume(); throw new Error(`HTTP ${status}`); }
    const type = String(response.headers['content-type'] ?? '');
    if (!/^(text\/|application\/(json|xhtml\+xml))/i.test(type)) { response.resume(); throw new Error(`unsupported content type ${type || 'unknown'}`); }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > FETCH_LIMIT) { response.destroy(); break; }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const text = /html/i.test(type) ? htmlText(body) : body;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? '';
    return { url: url.href, title: htmlText(title), text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n\n[Truncated]` : text };
  }
}

/** URLs that appeared in user messages and tool results, normalised without fragment, for the "seen before" rule. */
export function urlsIn(text: string) {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)].map(m => m[0].replace(/[.,;:!?。，；：]+$/, '')).flatMap(raw => {
    try { const url = new URL(raw); url.hash = ''; return [url.href]; } catch { return []; }
  });
}
