/**
 * M6 human triage routes: verify/refute with the named admin right, the
 * export formats + audit rows, and issue-filing validation/idempotency.
 * No engine turns and no ANTHROPIC_API_KEY — filing paths that would reach
 * a real provider are covered by unit tests with a fake invoker
 * (services/security-issues.test.ts); here only the invoker-free branches
 * run (validation, idempotent repeat, internal-token refusal).
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import {
  actionInvocations,
  securityFindingLinks,
  securityFindings,
  securityHandoffs,
  teamMembers,
  teams,
} from "../schema/index.js";
import type { SarifLog } from "../services/security-export.js";
import type { SecurityJsonExport } from "../services/security-export.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  ListSecurityFindingsResponse,
  SecurityFileIssueResponse,
  SecurityHandoffResponse,
  SecurityReviewFindingResponse,
} from "../wire/types.js";

const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git" };

/** A body long enough to clear the 200-character evidence floor. */
const EVIDENCE = `The route reads the session id from the URL and never checks ownership. Excerpt: db.select().from(sessions).where(eq(sessions.id, id)) — any authenticated caller can read any session, which leaks other tenants' transcripts.`;

async function createSecuritySession(
  baseUrl: string,
  extra: Record<string, unknown> = {},
): Promise<{ session: CreateSessionResponse; engagementId: string }> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace: "/tmp/valet-security-triage-test",
      kind: "security",
      repo: REPO,
      ...extra,
    }),
  });
  expect(res.status).toBe(201);
  const session = (await res.json()) as CreateSessionResponse;
  const security = await fetch(`${baseUrl}/api/sessions/${session.id}/security`);
  expect(security.status).toBe(200);
  const body = (await security.json()) as GetSessionSecurityResponse;
  return { session, engagementId: body.engagement.id };
}

