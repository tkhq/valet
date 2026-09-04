# PWA install design

**Date:** 2026-09-04
**Status:** Implemented
**Scope:** `packages/web`

## Goal

Make the v2 web client installable as a Progressive Web App (PWA). Keep
navigation and authenticated requests on the network. Do not provide an
offline application shell.

## Install surface

The production build includes a web app manifest and PNG icons. `index.html`
links the manifest and includes the Apple install metadata. The icon generator
uses the favicon geometry and writes deterministic committed output.

`src/pwa/register.ts` registers `/sw.js` after the production page loads. The
Vite development server does not emit or register a service worker.

## Asset cache

The Vite plugin collects the emitted asset names during the production build.
It selects `/assets/` paths, removes duplicates, and sorts the paths. It stamps
this exact allowlist and a build ID into the service worker. The build ID is a
hash of the sorted asset paths.

The service worker intercepts a request only when all these conditions apply:

- The method is `GET`.
- The origin matches the service worker origin.
- The request mode is not `navigate`.
- The pathname is in the stamped asset allowlist.

The worker does not intercept navigations, API requests, gateway requests,
authentication requests, WebSocket traffic, or unknown `/assets/*` paths.

An old worker can request an allowlisted chunk that a new deploy removed. The
server can return the SPA fallback with HTTP 200 for that request. Before a
cache put, the worker requires a successful, nonredirected, non-HTML response.
It returns all other network responses without caching them. This response
check prevents the SPA fallback from entering the asset cache.

The worker uses a build-scoped cache and serves allowed assets cache-first. If
a cache open or match fails, the worker logs a warning and fetches the asset
once from the network. If a cache put fails, the worker logs a warning and
returns the successful network response.

## Update lifecycle

The service worker uses the browser's standard update lifecycle. It does not
call `skipWaiting()` or `clients.claim()`.

An existing page stays under its current worker until all controlled pages
close or leave the worker scope. A reload can remain under the old worker. The
waiting worker activates after the old worker has no clients. The new worker
then deletes older Valet asset caches. This order keeps old cached chunks
available to pages that still run the old build.

The worker does not cache `index.html`. Each navigation gets the current HTML
from the network. The active worker intercepts only the asset paths stamped
into its source. It caches only responses that pass the response checks.

## Failure behavior

If the network is unavailable, a navigation fails like a normal web page. A
previously cached asset can load, but the worker does not present a cached
application shell.

If service-worker registration fails, the page continues without asset
caching. If Cache Storage fails, the worker uses the network response.

## Validation

Automated tests verify these properties:

- The manifest and install icons are valid.
- The build output contains a stamped worker and an exact asset allowlist.
- The worker ignores unknown asset paths, navigations, and all excluded request
  classes.
- The worker does not cache redirected responses or responses with an HTML
  content type.
- The worker preserves the browser update lifecycle.
- Cache read and write failures fall back to normal network behavior.
- Activation deletes only older Valet asset caches.

Run the web tests, production build, root typecheck, docs lint, and full E2E
scorecard before merge.
