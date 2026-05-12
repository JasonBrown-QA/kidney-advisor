// Service Worker — keeps iOS Safari / PWA on the latest deployed code.
// Strategy: network-first for same-origin assets, cache fallback for offline.
// skipWaiting + clients.claim() activate new SW versions immediately.

const CACHE_NAME = 'kidney-advisor-v20260512-1015';

self.addEventListener('install', (event) => {
  // Activate this SW immediately on install — no "waiting" phase.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Drop all old caches so freshly-fetched assets aren't shadowed by stale ones.
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      ),
      // Take control of all open clients immediately.
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only intercept GETs from our own origin. GitHub API, USDA, Gemini, etc.
  // pass straight through.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first. Try the server; on failure, fall back to whatever's
  // cached. Successful responses get cached for offline use.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || Response.error()))
  );
});

// Allow the app to ask the SW to skip waiting on demand (future-proofing).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
