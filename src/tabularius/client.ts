import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { decrypt } from 'octagonal-wheels/encryption/hkdf';
import type { Couch } from '../couch.js';

const exec = promisify(execFile);
// LiveSync stores encrypted metadata paths with this prefix (E2EE V2 with path obfuscation).
const ENCRYPTED_META_PREFIX = '/\\:';

/** AES-256-GCM with the server's Tabularius key: iv, tag and ciphertext in one blob. */
export function seal(key: Buffer, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}
export function open(key: Buffer, blob: Uint8Array) {
  const buffer = Buffer.from(blob);
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
}

export class WrongPassphrase extends Error {}

async function couchJson(couch: Couch, path: string) {
  const response = await couch.admin(path);
  if (response.status === 404) { await response.arrayBuffer(); return undefined; }
  if (!response.ok) throw new Error(`CouchDB ${path}: ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Checks the passphrase the way the web notes page does: decrypts the obfuscated path of one file's metadata with the
 * vault's salt. An empty vault cannot be checked and is accepted. Returns the vault's preferred chunk settings.
 */
export async function inspect(couch: Couch, database: string, passphrase: string) {
  const range = `startkey=${encodeURIComponent('"f:"')}&endkey=${encodeURIComponent('"f:\ufff0"')}`;
  const listing = await couchJson(couch, `/${database}/_all_docs?include_docs=true&limit=1&${range}`) as { rows: { doc: { path?: string } }[] };
  const path = listing.rows[0]?.doc.path;
  if (path?.startsWith(ENCRYPTED_META_PREFIX)) {
    const params = await couchJson(couch, `/${database}/_local/obsidian_livesync_sync_parameters`);
    if (!params?.pbkdf2salt) throw new WrongPassphrase();
    try { await decrypt(path.slice(ENCRYPTED_META_PREFIX.length), passphrase, new Uint8Array(Buffer.from(params.pbkdf2salt as string, 'base64'))); }
    catch { throw new WrongPassphrase(); }
  }
  const milestone = await couchJson(couch, `/${database}/_local/obsydian_livesync_milestone`) as { tweak_values?: Record<string, Record<string, unknown>> } | undefined;
  return milestone?.tweak_values?.PREFERRED ?? {};
}

export interface Hosted { vaultId: string; deviceId: string; secret: string; passphrase: string; tweaks: Record<string, unknown> }
export interface ClientState { running: boolean; replicated: boolean; restarts: number; log: string[] }

/** The upstream CLI daemons, one per vault: a plaintext working copy at `<root>/<vault>/vault`. */
export function createClients(root: string, cli: string, syncUrl: () => string) {
  const processes = new Map<string, { child?: ChildProcess; stopped: boolean; state: ClientState; timer?: NodeJS.Timeout }>();
  const dir = (vaultId: string) => join(root, vaultId);
  const working = (vaultId: string) => join(dir(vaultId), 'vault');

  async function configure(hosted: Hosted) {
    const base = dir(hosted.vaultId);
    await mkdir(join(base, 'db'), { recursive: true, mode: 0o700 });
    await mkdir(working(hosted.vaultId), { recursive: true });
    await chmod(base, 0o700);
    const settings = join(base, 'settings.json');
    await exec(process.execPath, [cli, 'init-settings', '--force', settings]);
    // The settings file holds the passphrase in plain text, readable only by the server's user.
    await writeFile(settings, JSON.stringify({
      ...JSON.parse(await readFile(settings, 'utf8')), ...hosted.tweaks,
      couchDB_URI: syncUrl(), couchDB_DBNAME: hosted.vaultId, couchDB_USER: hosted.deviceId, couchDB_PASSWORD: hosted.secret,
      isConfigured: true, encrypt: true, passphrase: hosted.passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true,
      liveSync: true, syncOnStart: false, syncOnSave: false, usePluginSync: false, deviceAndVaultName: 'Tabularius',
    }), { mode: 0o600 });
    return settings;
  }

  function launch(vaultId: string, settings: string) {
    const entry = processes.get(vaultId)!;
    const child = spawn(process.execPath, [cli, join(dir(vaultId), 'db'), '--settings', settings, '--vault', working(vaultId), 'daemon'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    entry.child = child; entry.state.running = true;
    const keep = (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      if (lines.some(line => line.includes('[Daemon] Initial replication complete'))) entry.state.replicated = true;
      entry.state.log.push(...lines);
      entry.state.log.splice(0, Math.max(0, entry.state.log.length - 40));
    };
    child.stdout!.on('data', keep); child.stderr!.on('data', keep);
    child.once('exit', code => {
      entry.state.running = false;
      if (entry.stopped) return;
      entry.state.log.push(`exited with ${code}`);
      entry.state.restarts++;
      entry.timer = setTimeout(() => { if (!entry.stopped) launch(vaultId, settings); }, 10_000);
      entry.timer.unref();
    });
  }

  return {
    working,
    state: (vaultId: string) => processes.get(vaultId)?.state,
    async start(hosted: Hosted) {
      const settings = await configure(hosted);
      processes.set(hosted.vaultId, { stopped: false, state: { running: false, replicated: false, restarts: 0, log: [] } });
      launch(hosted.vaultId, settings);
    },
    async stop(vaultId: string) {
      const entry = processes.get(vaultId);
      if (!entry) return;
      entry.stopped = true;
      clearTimeout(entry.timer);
      processes.delete(vaultId);
      if (entry.child && entry.child.exitCode === null) {
        const exited = new Promise(resolve => entry.child!.once('exit', resolve));
        entry.child.kill('SIGTERM');
        const timer = setTimeout(() => entry.child!.kill('SIGKILL'), 10_000);
        await exited;
        clearTimeout(timer);
      }
    },
    async remove(vaultId: string) { await rm(dir(vaultId), { recursive: true, force: true }); },
  };
}
