import type { AppQueryable } from "../lib/drizzle.js";
import { orgs } from "../schema/index.js";
import { buildCurrentPolicySource, CurrentPolicySourceError } from "./bundles/current-policy-source.js";
import type { CurrentPolicySourceSnapshotV1 } from "./bundles/current-policy-types.js";
import { currentPolicySnapshot, type ActionPluginByService } from "./canonical-policy-manager.js";

export interface CurrentPolicyCompatibilityIssue {
  readonly ids: readonly string[];
  readonly reason: string;
  readonly correctiveAction: string;
}
export interface CurrentPolicyCompatibilityReport {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly compatible: boolean;
  readonly issues: readonly CurrentPolicyCompatibilityIssue[];
}

/** Static compatibility only. This does not evaluate policy or include matcher values. */
export function currentPolicyCompatibilityReport(snapshot: CurrentPolicySourceSnapshotV1): CurrentPolicyCompatibilityReport {
  const issues: CurrentPolicyCompatibilityIssue[] = [];
  const rows = [...snapshot.organizationPolicies, ...snapshot.teamPolicies, ...snapshot.personalOverrides]
    .sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  for (const row of rows) {
    try {
      buildCurrentPolicySource({
        ...snapshot,
        organizationPolicies: "principalType" in row && row.principalType === "org" ? [row] : [],
        teamPolicies: "principalType" in row && row.principalType === "team" ? [row] : [],
        personalOverrides: "userId" in row ? [row] : [],
      });
    } catch (error) {
      issues.push(issue([row.id], error));
    }
  }
  try {
    buildCurrentPolicySource(snapshot);
  } catch (error) {
    const activeIds = rows.filter((row) => !("revokedAtMs" in row) || row.revokedAtMs === null).map((row) => row.id);
    const aggregate = issue(activeIds, error);
    if (!issues.some((entry) => entry.reason === aggregate.reason && entry.ids.length === 1)) issues.push(aggregate);
  }
  const ordered = issues.sort((a, b) => utf8Compare(a.reason, b.reason) || utf8Compare(a.ids.join("\0"), b.ids.join("\0")));
  return { schemaVersion: 1, organizationId: snapshot.organizationId, compatible: ordered.length === 0, issues: ordered };
}

export async function currentPolicyCompatibilityReports(db: AppQueryable, plugins: ActionPluginByService): Promise<CurrentPolicyCompatibilityReport[]> {
  const organizations = await db.select({ id: orgs.id }).from(orgs);
  const reports: CurrentPolicyCompatibilityReport[] = [];
  for (const { id } of organizations.sort((a, b) => utf8Compare(a.id, b.id))) {
    reports.push(currentPolicyCompatibilityReport(await currentPolicySnapshot(db, id, plugins)));
  }
  return reports;
}

export class CurrentPolicyCompatibilityError extends Error {
  readonly code = "current_policy_incompatible";
  constructor(readonly report: CurrentPolicyCompatibilityReport) {
    super(`Canonical policy compatibility failed for ${report.organizationId}: ${report.issues.map((entry) => `${entry.ids.join(",")}:${entry.reason}`).join("; ")}`);
    this.name = "CurrentPolicyCompatibilityError";
  }
}

function issue(ids: readonly string[], error: unknown): CurrentPolicyCompatibilityIssue {
  const reason = error instanceof CurrentPolicySourceError ? error.code : "source_validation";
  return {
    ids,
    reason,
    correctiveAction: correctiveAction(reason),
  };
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function correctiveAction(reason: string): string {
  if (reason === "non_lossless_path" || reason === "unsafe_path") return "Rewrite the matcher with dot keys and numeric bracket indexes, then retry preflight.";
  if (reason === "non_lossless_regex" || reason === "unsafe_regex") return "Replace the regex with a lossless bounded pattern, then retry preflight.";
  if (reason === "invalid_value") return "Use a JSON value of the type required by the matcher operator, then retry preflight.";
  if (reason === "complexity_limit") return "Revoke or split active rules until the current policy limits are satisfied.";
  return "Correct or revoke the listed row, then retry canonical policy preflight.";
}
