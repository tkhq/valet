/**
 * Linear provider-state status mapping for `from_status` resolution (spec:
 * docs/specs/2026-10-15-event-wakeups-design.md, Part A4/Part E). Resolves
 * a workflow state id to its normalized status type (`triage`, `backlog`,
 * `unstarted`, `started`, `completed`, `canceled`), caching the team's
 * state list for one hour, keyed by org.
 */
import type { DeriveContext, StatusResolver } from "@valet/engine";

const CACHE_TTL_MS = 60 * 60 * 1000;
/**
 * The GraphQL endpoint. `LINEAR_API_URL` overrides the host, as the arm
 * checks and the Linear service read it, so a fixture serves both.
 */
export function linearGraphqlUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.LINEAR_API_URL || "https://api.linear.app"}/graphql`;
}

const WORKFLOW_STATES_QUERY = `
  query ValetWorkflowStates($teamKey: String!) {
    workflowStates(filter: { team: { key: { eq: $teamKey } } }) {
      nodes { id type }
    }
  }
`;

interface CacheEntry {
  expiresAt: number;
  statusByStateId: Map<string, string>;
}

/** Module-level — one process serves one deployment, so a plain Map is the
 * cache; it is never written outside `resolve` below. */
const cache = new Map<string, CacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Null means the fetch itself failed (no token, network error, bad
 * response) — the caller must not cache a failure as "this team has no
 * states", or a transient outage would wedge every lookup for an hour. */
async function fetchStatusByStateId(ctx: DeriveContext, teamKey: string): Promise<Map<string, string> | null> {
  const token = await ctx.appToken();
  if (!token) return null;

  let res: Response;
  try {
    res = await ctx.fetch(linearGraphqlUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: WORKFLOW_STATES_QUERY, variables: { teamKey } }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return null;
  }
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  const workflowStates = payload.data.workflowStates;
  if (!isRecord(workflowStates) || !Array.isArray(workflowStates.nodes)) return null;

  const statusByStateId = new Map<string, string>();
  for (const node of workflowStates.nodes) {
    if (!isRecord(node)) continue;
    const id = typeof node.id === "string" ? node.id : undefined;
    const type = typeof node.type === "string" ? node.type : undefined;
    if (id && type) statusByStateId.set(id, type);
  }
  return statusByStateId;
}

export const linearStatusResolver: StatusResolver = {
  async resolve(ctx, ref) {
    if (!ref.teamKey) return null;
    const cacheKey = `${ctx.orgId}:${ref.teamKey}`;
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.statusByStateId.get(ref.stateId) ?? null;
    }
    const statusByStateId = await fetchStatusByStateId(ctx, ref.teamKey);
    if (!statusByStateId) return null;
    cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, statusByStateId });
    return statusByStateId.get(ref.stateId) ?? null;
  },
};
