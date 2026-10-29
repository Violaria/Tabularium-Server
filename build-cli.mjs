// Collects the upstream CLI bundle and the packages it loads at run time into cli-dist/, for Tabularius's hosted clients.
// The packages come from the plug-in workspace's locked node_modules, so the image gets the versions the CLI was tested with.
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';

const plugin = new URL('../obsidian', import.meta.url).pathname;
const bundle = join(plugin, 'src/apps/cli/dist');
const out = new URL('./cli-dist/', import.meta.url).pathname;
await rm(out, { recursive: true, force: true });
await cp(bundle, out, { recursive: true });

const builtin = new Set(builtinModules);
const external = new Set();
for (const file of await readdir(bundle)) {
  for (const [, name] of (await readFile(join(bundle, file), 'utf8')).matchAll(/require\("([^".][^"]*)"\)/g)) {
    if (!name.startsWith('node:') && !builtin.has(name)) external.add(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]);
  }
}

/** Node's lookup: the nearest node_modules/<name> from `from` upwards, within the plug-in workspace. */
async function locate(name, from) {
  for (let dir = from; dir.startsWith(plugin); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    try { return { dir: candidate, meta: JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) }; } catch { /* look further up */ }
  }
  throw new Error(`Cannot find ${name} from ${from}`);
}
const packages = new Map();
async function include(name, from) {
  const { dir, meta } = await locate(name, from);
  if (packages.has(dir)) return;
  packages.set(dir, meta);
  for (const dependency of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
    try { await include(dependency, dir); } catch (error) { if (!(dependency in (meta.optionalDependencies ?? {}))) throw error; }
  }
}
for (const name of external) await include(name, plugin);
for (const dir of [...packages.keys()].sort()) {
  await cp(dir, join(out, relative(plugin, dir)), { recursive: true });
}
// Name, version and licence of every package, for the release licence list.
await writeFile(join(out, 'packages.json'), JSON.stringify([...packages.values()]
  .map(meta => ({ name: meta.name, version: meta.version, license: meta.license ?? meta.licenses?.map(l => l.type).join(' OR ') ?? null, repository: typeof meta.repository === 'string' ? meta.repository : meta.repository?.url ?? null }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)), null, 2) + '\n');
console.log(`CLI bundle with ${packages.size} packages in cli-dist/`);
