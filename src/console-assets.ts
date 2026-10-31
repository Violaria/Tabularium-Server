import { readFile, readdir } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';

const types: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };

function typeOf(file: string) {
  const type = types[file.slice(file.lastIndexOf('.'))];
  if (!type) throw new Error(`Unknown asset type: ${file}`);
  return type;
}

/** The page of the share viewer (/s/<address>); the share routes serve it with their own headers. */
export const loadViewer = () => readFile(new URL('./public/share.html', import.meta.url));

export async function loadConsole() {
  const assets = new Map<string, { data: Buffer; type: string }>();
  for (const [path, file, type] of [
    // One application page for home, administration and account settings; its scripts and styles live under /app/.
    ['/app/app.html', 'app.html', 'text/html; charset=utf-8'],
    ...['app', 'core', 'home', 'admin', 'account', 'shares', 'tabularius', 'i18n', 'messages'].map(name => [`/app/${name}.js`, `${name}.js`, 'text/javascript; charset=utf-8']),
    ['/app/app.css', 'app.css', 'text/css; charset=utf-8'],
    ['/sw.js', 'sw.js', 'text/javascript; charset=utf-8'],
  ]) assets.set(path, { data: await readFile(new URL(`./public/${file}`, import.meta.url)), type });
  // Web notes files: the fixed-name entry and hashed chunks. Their list lets the service worker cache all of them.
  const notesFiles = await readdir(new URL('./public/notes/assets/', import.meta.url));
  for (const file of notesFiles) {
    assets.set(`/notes/assets/${file}`, { data: await readFile(new URL(`./public/notes/assets/${file}`, import.meta.url)), type: typeOf(file) });
  }
  assets.set('/app/offline.json', { data: Buffer.from(JSON.stringify(notesFiles.map(file => `/notes/assets/${file}`))), type: 'application/json; charset=utf-8' });
  return (path: string, method: string, res: ServerResponse) => {
    // Paths of the application itself (not its files) all return the application page; the page picks the module.
    const page = path === '/' || path === '/home' || (/^\/(admin|account|tabularius|notes)(\/|$)/.test(path) && !path.startsWith('/notes/assets/'));
    const asset = page ? assets.get('/app/app.html') : assets.get(path);
    // The application page keeps its policy however it is requested: the service worker caches it as /app/app.html.
    const application = page || path === '/app/app.html';
    if (!asset || !['GET', 'HEAD'].includes(method)) return false;
    res.writeHead(200, {
      'content-type': asset.type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      // Hashed web notes files are cached for long; the fixed-name notes entry and the service worker are revalidated.
      'cache-control': path.startsWith('/notes/assets/') && !path.includes('/notes-module.') && !path.includes('/share-viewer.') ? 'public, max-age=31536000, immutable'
        : path === '/sw.js' || path.includes('/notes-module.') || path.includes('/share-viewer.') ? 'no-cache' : 'no-store',
      // The application page runs the web notes sync core: it compiles WebAssembly, shows images from blob: URLs and uses inline styles.
      'content-security-policy': application
        ? "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        : "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(method === 'HEAD' ? undefined : asset.data);
    return true;
  };
}
