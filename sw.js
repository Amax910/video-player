/* Frame Player service worker.
   - App files: network first, so updates show up straight away; cached copy when offline.
   - hls.js from the CDN: cache first (the URL includes its version, so it never changes).
   - Everything else (videos, YouTube) goes straight to the network, untouched. */

const VERSION = 'frame-v2';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];
const HLS_JS = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.20/hls.min.js';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL).then(() => c.add(HLS_JS).catch(() => {})))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);

  if (url.href === HLS_JS) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Pages (including share-target and ?src= launches) all load the same index.html.
  const isPage = req.mode === 'navigate';
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && !isPage) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      if (res.ok && isPage) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./', copy)); }
      return res;
    }).catch(() => isPage
      ? caches.match('./').then(hit => hit || caches.match('./index.html'))
      : caches.match(req).then(hit => hit || Response.error()))
  );
});
