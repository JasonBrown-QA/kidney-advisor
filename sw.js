// Self-unregistering service worker.
//
// A previous SW caused "Failed to fetch" errors during cloud sync —
// the precise cause is unclear (the cross-origin guard should have
// passed GitHub API calls through unchanged), but pulling the SW
// entirely is safer than leaving sync broken.
//
// version.json polling + ?v= query strings already handle update
// propagation across desktop and iOS Safari without the SW. iOS PWA
// updates fall back to the manual cache-clearing procedure documented
// in the README.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop all caches this SW created in previous versions.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // Take control so we can unregister cleanly.
      await self.clients.claim();
      // Unregister this SW so future page loads aren't controlled at all.
      await self.registration.unregister();
    })()
  );
});

// No fetch handler — all requests go straight to the network as if no
// SW were registered.
