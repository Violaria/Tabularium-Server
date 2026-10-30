import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';

const { Client, utils } = ssh2;
type Client = InstanceType<typeof Client>;

export interface Target { address: string; port: number; username: string; privateKey: string }
export interface Result { stdout: string; stderr: string; code: number | null }

const OUTPUT_LIMIT = 20_000;
const CONNECT_TIMEOUT_MS = 15_000;

/** A key pair for one host, in OpenSSH format: the public key goes into the target account's authorized_keys. */
export function generateKey() {
  const pair = utils.generateKeyPairSync('ed25519', { comment: 'tabularius' });
  return { privateKey: pair.private, publicKey: pair.public };
}

const fingerprintOf = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/**
 * Opens a connection; with `fingerprint` the host key must match it, without one the key seen is reported (the first
 * check by an administrator). Rejects on a mismatch before any command is sent.
 */
function connect(target: Target, fingerprint: string | null) {
  return new Promise<{ client: Client; seen: string }>((resolve, reject) => {
    const client = new Client();
    let seen = '';
    client.on('ready', () => resolve({ client, seen }));
    client.on('error', error => reject(seen && fingerprint && seen !== fingerprint ? new Error(`host key ${seen} does not match the recorded ${fingerprint}`) : error));
    client.connect({
      host: target.address, port: target.port, username: target.username, privateKey: target.privateKey, readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => { seen = fingerprintOf(key); return !fingerprint || seen === fingerprint; },
    });
  });
}

export async function detectFingerprint(target: Target) {
  const { client, seen } = await connect(target, null);
  client.end();
  return seen;
}

export async function run(target: Target, fingerprint: string, command: string, timeoutMs: number): Promise<Result> {
  const { client } = await connect(target, fingerprint);
  try {
    return await new Promise<Result>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) return reject(error);
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => { stream.close(); reject(new Error(`timed out after ${timeoutMs / 1000} s`)); }, timeoutMs);
        stream.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8'); });
        stream.stderr.on('data', (chunk: Buffer) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8'); });
        stream.on('close', (code: number | null) => { clearTimeout(timer); resolve({ stdout: stdout.slice(0, OUTPUT_LIMIT), stderr: stderr.slice(0, OUTPUT_LIMIT), code }); });
      });
    });
  } finally { client.end(); }
}

// Read-only commands any mode may run, matched on the leading words. The account on the host is the real boundary;
// this list keeps the AI from changing things by mistake in the read-only and restricted modes.
const READ_ONLY = ['cat', 'head', 'tail', 'ls', 'stat', 'find', 'grep', 'wc', 'du', 'df', 'free', 'uptime', 'uname', 'hostname', 'id', 'whoami',
  'date', 'ps', 'ip addr', 'ip route', 'ss', 'systemctl status', 'systemctl is-active', 'systemctl list-units', 'systemctl cat', 'journalctl',
  'docker ps', 'docker logs', 'docker inspect', 'docker images', 'docker compose ps', 'docker compose config', 'docker compose logs', 'nginx -t',
  'git status', 'git log', 'git diff'].map(entry => entry.split(' '));
const METACHARACTERS = /[;&|`$<>(){}\n\r\\]/;
const FIND_WRITES = new Set(['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprintf', '-fls']);

/** A whitelist pattern: words matched in order; a lone `*` matches any remaining arguments, `*` inside a word any characters but spaces. */
function matches(pattern: string, words: string[]) {
  const parts = pattern.trim().split(/\s+/);
  // A wildcard never matches `..`, so `touch /tmp/*` cannot reach /tmp/../etc.
  const word = (part: string, value: string | undefined) => value !== undefined && (part.includes('*')
    ? !value.includes('..') && new RegExp(`^${part.split('*').map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^\\s]*')}$`).test(value) : part === value);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '*') return true;
    if (!word(parts[i], words[i])) return false;
  }
  return words.length === parts.length;
}

/** Why a command may not run in a mode, or undefined when it may. */
export function refuse(mode: 'read-only' | 'restricted' | 'full', command: string, whitelist: string) {
  if (!command.trim()) return 'the command is empty';
  if (mode === 'full') return undefined;
  if (METACHARACTERS.test(command)) return 'shell operators, substitutions and redirections are not allowed in this mode; run one program with its arguments';
  const words = command.trim().split(/\s+/);
  if (READ_ONLY.some(prefix => prefix.every((word, i) => words[i] === word))) {
    if (words[0] === 'find' && words.some(word => FIND_WRITES.has(word))) return 'find may not run actions in this mode';
    return undefined;
  }
  if (mode === 'restricted' && whitelist.split('\n').some(pattern => pattern.trim() && matches(pattern, words))) return undefined;
  return mode === 'read-only' ? 'only read-only commands run in read-only mode' : 'the command is not in this host\'s allow list';
}
