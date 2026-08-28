/**
 * Pure export builders (spec §Export): the normative SARIF mapping, the
 * collision-safe markdown fences, and the plain JSON shape. No IO.
 */
import { describe, expect, it } from "vitest";
import type {
  SecurityCellRow,
  SecurityEngagementRow,
  SecurityFindingRow,
} from "../schema/index.js";
import {
  buildJsonExport,
  buildMarkdownReport,
  buildSarif,
  collisionSafeFence,
  summarizeFindings,
  type SecurityExportInput,
} from "./security-export.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const ENGAGEMENT: SecurityEngagementRow = {
  id: "eng_1",
  sessionId: "sess_1",
  status: "completed",
  repoFullName: "acme/api",
  repoRef: SHA,
  plan: "",
  parentEngagementId: null,
  createdAt: 1_000,
  updatedAt: 2_000,
};

function cell(overrides: Partial<SecurityCellRow> & { id: string; ordinal: number }): SecurityCellRow {
  return {
    engagementId: ENGAGEMENT.id,
    persona: "code-review",
    mode: "fresh",
    goal: "Sweep the routes",
    dir: `0${overrides.ordinal}-sweep`,
    reads: "[]",
    review: false,
    status: "completed",
    attempts: 1,
    compactedAt: null,
    childSessionId: null,
    dispatchedAt: null,
    settledAt: null,
    createdAt: 1_000,
    ...overrides,
  };
}

function finding(overrides: Partial<SecurityFindingRow> & { id: string }): SecurityFindingRow {
  return {
    engagementId: ENGAGEMENT.id,
    cellId: "cell_1",
    fingerprint: `fp_${overrides.id}`,
    severity: "high",
    title: "IDOR on sessions",
    file: "src/routes/sessions.ts",
    line: 42,
    body: "The route reads the id and never checks ownership.",
    status: "open",
    statusReason: null,
    statusActor: null,
    createdAt: 1_000,
    ...overrides,
  };
}

function input(findings: SecurityFindingRow[], cells: SecurityCellRow[] = []): SecurityExportInput {
  return {
    engagement: ENGAGEMENT,
    cells,
    findings,
    repoFullName: ENGAGEMENT.repoFullName,
    repoRef: ENGAGEMENT.repoRef,
  };
}

describe("buildSarif", () => {
  it("maps all five severities to the normative levels", () => {
    const sarif = buildSarif(
      input([
        finding({ id: "f1", severity: "critical" }),
        finding({ id: "f2", severity: "high" }),
        finding({ id: "f3", severity: "medium" }),
        finding({ id: "f4", severity: "low" }),
        finding({ id: "f5", severity: "info" }),
      ]),
    );
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe("valet-security");
    expect(sarif.runs[0].results.map((r) => r.level)).toEqual([
      "error",
      "error",
      "warning",
      "note",
      "note",
    ]);
  });

  it("derives rules from distinct fingerprints and stamps ruleId per result", () => {
    const sarif = buildSarif(
      input([
        finding({ id: "f1", fingerprint: "fp_shared", title: "IDOR on sessions" }),
        finding({ id: "f2", fingerprint: "fp_shared", title: "IDOR on sessions (dup)" }),
        finding({ id: "f3", fingerprint: "fp_other", title: "verbose logging" }),
      ]),
    );
    const rules = sarif.runs[0].tool.driver.rules;
    expect(rules.map((r) => r.id)).toEqual(["fp_shared", "fp_other"]);
    // The first finding's title names the rule.
    expect(rules[0].shortDescription.text).toBe("IDOR on sessions");
    expect(sarif.runs[0].results.map((r) => r.ruleId)).toEqual([
      "fp_shared",
      "fp_shared",
      "fp_other",
    ]);
  });

  it("suppresses ONLY refuted findings, with the reviewer's justification", () => {
    const sarif = buildSarif(
      input([
        finding({ id: "f1", status: "open" }),
        finding({ id: "f2", status: "verified", statusReason: "confirmed", statusActor: "user:u1" }),
        finding({
          id: "f3",
          status: "refuted",
          statusReason: "the caller is already scoped upstream",
          statusActor: "user:u1",
        }),
      ]),
    );
    const [open, verified, refuted] = sarif.runs[0].results;
    expect(open.suppressions).toBeUndefined();
    expect(verified.suppressions).toBeUndefined();
    // Refuted rides along suppressed — never silently dropped.
    expect(refuted.suppressions).toEqual([
      {
        kind: "external",
        status: "accepted",
        justification: "the caller is already scoped upstream",
      },
    ]);
  });

  it("carries the pinned SHA in versionControlProvenance", () => {
    const sarif = buildSarif(input([finding({ id: "f1" })]));
    expect(sarif.runs[0].versionControlProvenance).toEqual([
      { repositoryUri: "https://github.com/acme/api", revisionId: SHA },
    ]);
  });

  it("emits a physical location with startLine, and none for a file-less finding", () => {
    const sarif = buildSarif(
      input([
        finding({ id: "f1", file: "src/a.ts", line: 7 }),
        finding({ id: "f2", file: "src/b.ts", line: null }),
        finding({ id: "f3", file: null, line: null }),
      ]),
    );
    const [withLine, withoutLine, fileless] = sarif.runs[0].results;
    expect(withLine.locations).toEqual([
      {
        physicalLocation: {
          artifactLocation: { uri: "src/a.ts" },
          region: { startLine: 7 },
        },
      },
    ]);
    expect(withoutLine.locations?.[0].physicalLocation.region).toBeUndefined();
    expect(fileless.locations).toBeUndefined();
  });

  it("puts the finding body in message.text", () => {
    const sarif = buildSarif(input([finding({ id: "f1", body: "evidence text" })]));
    expect(sarif.runs[0].results[0].message.text).toBe("evidence text");
  });
});

