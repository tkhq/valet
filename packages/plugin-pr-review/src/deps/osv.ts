/**
 * Advisory lookup in OSV (https://osv.dev): one batch query for every
 * package version, then one read per advisory for its text, severity and
 * fixed versions. Advisories that are aliases of each other (a GHSA and a
 * GO- id for one flaw) count once.
 */
import { compareVersions } from "./diff.js";
import type { Ecosystem } from "./parse.js";

export const OSV_API = "https://api.osv.dev/v1";

export interface OsvQuery {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

export interface Advisory {
  id: string;
  aliases: string[];
  summary: string;
  /** The first part of the advisory text. */
  details: string;
  severity: "critical" | "high" | "medium" | "low";
  /** The lowest version that fixes it for the queried package, when OSV names one. */
  fixed?: string;
  /** Affected functions or symbols, when the advisory lists them (Go advisories do). */
  symbols: string[];
  url: string;
  /** Past the per-run read limit: only the id is known. */
  unread?: true;
}

/** OSV accepts at most 1000 queries per batch. */
const BATCH = 1000;
/** Advisories read in detail per run. The rest are named by id only. */
export const MAX_ADVISORY_READS = 60;
const DETAILS_CHARS = 1200;

/**
 * The advisories for each query, in query order. Throws when OSV fails:
 * advisories are the main check, so the delivery fails and the host retries
 * it rather than posting a review that silently checked nothing.
 */
export async function lookupAdvisories(queries: OsvQuery[], opts: { fetch?: typeof fetch; signal?: AbortSignal; api?: string } = {}): Promise<Advisory[][]> {
  const doFetch = opts.fetch ?? fetch;
  const api = opts.api ?? OSV_API;
  const ids: string[][] = [];
  for (let i = 0; i < queries.length; i += BATCH) {
    const chunk = queries.slice(i, i + BATCH);
    const res = await doFetch(`${api}/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "valet-dependency-review" },
      body: JSON.stringify({ queries: chunk.map((q) => ({ package: { ecosystem: q.ecosystem, name: q.name }, version: q.ecosystem === "Go" ? q.version.replace(/^v/, "") : q.version })) }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) throw new Error(`OSV advisory lookup failed (${res.status}). Retry the delivery when api.osv.dev answers.`);
    const body = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
    for (let j = 0; j < chunk.length; j++) ids.push((body.results?.[j]?.vulns ?? []).map((v) => v.id));
  }
  const unique = [...new Set(ids.flat())];
  const details = new Map<string, OsvVuln | undefined>();
  await Promise.all(
    unique.slice(0, MAX_ADVISORY_READS).map(async (id) => {
      const res = await doFetch(`${api}/vulns/${encodeURIComponent(id)}`, { headers: { "user-agent": "valet-dependency-review" }, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (!res.ok) throw new Error(`OSV advisory read of ${id} failed (${res.status}). Retry the delivery when api.osv.dev answers.`);
      details.set(id, (await res.json()) as OsvVuln);
    }),
  );
  return queries.map((q, i) => {
    const seen = new Map<string, Advisory>();
    const out: Advisory[] = [];
    for (const id of ids[i]) {
      const v = details.get(id);
      const kept = seen.get(id);
      if (kept) {
        // An alias record (a GO- record for a GHSA) can list the affected functions the kept one lacks.
        if (v) kept.symbols = [...new Set([...kept.symbols, ...toAdvisory(v, q).symbols])].slice(0, 40);
        continue;
      }
      const advisory = v ? toAdvisory(v, q) : { id, aliases: [], summary: `Advisory ${id}`, details: "", severity: "medium" as const, symbols: [], url: `https://osv.dev/vulnerability/${id}`, unread: true as const };
      for (const a of [advisory.id, ...advisory.aliases]) seen.set(a, advisory);
      out.push(advisory);
    }
    return out;
  });
}

/** The parts of an OSV record the handler reads. */
export interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { ecosystem?: string; name?: string };
    ranges?: { type?: string; events?: Record<string, string>[] }[];
    ecosystem_specific?: { imports?: { path?: string; symbols?: string[] }[]; affected_functions?: string[] };
    database_specific?: { severity?: string };
  }[];
}

export function toAdvisory(v: OsvVuln, q: OsvQuery): Advisory {
  const mine = (v.affected ?? []).filter((a) => a.package?.name === q.name && a.package?.ecosystem === q.ecosystem);
  const fixed = mine.flatMap((a) => (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed).filter((f): f is string => typeof f === "string")));
  const symbols = mine.flatMap((a) => [...(a.ecosystem_specific?.imports ?? []).flatMap((i) => i.symbols ?? []), ...(a.ecosystem_specific?.affected_functions ?? [])]);
  const label = v.database_specific?.severity ?? mine.map((a) => a.database_specific?.severity).find((s) => s !== undefined);
  return {
    id: v.id,
    aliases: v.aliases ?? [],
    summary: (v.summary ?? v.details ?? v.id).split("\n")[0].slice(0, 200),
    details: (v.details ?? "").slice(0, DETAILS_CHARS),
    severity: severityOf(label, v.severity),
    ...(fixedAbove(fixed, q.version) !== undefined ? { fixed: fixedAbove(fixed, q.version) } : {}),
    symbols: [...new Set(symbols)].slice(0, 40),
    url: `https://osv.dev/vulnerability/${v.id}`,
  };
}

/**
 * An advisory's severity: the database label (GitHub's LOW, MODERATE, HIGH,
 * CRITICAL) when present, else the CVSS v3 base score when the record gives
 * a number, else medium.
 */
function severityOf(label: string | undefined, scores: OsvVuln["severity"]): Advisory["severity"] {
  switch (label?.toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MODERATE":
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
  }
  const score = (scores ?? []).map((s) => Number(s.score)).find((n) => Number.isFinite(n));
  if (score === undefined) return "medium";
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
}

/** The lowest fixed version above `version`: an advisory with several ranges names one fix per release line. */
function fixedAbove(fixed: string[], version: string): string | undefined {
  return [...fixed].filter((f) => !version || compareVersions(f, version) > 0).sort(compareVersions)[0];
}
