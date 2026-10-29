import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createGateway } from './server.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const database = resolve(process.env.TABULARIUM_DATABASE ?? 'data/tabularium.sqlite');
await mkdir(dirname(database), { recursive: true });
const gateway = await createGateway({
  database,
  publicUrl: process.env.TABULARIUM_PUBLIC_URL,
  bootstrapUser: process.env.TABULARIUM_ADMIN_USER,
  bootstrapPassword: process.env.TABULARIUM_ADMIN_PASSWORD,
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
