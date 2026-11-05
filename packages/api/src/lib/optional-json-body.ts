import type { Context } from "hono";

/**
 * Reads a request body that may be empty. An empty body is `{}`. A body that
 * is not a JSON object returns null, so the route can refuse it: a truncated
 * request must not fall through to the empty-body default and change state.
 */
export async function readOptionalJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  const raw = (await c.req.text()).trim();
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}
