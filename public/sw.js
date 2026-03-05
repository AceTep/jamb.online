const CACHE = 'jamb-v1';
const STATIC = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Karla:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Socket.io i API pozivi — uvijek network
  if (e.request.url.includes('/socket.io') || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      // Cache samo same-origin statične resurse
      if (res.ok && e.request.url.startsWith(self.location.origin)) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});