describe("collisionSafeFence", () => {
  it("stays at three backticks for a plain body", () => {
    expect(collisionSafeFence("no fences here")).toBe("```");
  });

  it("outruns the longest backtick run in the body", () => {
    expect(collisionSafeFence("a ``` fenced block")).toBe("````");
    expect(collisionSafeFence("nested ````` five")).toBe("``````");
  });
});

describe("buildMarkdownReport", () => {
  it("fences a body containing ``` with a longer fence", () => {
    const hostile = "look:\n```js\nalert(1)\n```\ndone";
    const report = buildMarkdownReport(input([finding({ id: "f1", body: hostile })]));
    expect(report).toContain("````\n" + hostile + "\n````");
  });

  it("summarizes distinct counts by severity and the status breakdown", () => {
    const report = buildMarkdownReport(
      input([
        // Two rows, one fingerprint: ONE distinct high.
        finding({ id: "f1", fingerprint: "fp_a", severity: "high" }),
        finding({ id: "f2", fingerprint: "fp_a", severity: "high", status: "refuted", statusReason: "dup" }),
        finding({ id: "f3", fingerprint: "fp_b", severity: "low", status: "verified", statusReason: "yes" }),
      ]),
    );
    expect(report).toContain("| high | 1 |");
    expect(report).toContain("| low | 1 |");
    expect(report).toContain("| critical | 0 |");
    expect(report).toContain("Status: 1 open, 1 verified, 1 refuted (3 finding rows).");
  });

  it("renders per-finding sections with location, status reason, and cells table", () => {
    const report = buildMarkdownReport(
      input(
        [
          finding({
            id: "f1",
            cellId: "cell_1",
            severity: "critical",
            title: "RCE via eval",
            file: "src/x.ts",
            line: 3,
            status: "verified",
            statusReason: "reproduced",
          }),
        ],
        [cell({ id: "cell_1", ordinal: 1 })],
      ),
    );
    expect(report).toContain("### [critical] RCE via eval");
    expect(report).toContain("- Location: `src/x.ts:3`");
    expect(report).toContain("- Status: verified — reproduced");
    expect(report).toContain("| 01-sweep | code-review | completed | 1 |");
  });
});

describe("buildJsonExport", () => {
  it("shapes the plain engagement + findings export", () => {
    const row = finding({ id: "f1" });
    const json = buildJsonExport(input([row]));
    expect(json.engagement).toEqual({
      id: "eng_1",
      repoFullName: "acme/api",
      repoRef: SHA,
      status: "completed",
    });
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0]).toEqual({
      id: "f1",
      cellId: "cell_1",
      fingerprint: "fp_f1",
      severity: "high",
      title: "IDOR on sessions",
      file: "src/routes/sessions.ts",
      line: 42,
      body: "The route reads the id and never checks ownership.",
      status: "open",
      statusReason: null,
      statusActor: null,
      createdAt: 1_000,
    });
  });
});

describe("summarizeFindings", () => {
  it("keys a fingerprint group by its highest severity", () => {
    const { distinctBySeverity } = summarizeFindings([
      finding({ id: "f1", fingerprint: "fp_a", severity: "medium" }),
      finding({ id: "f2", fingerprint: "fp_a", severity: "critical" }),
    ]);
    expect(distinctBySeverity.critical).toBe(1);
    expect(distinctBySeverity.medium).toBe(0);
  });
});
