/**
 * Internal-token dual auth (decision 15). `mem_*` ToolDefs (Task 6) call
 * the memory HTTP routes with `x-valet-internal: {token}` plus explicit
 * `x-valet-owner`/`x-valet-actor` headers instead of a session cookie —
 * the route trusts the owner tuple after a constant-time token compare.
 * Browser/user requests to the same routes go through the normal session
 * auth middleware and never carry this header.
 *
 * The token comes from `VALET_INTERNAL_TOKEN`; if unset, a random token is
 * generated once at module load and held only in process memory (every
 * internal caller in this process — the host's `toolConfig.internalToken`
 * included — must read it from `internalToken()`, not re-derive it).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

const GENERATED_FALLBACK_TOKEN = randomBytes(32).toString("hex");

/** The active internal token for this process. */
export function internalToken(): string {
  return process.env.VALET_INTERNAL_TOKEN ?? GENERATED_FALLBACK_TOKEN;
}

/** Constant-time comparison against the active internal token. `false` for
 * any missing/empty/length-mismatched candidate (never throws). */
export function isValidInternalToken(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const expected = internalToken();
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
