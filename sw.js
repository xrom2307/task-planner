const CACHE = 'planner-v8';
const FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/constants.js',
  './js/store.js',
  './js/sync.js',
  './js/planner.js',
  './js/app.js',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: пока прототип активно меняется, важнее сразу видеть свежую
// версию, чем офлайн-доступ. Кэш — только подстраховка на случай отсутствия сети.
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
