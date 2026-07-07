import { resolveTeamOrchestratorAlias } from '@valet/shared';
import { useOrchestratorInfo } from '@/api/orchestrator';

const ORCHESTRATOR_ALIAS = 'orchestrator';

/**
 * Resolves the "orchestrator" route alias to the concrete session ID.
 *
 * When the route param is literally "orchestrator", this hook reads the
 * current orchestrator session ID from the cached orchestrator info query
 * (already fetched by the sidebar on every page).  Once resolved, all
 * queries and mutations key off the concrete ID so the React Query cache
 * stays unified across alias navigation and direct-ID navigation.
 *
 * For non-alias session IDs, returns the ID unchanged.
 *
 * Returns `null` while the orchestrator info is still loading so callers
 * can show a loading state instead of rendering with a stale alias key.
 */
export function useResolvedSessionId(sessionId: string): string | null {
  const isAlias = sessionId === ORCHESTRATOR_ALIAS;
  const { data: orchInfo } = useOrchestratorInfo();

  // Team orchestrator alias resolves by pure transform — the canonical ID is
  // stable, so no query is needed (keeps colons out of URLs).
  const teamResolved = resolveTeamOrchestratorAlias(sessionId);
  if (teamResolved) return teamResolved;

  if (!isAlias) return sessionId;
  return orchInfo?.sessionId ?? null;
}
