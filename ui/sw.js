// Service worker of the Tabularium web application: keeps the application and web notes available without a
// network. API and synchronisation requests are never cached.
const CACHE = 'tabularium-app-v2';
const SHELL = ['/app/app.html', '/app/app.css', ...['app', 'core', 'home', 'admin', 'account', 'shares', 'tabularius', 'i18n', 'messages'].map(name => `/app/${name}.js`),
  '/notes/assets/notes-module.js', '/notes/assets/notes-module.css'];
// Paths of the application itself: answered from the network, or with the cached application page offline.
const PAGE = /^\/($|home$|notes(\/|$)|tabularius(\/|$)|admin(\/|$)|account(\/|$))/;

// Install: the application files and every web notes file the server lists (the sync core loads chunks on demand).
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const notes = await (await fetch('/app/offline.json', { cache: 'no-store' })).json();
    await cache.addAll([...new Set([...SHELL, ...notes])].map(path => new Request(path, { cache: 'no-store' })));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

async function networkFirst(request, fallback) {
  try {
    const response = await fetch(request);
    if (response.ok) await (await caches.open(CACHE)).put(fallback ?? request, response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match(fallback ?? request);
    if (cached) return cached;
    throw error;
  }
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate' && PAGE.test(url.pathname)) { event.respondWith(networkFirst(event.request, '/app/app.html')); return; }
  // Hashed web notes files never change: a cached copy is always current.
  if (url.pathname.startsWith('/notes/assets/') && !url.pathname.includes('notes-module.')) {
    event.respondWith(caches.match(event.request).then(cached => cached ?? networkFirst(event.request)));
    return;
  }
  if (SHELL.includes(url.pathname)) event.respondWith(networkFirst(event.request));
});
