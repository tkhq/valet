/**
 * Valet service worker. Template — the Vite plugin (`vite-plugin.ts`)
 * stamps the emitted asset paths and their build hash into this file. It
 * emits the result as `/sw.js` in the production bundle. The worker is not
 * part of the app bundle graph.
 *
 * Caching policy (deliberate, security-sensitive — see the test in
 * `sw.test.ts` before changing it):
 *
 * - The ONLY requests this worker touches are same-origin GETs for emitted
 *   asset paths. Vite's content-hashed, immutable bundle files are served
 *   cache-first from a build-scoped cache.
 * - A network response enters the cache only when it is successful,
 *   nonredirected, and not HTML. The worker returns all other responses
 *   without caching them.
 * - Everything else — navigations (`index.html`), `/api/*`, `/proxy/*`,
 *   `/mcp/*`, auth, WebSocket upgrades, cross-origin requests — is never
 *   intercepted: no `respondWith`, so the browser talks to the network as
 *   if no worker existed. No user data or API response ever enters the
 *   cache.
 * - Updates: navigations always fetch `index.html` from the network, so a
 *   new deploy is picked up on the next load. The new worker uses the standard
 *   browser lifecycle and deletes caches from previous builds after activation.
 *
 * There is NO offline support: with the network down, navigation fails like
 * a plain web page. That is intentional — Valet is a real-time authenticated
 * app and a cached shell without live data would be misleading.
 */

const BUILD_ID = "__BUILD_ID__";
const CACHE_PREFIX = "valet-assets-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const ASSET_PATHS = new Set(__ASSET_PATHS__);

/** True only for same-origin GETs of immutable, content-hashed bundle files. */
function isImmutableAssetRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (request.mode === "navigate") return false;
  return ASSET_PATHS.has(url.pathname);
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (!isImmutableAssetRequest(event.request)) return;
  event.respondWith(
    (async () => {
      let cache;
      try {
        cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        if (cached) return cached;
      } catch (error) {
        console.warn(
          "PWA cache read failed. Loading the asset from the network.",
          error,
        );
      }
      const response = await fetch(event.request);
      const responseType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (
        response.ok &&
        !response.redirected &&
        responseType !== "text/html" &&
        cache
      ) {
        try {
          await cache.put(event.request, response.clone());
        } catch (error) {
          console.warn(
            "PWA cache write failed. Using the network response.",
            error,
          );
        }
      }
      return response;
    })(),
  );
});
