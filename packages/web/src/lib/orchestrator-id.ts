/**
 * Orchestrator session ids, derived client-side.
 *
 * The engine mints these in `packages/engine/src/principal.ts`
 * (`orchestratorSessionId`) as `orchestrator:{principalType}:{principalId}`.
 * That module is the source of truth; this is a deliberate mirror of the
 * team case, because `packages/web` depends on `@valet/api` and
 * `@valet/workflow` only — `@valet/engine` is not on its dependency path.
 *
 * Deriving the id here rather than asking the server is what lets the
 * assistant rail render every team as a plain link: browsing the rail
 * creates nothing. A session row is materialized only when someone
 * actually opens the conversation, via `POST /api/teams/:id/orchestrator`.
 */

const PREFIX = "orchestrator";
const TEAM = "team";

/** The well-known session id for a team's orchestrator. */
export function teamOrchestratorSessionId(teamId: string): string {
  return `${PREFIX}:${TEAM}:${teamId}`;
}

/**
 * Inverse of `teamOrchestratorSessionId`. Returns the team id, or null for
 * anything that is not a team orchestrator — including a user's own
 * orchestrator (`orchestrator:user:…`), which callers must not treat as
 * team-owned.
 *
 * Splits on the first two separators only: a principal id may itself
 * contain a colon, matching `parseOrchestratorSessionId` in the engine.
 */
export function parseTeamOrchestratorId(sessionId: string): string | null {
  const parts = sessionId.split(":");
  if (parts.length < 3) return null;
  if (parts[0] !== PREFIX || parts[1] !== TEAM) return null;
  const teamId = parts.slice(2).join(":");
  return teamId.length > 0 ? teamId : null;
}
