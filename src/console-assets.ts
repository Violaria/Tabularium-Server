import { readFile, readdir } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';

const types: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };

function typeOf(file: string) {
  const type = types[file.slice(file.lastIndexOf('.'))];
  if (!type) throw new Error(`Unknown asset type: ${file}`);
  return type;
}

export async function loadConsole() {
  const assets = new Map<string, { data: Buffer; type: string }>();
  for (const [path, file, type] of [
    // The root page lists the web entrances; the console lives under /admin/, with /notes/ and /tabularius/ reserved.
    ['/', 'home.html', 'text/html; charset=utf-8'],
    ['/admin/', 'index.html', 'text/html; charset=utf-8'],
    ['/admin/admin.js', 'admin.js', 'text/javascript; charset=utf-8'],
    ['/admin/admin.css', 'admin.css', 'text/css; charset=utf-8'],
    ['/notes/', 'notes/index.html', 'text/html; charset=utf-8'],
  ]) assets.set(path, { data: await readFile(new URL(`./public/${file}`, import.meta.url)), type });
  // Hashed bundle files of the web notes page, cached for long.
  for (const file of await readdir(new URL('./public/notes/assets/', import.meta.url))) {
    assets.set(`/notes/assets/${file}`, { data: await readFile(new URL(`./public/notes/assets/${file}`, import.meta.url)), type: typeOf(file) });
  }
  return (path: string, method: string, res: ServerResponse) => {
    for (const entrance of ['/admin', '/notes']) {
      if (path === entrance && ['GET', 'HEAD'].includes(method)) { res.writeHead(301, { location: `${entrance}/` }); res.end(); return true; }
    }
    const asset = assets.get(path);
    if (!asset || !['GET', 'HEAD'].includes(method)) return false;
    const notes = path.startsWith('/notes/');
    res.writeHead(200, {
      'content-type': asset.type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'cache-control': path.startsWith('/notes/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
      // The notes page runs the sync core: it compiles WebAssembly, shows images from blob: URLs and uses inline styles.
      'content-security-policy': notes
        ? "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        : "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(method === 'HEAD' ? undefined : asset.data);
    return true;
  };
}
