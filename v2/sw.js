// La app se ha mudado a la carpeta principal (../). Este service worker se borra solo
// y recarga las pestañas abiertas para que lleguen a la página que redirige.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(self.registration.unregister()
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then((cs) => Promise.all(cs.map((c) => c.navigate(c.url).catch(() => null)))));
});
