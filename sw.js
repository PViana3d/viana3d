// Service worker: guarda a aplicação no aparelho para abrir depressa e sem internet.
// Os dados vêm sempre do servidor (/api/), nunca da cache.
const VERSION = '__BUILD__';
const CACHE = 'g3d-app-' + VERSION;
const FONTS = 'g3d-fonts';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'styles.css?v=' + VERSION, 'app.js?v=' + VERSION, 'config.js?v=' + VERSION,
  'vendor/pocketbase.umd.js?v=' + VERSION, 'vendor/jszip.min.js?v=' + VERSION, 'vendor/jspdf.umd.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('g3d-app-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // tipos de letra: guardar depois do primeiro uso
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_/')) return; // dados e painel do servidor: sempre pela rede
  // página: rede primeiro (para receber atualizações), cache se estiver sem internet
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
