/**
 * Sanitizer for the `?next=` return-to parameter on `/login` and
 * `/signup` (artifacts design deviation fix). The param round-trips
 * through URLs an attacker can construct, so the login page must never
 * navigate to it unchecked — a `next` of `https://evil.example` or
 * `//evil.example` would turn the login page into an open redirect for
 * phishing ("log in to Valet" → lands somewhere else, signed in nowhere).
 *
 * Accepts only same-origin relative paths: exactly one leading `/`.
 * Browsers treat `//host` AND `/\host` as scheme-relative URLs, so both
 * are rejected. The auth pages themselves are rejected too — bouncing
 * back into `/login` after login is a loop, never an intent.
 */
export function safeNextPath(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return undefined;
  const pathOnly = raw.split(/[?#]/)[0];
  if (pathOnly === "/login" || pathOnly === "/signup") return undefined;
  return raw;
}
