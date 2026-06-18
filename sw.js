/* Quay Clock service worker — cache shell, network-first for API calls */
// Bumped on every shipping change so stale clients don't serve old JS.
const CACHE = 'quay-clock-supabase-v20';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js',
               'quay-config.js', 'quay-data.js',
               'manifest.json', 'assets/quay1-logo-white.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Always network for Apps Script API calls
  if (url.hostname.endsWith('script.google.com')) return;
  // Cache-first for everything else (the static shell)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
