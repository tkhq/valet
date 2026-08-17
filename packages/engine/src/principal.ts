import type { Principal } from "./types.js";

/**
 * Principal (de)serialization + assistant session-id helpers (Phase 4
 * decision 1). `@valet/engine` already owns `Principal`, so these live here
 * rather than the app layer; all assistant-id handling goes through them —
 * never ad-hoc prefix checks.
 *
 * Principal ids are colon-free uids by convention. `parsePrincipal` splits
 * only on the FIRST colon (rather than assuming no further colons exist) so
 * a malformed id containing one doesn't silently truncate.
 *
 * An assistant addresses its session by its OWN id, not by its owner's:
 * `assistant:{assistantId}`. A principal owns any number of assistants, so
 * the owner no longer identifies a session. See
 * `docs/specs/2026-08-13-assistants-design.md`.
 */

const PRINCIPAL_TYPES = new Set(["user", "team", "org"]);

function isPrincipalType(value: string): value is Principal["type"] {
  return PRINCIPAL_TYPES.has(value);
}

/** `${type}:${id}` */
export function serializePrincipal(p: Principal): string {
  return `${p.type}:${p.id}`;
}

/** Inverse of `serializePrincipal`. Returns null on any malformed input. */
export function parsePrincipal(s: string): Principal | null {
  const idx = s.indexOf(":");
  if (idx <= 0) return null;
  const type = s.slice(0, idx);
  const id = s.slice(idx + 1);
  if (!isPrincipalType(type) || id.length === 0) return null;
  return { type, id };
}

const ASSISTANT_PREFIX = "assistant:";

/** `assistant:{assistantId}` — the session address of an assistant, the
 * principal's default one included. One scheme for every assistant: a
 * second scheme for defaults would make every consumer branch, and the
 * branch would stay unexercised until the first non-default assistant
 * reached a path only defaults had taken. */
export function assistantSessionId(assistantId: string): string {
  return `${ASSISTANT_PREFIX}${assistantId}`;
}

/** Inverse of `assistantSessionId`. Returns null on any malformed input,
 * which is how callers recognize an ordinary session id. */
export function parseAssistantSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(ASSISTANT_PREFIX)) return null;
  const assistantId = sessionId.slice(ASSISTANT_PREFIX.length);
  return assistantId.length > 0 ? assistantId : null;
}
