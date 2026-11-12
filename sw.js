// Guarda la app en el móvil para que abra sin conexión, pero con conexión siempre carga la última versión.
// Al cambiar cualquier archivo de la app, sube el número de VERSION.
const VERSION = 'mi-presupuesto-v2-10';
const ARCHIVOS = ['./', 'index.html', 'config.js', 'logica.js', 'datos.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'privacidad.html', 'aviso-legal.html'];

self.addEventListener('install', (e) => {
  // cache: 'reload' = pedirlos al servidor, no a la caché del navegador (si no, se guardaba la versión vieja)
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(ARCHIVOS.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Los datos (Supabase) siempre van a la red
  if (url.hostname.endsWith('.supabase.co')) return;
  const propio = url.origin === self.location.origin;
  const externo = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cdnjs.cloudflare.com';
  if (!propio && !externo) return;
  if (propio) {
    // Archivos de la app: primero la red (siempre la versión nueva); sin conexión, lo guardado
    e.respondWith(fetch(req, { cache: 'no-cache' }).then((resp) => {
      if (resp && resp.ok) { const copia = resp.clone(); caches.open(VERSION).then((c) => c.put(req, copia)); }
      return resp;
    }).catch(() => caches.open(VERSION).then((c) => c.match(req, { ignoreSearch: true })
      .then((g) => g || (req.mode === 'navigate' ? c.match('index.html') : undefined)))));
    return;
  }
  // Fuentes y librerías (no cambian): lo guardado al momento
  e.respondWith(caches.open(VERSION).then((cache) => cache.match(req).then((guardado) => guardado || fetch(req).then((resp) => {
    if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
    return resp;
  }))));
});
