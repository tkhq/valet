/**
 * The production gate for the UI stress gallery (`/dev/ui-stress`).
 *
 * The lazy imports below sit behind `import.meta.env.DEV`. Vite writes a
 * literal `false` there in a production build, so the build drops both
 * imports, and the gallery, its fixtures, and the frozen client never reach
 * `dist/`. Keep every import of `./gallery`, `./shell`, and `./fixtures`
 * behind this file.
 */
import { lazy } from "react";
import { notFound, rootRouteId } from "@tanstack/react-router";

export const UI_STRESS_PATH = "/dev/ui-stress";

/** True in a Vite dev server only. */
export function uiStressEnabled(): boolean {
  return import.meta.env.DEV;
}

/** The route's `beforeLoad`: a production build answers the app's 404.
 * It names the root route: a bare `notFound()` thrown from `beforeLoad` on
 * the first load left the router pending with nothing on screen. */
export function requireUiStress(): void {
  if (!uiStressEnabled()) throw notFound({ routeId: rootRouteId });
}

/** The gallery page. Null in a production build. */
export const UiStressGallery = import.meta.env.DEV ? lazy(() => import("./gallery")) : null;

/** Puts the app shell on the gallery's frozen query client, so the top nav,
 * the notification bell, and the thread sidebar show the fixtures too. Null
 * in a production build. */
export const UiStressShell = import.meta.env.DEV ? lazy(() => import("./shell")) : null;
