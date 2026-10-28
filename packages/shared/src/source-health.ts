/** Spec 11.2: one guidance line per non-ok health reason, shared by the
 * sources page, the session banner, the admin notification, and the runbook. */
export type SourceHealth = "healthy" | "stale" | "incompatible" | "failing" | "unbaked";
export type SourceHealthReason =
  | "ok" | "resolve_failed" | "repo_unreachable" | "credentials" | "registry_full"
  | "bake_failed" | "contract" | "contract_unknown" | "waiting_for_base";
export const SOURCE_HEALTH_GUIDANCE: Record<Exclude<SourceHealthReason, "ok">, string> = {
  resolve_failed: "Valet could not read the repo's recipe or lockfile. Usually a platform bug; the detail names the file.",
  repo_unreachable: "The Valet GitHub app lost access. Reinstall it on this repository.",
  credentials: "Anonymous bakes are off for this org. Connect an org GitHub credential.",
  registry_full: "The image registry is out of space. Retention needs to run.",
  bake_failed: "The setup commands failed. The log tail shows where.",
  contract: "The image was built before a runtime change. A rebuild is already queued.",
  contract_unknown: "Valet could not read the image's label from the registry. It will retry.",
  waiting_for_base: "The base image is building first. Nothing to do.",
};
export function sourceHealthGuidance(reason: SourceHealthReason): string | null {
  return reason === "ok" ? null : SOURCE_HEALTH_GUIDANCE[reason];
}

/** Spec 11.3 row phrase. `relative` renders "2h ago"; callers pass their
 * own formatter so the api and web agree on wording without sharing a
 * date library. */
export function sourceHealthPhrase(
  health: SourceHealth,
  reason: SourceHealthReason,
  builtAt: number | null,
  now: number,
  relative: (ts: number, now: number) => string = defaultRelative,
): string {
  switch (health) {
    case "healthy": return builtAt === null ? "Healthy" : `Healthy, built ${relative(builtAt, now)}`;
    case "stale": return "Rebuilding";
    case "incompatible": return "Unusable: image predates the current runtime";
    case "failing": return `Failing: ${sourceHealthGuidance(reason) ?? reason}`;
    case "unbaked": return "Not built yet";
  }
}

function defaultRelative(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
