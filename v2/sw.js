// Guarda la app en el móvil para que abra al instante, incluso sin conexión.
// Al cambiar cualquier archivo de la app, sube el número de VERSION.
const VERSION = 'mi-presupuesto-v2-2';
const ARCHIVOS = ['./', 'index.html', 'config.js', 'logica.js', 'datos.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
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
  // Muestra lo guardado al momento y lo renueva por detrás
  e.respondWith(caches.open(VERSION).then((cache) => cache.match(req, { ignoreSearch: propio }).then((guardado) => {
    const red = fetch(req).then((resp) => {
      if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
      return resp;
    }).catch(() => guardado);
    return guardado || red;
  })));
});
