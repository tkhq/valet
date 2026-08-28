/**
 * Valet Security export builders (spec §Export) — pure functions from rows
 * to the three export formats. No IO here: the export route loads the rows,
 * applies the findings filters, writes the audit event, and picks the
 * content type; these functions only shape bytes. Decision 10 keeps the
 * export surface human-only, so nothing in this module is reachable from a
 * `sec_*` tool.
 */
import type {
  SecurityCellRow,
  SecurityEngagementRow,
  SecurityFindingRow,
} from "../schema/index.js";
import type { FindingSeverity } from "./security-engagements.js";

/** Rows the builders shape. The route passes the FILTERED finding set —
 * export scope is whatever the caller's filters selected. */
export interface SecurityExportInput {
  engagement: SecurityEngagementRow;
  cells: SecurityCellRow[];
  findings: SecurityFindingRow[];
  repoFullName: string;
  /** The engagement's pinned commit SHA; empty while planning. */
  repoRef: string;
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

// ── SARIF 2.1.0 (spec §Export, normative mapping) ──────────────────────────

/** critical/high → error, medium → warning, low/info → note. */
const SARIF_LEVEL: Record<FindingSeverity, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
  info: "note",
};

export interface SarifRule {
  id: string;
  shortDescription: { text: string };
}

export interface SarifSuppression {
  kind: "external";
  status: "accepted";
  justification: string;
}

export interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number };
    };
  }>;
  suppressions?: SarifSuppression[];
}

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: Array<{
    tool: { driver: { name: string; rules: SarifRule[] } };
    versionControlProvenance: Array<{ repositoryUri: string; revisionId: string }>;
    results: SarifResult[];
  }>;
}

/**
 * One `run` per engagement. Rules derive from DISTINCT fingerprints (the
 * first finding's title names the rule); every finding row is a result with
 * `ruleId` = fingerprint. Refuted findings are NOT dropped — they carry
 * `suppressions` with the reviewer's justification, because an auditor
 * wants to see what was dismissed and why. Verified/open results have no
 * `suppressions` property at all.
 */
export function buildSarif(input: SecurityExportInput): SarifLog {
  const rules = new Map<string, SarifRule>();
  for (const finding of input.findings) {
    if (!rules.has(finding.fingerprint)) {
      rules.set(finding.fingerprint, {
        id: finding.fingerprint,
        shortDescription: { text: finding.title },
      });
    }
  }

  const results = input.findings.map((finding) => {
    const result: SarifResult = {
      ruleId: finding.fingerprint,
      level: SARIF_LEVEL[finding.severity],
      message: { text: finding.body },
    };
    // A finding without a file has no physical location — omit the property
    // rather than inventing a URI.
    if (finding.file !== null) {
      result.locations = [
        {
          physicalLocation: {
            artifactLocation: { uri: finding.file },
            ...(finding.line !== null ? { region: { startLine: finding.line } } : {}),
          },
        },
      ];
    }
    if (finding.status === "refuted") {
      result.suppressions = [
        {
          kind: "external",
          status: "accepted",
          justification: finding.statusReason ?? "",
        },
      ];
    }
    return result;
  });

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "valet-security", rules: [...rules.values()] } },
        versionControlProvenance: [
          {
            repositoryUri: `https://github.com/${input.repoFullName}`,
            revisionId: input.repoRef,
          },
        ],
        results,
      },
    ],
  };
}

// ── Markdown report ─────────────────────────────────────────────────────────

export interface FindingSummary {
  /** One count per distinct fingerprint, keyed by the group's highest
   * severity — the same distinct-count rule the close manifest uses. */
  distinctBySeverity: Record<FindingSeverity, number>;
  statusBreakdown: { open: number; verified: number; refuted: number };
}

