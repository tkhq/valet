/**
 * The 1Password failure response every route shares, and the mapping from a
 * service rejection to it. A typed `OnePasswordAuthError` carries a message
 * written for the client; anything else is an SDK or network failure whose
 * text must not reach the client.
 */
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { OnePasswordAuthError } from "../services/onepassword.js";

export const ONEPASSWORD_REQUEST_FAILED = { error: "1Password request failed" } as const;

export function mapOnePasswordError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof OnePasswordAuthError) return c.json({ error: err.message }, 400);
  console.error("onepassword: request failed");
  return c.json(ONEPASSWORD_REQUEST_FAILED, 502);
}
