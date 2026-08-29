/**
 * Filter-option resolvers for the Linear plugin.
 *
 * The event-filter editor calls these to fill a filter field from a
 * provider-populated list, not free text. `linear.teams` lists the Linear
 * teams the org credential can see.
 *
 * The `team` filter matches on the team KEY (path `data.team.key` in the
 * trigger catalog, e.g. "TKAI"), so an option's `id` is the team key — the
 * value the filter compares against — NOT the team uuid. `label` is the
 * human-readable team name.
 *
 * A missing or unusable credential is a normal outcome: the resolver returns
 * an empty list, and the picker falls back to free text. The resolver never
 * throws — a network or GraphQL error also yields [].
 */
import type { FilterOption, FilterOptionResolver } from "@valet/engine";

/** API host — GraphQL endpoint. Tests point `LINEAR_API_URL` at a fixture. */
function resolveLinearApiUrl(env: NodeJS.ProcessEnv): string {
  return env.LINEAR_API_URL || "https://api.linear.app";
}

/** Injected fetch mirrors the global `fetch` signature so tests can stub it. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface LinearTeam {
  key: string;
  name: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Read the `teams.nodes` array from a Linear GraphQL response, tolerating drift. */
function parseTeams(data: unknown): LinearTeam[] {
  if (!isRecord(data)) return [];
  const teams = data.teams;
  if (!isRecord(teams)) return [];
  const nodes = teams.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: LinearTeam[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const key = node.key;
    const name = node.name;
    if (typeof key !== "string" || typeof name !== "string") continue;
    out.push({ key, name });
  }
  return out;
}

const TEAMS_QUERY = "{ teams(first: 250) { nodes { key name } } }";

/**
 * Build the `linear.teams` resolver. `fetchImpl` and `env` are injectable for
 * tests; production uses the global `fetch` and `process.env`.
 */
export function makeLinearTeamsResolver(
  fetchImpl: FetchLike = fetch,
  env: NodeJS.ProcessEnv = process.env,
): FilterOptionResolver {
  return async (ctx): Promise<FilterOption[]> => {
    const accessToken = ctx.credential?.accessToken;
    if (!accessToken) return [];

    let res: Response;
    try {
      res = await fetchImpl(`${resolveLinearApiUrl(env)}/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: TEAMS_QUERY }),
      });
    } catch {
      return [];
    }
    if (!res.ok) return [];

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return [];
    }
    if (!isRecord(payload)) return [];
    const teams = parseTeams(payload.data);

    // The `q` typeahead matches team key OR name, case-insensitive.
    const q = ctx.q?.trim().toLowerCase();
    const filtered = q
      ? teams.filter((t) => t.key.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
      : teams;

    // id = team KEY (the value `data.team.key` compares against), not the uuid.
    return filtered.map((t) => ({ id: t.key, label: t.name, hint: t.key }));
  };
}

/** Resolver name registered on the plugin manifest and named by the catalog. */
export const LINEAR_TEAMS_SOURCE = "linear.teams";
