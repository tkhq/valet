/**
 * Registers the service worker built by `vite-plugin.ts`. Production only:
 * the dev server never emits `/sw.js`, and a worker registered against the
 * dev origin would outlive the session and shadow later dev work.
 *
 * Registration failure is non-fatal — the app works identically without the
 * worker; only installability and repeat-visit asset caching are lost.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
