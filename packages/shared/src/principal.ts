/**
 * A principal is anything that can own resources: a user, a team, or (future) an org.
 * Canonical string form: `${type}:${id}`, e.g. "user:abc", "team:xyz".
 */
export type PrincipalType = 'user' | 'team' | 'org';

export interface Principal {
  type: PrincipalType;
  id: string;
}

const PRINCIPAL_TYPES: readonly PrincipalType[] = ['user', 'team', 'org'];

export function formatPrincipal(p: Principal): string {
  return `${p.type}:${p.id}`;
}

export function parsePrincipal(s: string): Principal {
  const idx = s.indexOf(':');
  const type = idx === -1 ? '' : s.slice(0, idx);
  const id = idx === -1 ? '' : s.slice(idx + 1);
  if (!(PRINCIPAL_TYPES as readonly string[]).includes(type) || id.length === 0) {
    throw new Error(`Invalid principal: ${s}`);
  }
  return { type: type as PrincipalType, id };
}

export function userPrincipal(userId: string): Principal {
  return { type: 'user', id: userId };
}

// ─── Orchestrator session IDs ────────────────────────────────────────────────
// Canonical form: `orchestrator:${type}:${id}`, e.g. "orchestrator:user:abc".

const ORCHESTRATOR_PREFIX = 'orchestrator:';

export function orchestratorSessionId(owner: Principal): string {
  return `${ORCHESTRATOR_PREFIX}${formatPrincipal(owner)}`;
}

/** Prefix check only — matches legacy pre-migration IDs too, on purpose. */
export function isOrchestratorSessionId(sessionId: string | null | undefined): boolean {
  return sessionId?.startsWith(ORCHESTRATOR_PREFIX) ?? false;
}

/** Returns the owning principal of a canonical orchestrator session ID, or null. */
export function parseOrchestratorSessionId(sessionId: string): Principal | null {
  if (!sessionId.startsWith(ORCHESTRATOR_PREFIX)) return null;
  try {
    return parsePrincipal(sessionId.slice(ORCHESTRATOR_PREFIX.length));
  } catch {
    return null;
  }
}

// ─── Colon-free session aliases ──────────────────────────────────────────────
// URLs avoid raw colon-containing session IDs. The personal orchestrator uses
// the literal alias 'orchestrator' (resolved per-user); team orchestrators use
// 'team-orchestrator-{teamId}', which resolves by pure string transform since
// the canonical ID is stable.

export const TEAM_ORCHESTRATOR_ALIAS_PREFIX = 'team-orchestrator-';

export function teamOrchestratorAlias(teamId: string): string {
  return `${TEAM_ORCHESTRATOR_ALIAS_PREFIX}${teamId}`;
}

/** Resolve a 'team-orchestrator-{teamId}' alias to its canonical session ID, or null. */
export function resolveTeamOrchestratorAlias(requestedId: string): string | null {
  if (!requestedId.startsWith(TEAM_ORCHESTRATOR_ALIAS_PREFIX)) return null;
  const teamId = requestedId.slice(TEAM_ORCHESTRATOR_ALIAS_PREFIX.length);
  return teamId ? orchestratorSessionId({ type: 'team', id: teamId }) : null;
}
