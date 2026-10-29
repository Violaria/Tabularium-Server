import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';

export async function loadConsole() {
  const assets = new Map<string, { data: Buffer; type: string }>();
  for (const [path, file, type] of [
    // The root page lists the web entrances; the console lives under /admin/, with /notes/ and /ai/ reserved.
    ['/', 'home.html', 'text/html; charset=utf-8'],
    ['/admin/', 'index.html', 'text/html; charset=utf-8'],
    ['/admin/admin.js', 'admin.js', 'text/javascript; charset=utf-8'],
    ['/admin/admin.css', 'admin.css', 'text/css; charset=utf-8'],
  ]) assets.set(path, { data: await readFile(new URL(`./public/${file}`, import.meta.url)), type });
  return (path: string, method: string, res: ServerResponse) => {
    if (path === '/admin' && ['GET', 'HEAD'].includes(method)) { res.writeHead(301, { location: '/admin/' }); res.end(); return true; }
    const asset = assets.get(path);
    if (!asset || !['GET', 'HEAD'].includes(method)) return false;
    res.writeHead(200, {
      'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'referrer-policy': 'no-referrer',
    });
    res.end(method === 'HEAD' ? undefined : asset.data);
    return true;
  };
}