async function seedFinding(
  api: TestApi,
  engagementId: string,
  overrides: Partial<typeof securityFindings.$inferInsert> & { id: string },
): Promise<void> {
  await api.providers.db.insert(securityFindings).values({
    engagementId,
    cellId: "cell_x",
    fingerprint: `fp_${overrides.id}`,
    severity: "high",
    title: "IDOR on sessions",
    file: "src/routes/sessions.ts",
    line: 42,
    body: EVIDENCE,
    status: "open",
    createdAt: Date.now(),
    ...overrides,
  });
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("api integration: security triage routes (M6)", () => {
  it("human review: reason required, forward-only, actor stamped user:<id>", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      await seedFinding(api, engagementId, { id: "fnd_1" });
      const statusUrl = (findingId: string) =>
        `${api.baseUrl}/api/sessions/${session.id}/security/findings/${findingId}/status`;

      // Reason is required, and the 400 names it.
      const noReason = await postJson(statusUrl("fnd_1"), { status: "verified" });
      expect(noReason.status).toBe(400);
      expect(((await noReason.json()) as { error: string }).error).toBe(
        "Send { reason } naming what the evidence shows or what it missed.",
      );

      const badStatus = await postJson(statusUrl("fnd_1"), { status: "open", reason: "x" });
      expect(badStatus.status).toBe(400);

      const verified = await postJson(statusUrl("fnd_1"), {
        status: "verified",
        reason: "reproduced against main",
      });
      expect(verified.status).toBe(200);
      const body = (await verified.json()) as SecurityReviewFindingResponse;
      expect(body.finding.status).toBe("verified");
      expect(body.finding.statusReason).toBe("reproduced against main");
      expect(body.finding.statusActor).toBe("user:local-user");

      // Forward-only: a second flip refuses.
      const again = await postJson(statusUrl("fnd_1"), { status: "refuted", reason: "no" });
      expect(again.status).toBe(409);

      const unknown = await postJson(statusUrl("fnd_missing"), {
        status: "verified",
        reason: "x",
      });
      expect(unknown.status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });

  it("refuses the internal token on every triage route (Decision 10)", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      await seedFinding(api, engagementId, { id: "fnd_1" });
      const base = `${api.baseUrl}/api/sessions/${session.id}/security`;
      const asRunner = { "x-valet-internal": internalToken() };

      const status = await postJson(
        `${base}/findings/fnd_1/status`,
        { status: "verified", reason: "x" },
        asRunner,
      );
      expect(status.status).toBe(403);
      expect(((await status.json()) as { error: string }).error).toContain("human");

      const exported = await fetch(`${base}/export?format=md`, { headers: asRunner });
      expect(exported.status).toBe(403);

      const filed = await postJson(`${base}/findings/fnd_1/issues`, { provider: "github" }, asRunner);
      expect(filed.status).toBe(403);

      const digest = await postJson(
        `${base}/issues/digest`,
        { provider: "github", findingIds: ["fnd_1"] },
        asRunner,
      );
      expect(digest.status).toBe(403);
    } finally {
      await api.cleanup();
    }
  });

  it("a team viewer without the admin right gets a 403 that names it", async () => {
    const api = await bootTestApi();
    try {
      const now = Date.now();
      await api.providers.db
        .insert(teams)
        .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
      // local-user (org admin) creates; test-member is a plain team member —
      // a viewer, not an admin.
      await api.providers.db.insert(teamMembers).values([
        { teamId: "team_1", userId: "local-user", role: "member" },
        { teamId: "team_1", userId: "test-member", role: "member" },
      ]);

      const { session, engagementId } = await createSecuritySession(api.baseUrl, {
        teamId: "team_1",
      });
      await seedFinding(api, engagementId, { id: "fnd_1" });
      const statusUrl = `${api.baseUrl}/api/sessions/${session.id}/security/findings/fnd_1/status`;
      const asMember = { "x-valet-test-user-id": "test-member" };

      // The member can view the engagement...
      const view = await fetch(`${api.baseUrl}/api/sessions/${session.id}/security`, {
        headers: asMember,
      });
      expect(view.status).toBe(200);

      // ...but the flip requires canAdministerSession, and the 403 names it.
      const denied = await postJson(statusUrl, { status: "verified", reason: "x" }, asMember);
      expect(denied.status).toBe(403);
      const deniedBody = (await denied.json()) as { error: string };
      expect(deniedBody.error).toContain("canAdministerSession");
      expect(deniedBody.error).toContain("session admin");

      // The org admin (local-user) holds the right.
      const allowed = await postJson(statusUrl, {
        status: "verified",
        reason: "confirmed by reproducing the request against main",
      });
      expect(allowed.status).toBe(200);
    } finally {
      await api.cleanup();
    }
  });

  it("exports md, sarif (suppressions on refuted), and json — and writes the audit row", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      await seedFinding(api, engagementId, { id: "fnd_high", severity: "high", createdAt: 1_000 });
      await seedFinding(api, engagementId, {
        id: "fnd_refuted",
        severity: "low",
        title: "verbose logging",
        status: "refuted",
        statusReason: "log level is debug-only",
        statusActor: "user:local-user",
        createdAt: 2_000,
      });
      await seedFinding(api, engagementId, {
        id: "fnd_fileless",
        severity: "medium",
        title: "dependency drift",
        file: null,
        line: null,
        createdAt: 3_000,
      });
      const base = `${api.baseUrl}/api/sessions/${session.id}/security/export`;

      const noFormat = await fetch(base);
      expect(noFormat.status).toBe(400);

      const md = await fetch(`${base}?format=md`);
      expect(md.status).toBe(200);
      expect(md.headers.get("content-type")).toContain("text/markdown");
      expect(md.headers.get("content-disposition")).toBe(
        `attachment; filename="valet-security-${engagementId}.md"`,
      );
      const report = await md.text();
      expect(report).toContain("# Valet Security findings — acme/api");
      expect(report).toContain("### [high] IDOR on sessions");

      const sarifRes = await fetch(`${base}?format=sarif`);
      expect(sarifRes.status).toBe(200);
      expect(sarifRes.headers.get("content-type")).toContain("application/sarif+json");
      expect(sarifRes.headers.get("content-disposition")).toContain(
        `valet-security-${engagementId}.sarif`,
      );
      const sarif = (await sarifRes.json()) as SarifLog;
      expect(sarif.version).toBe("2.1.0");
      expect(sarif.runs[0].tool.driver.name).toBe("valet-security");
      expect(sarif.runs[0].results).toHaveLength(3);
      const refuted = sarif.runs[0].results.find((r) => r.suppressions !== undefined);
      expect(refuted?.suppressions).toEqual([
        { kind: "external", status: "accepted", justification: "log level is debug-only" },
      ]);
      const fileless = sarif.runs[0].results.find((r) => r.ruleId === "fp_fnd_fileless");
      expect(fileless?.locations).toBeUndefined();
      expect(sarif.runs[0].versionControlProvenance[0].repositoryUri).toBe(
        "https://github.com/acme/api",
      );

      // Filters scope the export.
      const filtered = await fetch(`${base}?format=sarif&severity=high`);
      const filteredSarif = (await filtered.json()) as SarifLog;
      expect(filteredSarif.runs[0].results).toHaveLength(1);
      expect(filteredSarif.runs[0].results[0].ruleId).toBe("fp_fnd_high");

      const jsonRes = await fetch(`${base}?format=json`);
      expect(jsonRes.headers.get("content-type")).toContain("application/json");
      const json = (await jsonRes.json()) as SecurityJsonExport;
      expect(json.engagement.id).toBe(engagementId);
      expect(json.findings).toHaveLength(3);

      // Every export wrote an audit row: actor, format, row count.
      const auditRows = await api.providers.db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.actionId, "security.export"));
      expect(auditRows).toHaveLength(4);
      const jsonAudit = auditRows[auditRows.length - 1];
      expect(jsonAudit.userId).toBe("local-user");
      expect(jsonAudit.sessionId).toBe(session.id);
      expect(jsonAudit.params).toMatchObject({ format: "json", rowCount: 3, engagementId });
    } finally {
      await api.cleanup();
    }
  });

  it("filing: foreign findings refused, linear team required, repeat returns the link", async () => {
    const api = await bootTestApi();
    try {
      const a = await createSecuritySession(api.baseUrl);
      const b = await createSecuritySession(api.baseUrl);
      await seedFinding(api, a.engagementId, { id: "fnd_a" });
      await seedFinding(api, b.engagementId, { id: "fnd_b" });
      const base = `${api.baseUrl}/api/sessions/${a.session.id}/security`;

      // A finding from another engagement is not reachable here.
      const foreign = await postJson(`${base}/findings/fnd_b/issues`, { provider: "github" });
      expect(foreign.status).toBe(404);

      const foreignDigest = await postJson(`${base}/issues/digest`, {
        provider: "github",
        findingIds: ["fnd_a", "fnd_b"],
      });
      expect(foreignDigest.status).toBe(400);
      expect(((await foreignDigest.json()) as { error: string }).error).toBe(
        "Every finding in { findingIds } must belong to this engagement.",
      );

      const emptyDigest = await postJson(`${base}/issues/digest`, {
        provider: "github",
        findingIds: [],
      });
      expect(emptyDigest.status).toBe(400);

      const badProvider = await postJson(`${base}/findings/fnd_a/issues`, { provider: "jira" });
      expect(badProvider.status).toBe(400);

      // Linear needs a team; the 400 names the fix.
      const noTeam = await postJson(`${base}/findings/fnd_a/issues`, { provider: "linear" });
      expect(noTeam.status).toBe(400);
      expect(((await noTeam.json()) as { error: string }).error).toBe(
        "Pick a Linear team for this engagement.",
      );

      // Idempotency: an existing (finding, provider) link answers 200 with
      // created:false and never touches the provider.
      await api.providers.db.insert(securityFindingLinks).values({
        id: "lnk_1",
        findingId: "fnd_a",
        engagementId: a.engagementId,
        provider: "github",
        externalId: "9",
        url: "https://github.com/acme/api/issues/9",
        createdBy: "local-user",
        createdAt: Date.now(),
      });
      const repeat = await postJson(`${base}/findings/fnd_a/issues`, { provider: "github" });
      expect(repeat.status).toBe(200);
      const repeatBody = (await repeat.json()) as SecurityFileIssueResponse;
      expect(repeatBody.created).toBe(false);
      expect(repeatBody.link.url).toBe("https://github.com/acme/api/issues/9");

      // The findings list carries the link chip (one grouped query).
      const list = await fetch(`${base}/findings`);
      const listBody = (await list.json()) as ListSecurityFindingsResponse;
      const linked = listBody.findings.find((f) => f.id === "fnd_a");
      expect(linked?.links).toHaveLength(1);
      expect(linked?.links?.[0].provider).toBe("github");
      expect(linked?.links?.[0].url).toBe("https://github.com/acme/api/issues/9");
    } finally {
      await api.cleanup();
    }
  });

  it("handoff route records a security_handoffs row and the finding surfaces it", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      await seedFinding(api, engagementId, { id: "fnd_h" });

      // Fake the spawner: the fix session is not the unit under test, only the
      // link row is. Return a fixed child id, count the calls.
      let spawnCalls = 0;
      api.providers.childSpawner = async () => {
        spawnCalls += 1;
        return { childSessionId: "child_fix_h", queueItemId: "q1" };
      };

      const headers = {
        "x-valet-internal": internalToken(),
        "x-valet-session-id": session.id,
        "Content-Type": "application/json",
      };
      const res = await postJson(
        `${api.baseUrl}/api/sessions/${session.id}/security/handoff`,
        { findingId: "fnd_h", task: "patch the ownership check", threadId: "thread_1" },
        headers,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecurityHandoffResponse;
      expect(body.childSessionId).toBe("child_fix_h");
      expect(spawnCalls).toBe(1);

      // The link row landed.
      const rows = await api.providers.db
        .select()
        .from(securityHandoffs)
        .where(eq(securityHandoffs.findingId, "fnd_h"));
      expect(rows).toHaveLength(1);
      expect(rows[0].childSessionId).toBe("child_fix_h");
      expect(rows[0].title).toBe("Fix: IDOR on sessions");
      expect(rows[0].task).toBe("patch the ownership check");

      // The findings list surfaces the handoff per finding.
      const list = await fetch(
        `${api.baseUrl}/api/sessions/${session.id}/security/findings`,
      );
      const listBody = (await list.json()) as ListSecurityFindingsResponse;
      const finding = listBody.findings.find((f) => f.id === "fnd_h");
      expect(finding?.handoffs).toHaveLength(1);
      expect(finding?.handoffs?.[0].childSessionId).toBe("child_fix_h");
      expect(finding?.handoffs?.[0].task).toBe("patch the ownership check");
    } finally {
      await api.cleanup();
    }
  });
});
