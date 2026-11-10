const CACHE = 'ledger-shell-v4';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
  './loopy/avatar.webp',
  './loopy/hero.webp',
  './loopy/02-eat.webp',
  './loopy/03-car.webp',
  './loopy/04-bag.webp',
  './loopy/05-home.webp',
  './loopy/06-music.webp',
  './loopy/07-flower.webp',
  './loopy/08-study.webp',
  './loopy/09-gift.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        fetch(request).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(request, res)).catch(() => {});
        }).catch(() => {});
        return hit;
      }
      return fetch(request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => Response.error());
    })
  );
});
