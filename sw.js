// Кеш оболонки гри: сторінка відкривається миттєво, навіть коли безкоштовний сервер ще спить.
// Стратегія «спершу кеш, оновлення у фоні»: якщо на сервері з’явилась нова версія, гра запропонує оновитись.
const CACHE = 'mb-shell-v1';
const SHELL = ['/', '/icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const notify = () => self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage({ t: 'update' })));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // Мережеві виклики гри (API, перевірка сервера) та сам sw.js завжди йдуть напряму
  if (req.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/sw.js') return;

  const key = req.mode === 'navigate' || url.pathname === '/index.html' ? '/' : url.pathname;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    const refresh = fetch(req).then(async res => {
      if (!res.ok) return res;
      if ((res.headers.get('content-type') || '').includes('text/html')) {
        const fresh = await res.clone().text(), old = cached ? await cached.clone().text() : null;
        await cache.put(key, res.clone());
        if (old !== null && old !== fresh) notify();          // на сервері нова версія
      } else await cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(refresh); return cached; }       // миттєво з кешу, оновлюємо у фоні
    return (await refresh) || new Response('Немає зв’язку із сервером', { status: 503 });
  })());
});
