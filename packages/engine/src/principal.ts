import type { Principal } from "./types.js";

/**
 * Principal (de)serialization + orchestrator session-id helpers (Phase 4
 * decision 1). `@valet/engine` already owns `Principal`, so these live here
 * rather than the app layer; all orchestrator-id handling goes through them
 * — never ad-hoc prefix checks.
 *
 * Principal ids are colon-free uids by convention. `parsePrincipal` still
 * splits only on the FIRST colon (rather than assuming no further colons
 * exist) so a malformed id containing one doesn't silently truncate.
 * `parseOrchestratorSessionId` similarly joins everything after the second
 * colon back into the id, defensively, even though real ids won't contain
 * one.
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

/** `orchestrator:{type}:{id}` — the well-known session id for a principal's orchestrator. */
export function orchestratorSessionId(p: Principal): string {
  return `orchestrator:${serializePrincipal(p)}`;
}

/** Inverse of `orchestratorSessionId`. Returns null on any malformed input. */
export function parseOrchestratorSessionId(id: string): Principal | null {
  const parts = id.split(":");
  if (parts.length < 3 || parts[0] !== "orchestrator") return null;
  const type = parts[1];
  const principalId = parts.slice(2).join(":");
  if (!isPrincipalType(type) || principalId.length === 0) return null;
  return { type, id: principalId };
}
