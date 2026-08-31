const CACHE = 'planner-v19';
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

// Чужие домены (Apps Script API и т.п.) не трогаем вообще — пусть идут напрямую в сеть.
// На iOS Safari перехват кросс-доменных запросов через respondWith(fetch(...)) ломает CORS
// (запрос из приложения падает, хотя тот же URL открывается напрямую в браузере без проблем).
// Кэшируем только свои же файлы того же источника (network-first, кэш — подстраховка офлайн).
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).origin !== self.location.origin) return;

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
