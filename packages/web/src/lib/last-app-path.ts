/**
 * The last app page (path, search and hash) the person saw before they
 * opened Settings. The settings rail's "Back to app" link returns there.
 * It lives in memory only: after a reload straight into Settings there is
 * no earlier page, and the link goes to Home.
 */
let last = "/";

/** True for `/settings` and every page under it. */
export function isSettingsPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === "/settings" || path.startsWith("/settings/");
}

/** Remember `href` unless it is a Settings page. */
export function rememberAppPath(pathname: string, href: string): void {
  if (!isSettingsPath(pathname)) last = href;
}

export function lastAppPath(): string {
  return last;
}