export function summarizeFindings(findings: SecurityFindingRow[]): FindingSummary {
  const distinctBySeverity: Record<FindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  const groups = new Map<string, FindingSeverity>();
  for (const finding of findings) {
    const current = groups.get(finding.fingerprint);
    if (
      current === undefined ||
      SEVERITY_ORDER.indexOf(finding.severity) < SEVERITY_ORDER.indexOf(current)
    ) {
      groups.set(finding.fingerprint, finding.severity);
    }
  }
  for (const severity of groups.values()) distinctBySeverity[severity] += 1;

  const statusBreakdown = { open: 0, verified: 0, refuted: 0 };
  for (const finding of findings) statusBreakdown[finding.status] += 1;
  return { distinctBySeverity, statusBreakdown };
}

/**
 * A fence longer than any backtick run inside `body`, at least the standard
 * three — a finding body is data from an agent that read hostile code, and
 * a body containing ``` must not break out of its evidence block.
 */
export function collisionSafeFence(body: string): string {
  let longest = 0;
  for (const match of body.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The manifest summary (distinct counts by severity, status breakdown, per
 * cell tallies) followed by one section per finding. An export of the data,
 * not a designed report (the report writer stays a non-goal).
 */
export function buildMarkdownReport(input: SecurityExportInput): string {
  const { distinctBySeverity, statusBreakdown } = summarizeFindings(input.findings);
  const lines: string[] = [
    `# Valet Security findings — ${input.repoFullName}`,
    "",
    `Engagement \`${input.engagement.id}\` (${input.engagement.status}), pinned at commit \`${input.repoRef}\`.`,
    "",
    "## Summary",
    "",
    "| Severity | Distinct findings |",
    "| --- | --- |",
  ];
  for (const severity of SEVERITY_ORDER) {
    lines.push(`| ${severity} | ${distinctBySeverity[severity]} |`);
  }
  lines.push(
    "",
    `Status: ${statusBreakdown.open} open, ${statusBreakdown.verified} verified, ` +
      `${statusBreakdown.refuted} refuted (${input.findings.length} finding rows).`,
    "",
  );

  if (input.cells.length > 0) {
    lines.push("## Cells", "", "| Cell | Persona | Status | Findings |", "| --- | --- | --- | --- |");
    for (const cell of input.cells) {
      const count = input.findings.filter((f) => f.cellId === cell.id).length;
      lines.push(`| ${cell.dir} | ${cell.persona} | ${cell.status} | ${count} |`);
    }
    lines.push("");
  }

  lines.push("## Findings", "");
  for (const finding of input.findings) {
    lines.push(`### [${finding.severity}] ${finding.title}`, "");
    if (finding.file !== null) {
      const location = finding.line !== null ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(`- Location: \`${location}\``);
    }
    lines.push(
      `- Status: ${finding.status}${finding.statusReason !== null ? ` — ${finding.statusReason}` : ""}`,
    );
    lines.push(`- Fingerprint: \`${finding.fingerprint}\``, "");
    const fence = collisionSafeFence(finding.body);
    lines.push(fence, finding.body, fence, "");
  }
  return lines.join("\n");
}

// ── Plain JSON ──────────────────────────────────────────────────────────────

export interface SecurityJsonExport {
  engagement: {
    id: string;
    repoFullName: string;
    repoRef: string;
    status: string;
  };
  findings: Array<{
    id: string;
    cellId: string;
    fingerprint: string;
    severity: FindingSeverity;
    title: string;
    file: string | null;
    line: number | null;
    body: string;
    status: string;
    statusReason: string | null;
    statusActor: string | null;
    createdAt: number;
  }>;
}

export function buildJsonExport(input: SecurityExportInput): SecurityJsonExport {
  return {
    engagement: {
      id: input.engagement.id,
      repoFullName: input.repoFullName,
      repoRef: input.repoRef,
      status: input.engagement.status,
    },
    findings: input.findings.map((finding) => ({
      id: finding.id,
      cellId: finding.cellId,
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      title: finding.title,
      file: finding.file,
      line: finding.line,
      body: finding.body,
      status: finding.status,
      statusReason: finding.statusReason,
      statusActor: finding.statusActor,
      createdAt: finding.createdAt,
    })),
  };
}
