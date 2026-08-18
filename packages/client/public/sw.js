// TODO: Integrate ACP (Agent Client Protocol) to enable connecting Valet to local
// coding agents and vice versa. This PWA is the foundation for a native-feeling
// desktop experience that can bridge cloud-hosted agent sessions with local dev tools.

// Minimal service worker for PWA installability.
// This does NOT provide offline support or caching — it simply satisfies
// Chrome's PWA install criteria (a registered fetch listener).

self.addEventListener('install', (event) => {
  // Activate immediately — no waiting for existing clients to close
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim all open clients so the SW is controlling pages right away
  event.waitUntil(self.clients.claim());
});

// Register a fetch listener but do NOT call event.respondWith — the browser
// handles the request natively, including its own offline error UI. Calling
// respondWith(fetch(...)) here would surface a generic unhandled rejection
// when the network fails instead of the browser's native offline error.
// Chrome's PWA install criteria are satisfied by the presence of this listener.
self.addEventListener('fetch', () => {
  // Intentionally empty — see comment above.
});
