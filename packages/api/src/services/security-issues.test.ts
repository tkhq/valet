/**
 * Issue filing (spec §Filing issues, Decisions 10 + 11): link-row
 * idempotency, provider request shapes through a FAKE invoker, corrective
 * missing-integration copy, and the digest path's no-link rule. The real
 * invoker seam is covered by action-invoker.test.ts; here it is a counter.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowInvokeActionRequest, WorkflowInvokeActionResult } from "@valet/workflow";
import type { ActionInvocationContext } from "../plugins/action-invoker.js";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import {
  securityFindingLinks,
  type SecurityEngagementRow,
  type SecurityFindingRow,
} from "../schema/index.js";
import {
  blobPermalink,
  buildDigestBody,
  buildIssueBody,
  buildIssueTitle,
  createIssueViaProvider,
  fileDigestIssue,
  fileFindingIssue,
  findingPermalink,
  IssueRequestError,
  MissingIntegrationError,
  type SecurityIssuesDeps,
} from "./security-issues.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const WEB = "https://valet.example.com";

const ENGAGEMENT: SecurityEngagementRow = {
  id: "eng_1",
  sessionId: "sess_1",
  status: "running",
  repoFullName: "acme/api",
  repoRef: SHA,
  plan: "",
  parentEngagementId: null,
  baseRef: null,
  changedPaths: null,
  focus: null,
  invariants: null,
  categories: null,
  configPersonas: null,
  configTools: null,
  hasRepoConfig: false,
  createdAt: 1_000,
  updatedAt: 2_000,
};

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

const ACTOR = { userId: "u_1", orgId: "org_1" };

interface FakeInvoker {
  deps: (db: AppDb) => SecurityIssuesDeps;
  calls: WorkflowInvokeActionRequest[];
  contexts: ActionInvocationContext[];
}

function fakeInvoker(
  program: (req: WorkflowInvokeActionRequest) => WorkflowInvokeActionResult,
): FakeInvoker {
  const calls: WorkflowInvokeActionRequest[] = [];
  const contexts: ActionInvocationContext[] = [];
  return {
    calls,
    contexts,
    deps: (db) => ({
      db,
      webBaseUrl: WEB,
      invokeAction: async (req, ctx) => {
        calls.push(req);
        contexts.push(ctx);
        return program(req);
      },
    }),
  };
}

const GITHUB_OK: WorkflowInvokeActionResult = {
  ok: true,
  result: { number: 7, html_url: "https://github.com/acme/api/issues/7" },
};

describe("security issue filing", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("returns the existing link on a repeat, without invoking the provider", async () => {
    const invoker = fakeInvoker(() => GITHUB_OK);
    await db.insert(securityFindingLinks).values({
      id: "lnk_existing",
      findingId: "fnd_1",
      engagementId: ENGAGEMENT.id,
      provider: "github",
      externalId: "3",
      url: "https://github.com/acme/api/issues/3",
      createdBy: "u_0",
      createdAt: 500,
    });

    const filed = await fileFindingIssue(invoker.deps(db), {
      engagement: ENGAGEMENT,
      finding: finding({ id: "fnd_1" }),
      provider: "github",
      actor: ACTOR,
    });

    expect(filed.created).toBe(false);
    expect(filed.link.id).toBe("lnk_existing");
    expect(filed.link.url).toBe("https://github.com/acme/api/issues/3");
    // Idempotency FIRST: the provider is never touched.
    expect(invoker.calls).toHaveLength(0);
  });

  it("github happy path: maps number/html_url into the link row", async () => {
    const invoker = fakeInvoker(() => GITHUB_OK);
    const row = finding({ id: "fnd_1" });

    const filed = await fileFindingIssue(invoker.deps(db), {
      engagement: ENGAGEMENT,
      finding: row,
      provider: "github",
      actor: ACTOR,
    });

    expect(filed.created).toBe(true);
    expect(filed.link.provider).toBe("github");
    expect(filed.link.externalId).toBe("7");
    expect(filed.link.url).toBe("https://github.com/acme/api/issues/7");
    expect(filed.link.createdBy).toBe("u_1");

    // The invoker got github.create_issue against the engagement repo, as
    // the ACTING user.
    expect(invoker.calls).toHaveLength(1);
    const req = invoker.calls[0];
    expect(req.service).toBe("github");
    expect(req.action).toBe("create_issue");
    expect(req.params.owner).toBe("acme");
    expect(req.params.repo).toBe("api");
    expect(req.params.title).toBe("[high] IDOR on sessions");
    const body = req.params.body;
    expect(typeof body).toBe("string");
    // Blob permalink at the pinned SHA + Evidence heading + valet permalink.
    expect(body).toContain(`https://github.com/acme/api/blob/${SHA}/src/routes/sessions.ts#L42`);
    expect(body).toContain("## Evidence");
    expect(body).toContain(row.body);
    expect(body).toContain(`${WEB}/sessions/sess_1?finding=fnd_1`);
    expect(invoker.contexts[0]).toMatchObject({
      userId: "u_1",
      orgId: "org_1",
      owner: { type: "user", id: "u_1" },
    });

    // The row landed once.
    const rows = await db.select().from(securityFindingLinks);
    expect(rows).toHaveLength(1);
  });

  it("github honors the repo override", async () => {
    const invoker = fakeInvoker(() => GITHUB_OK);
    await fileFindingIssue(invoker.deps(db), {
      engagement: ENGAGEMENT,
      finding: finding({ id: "fnd_1" }),
      provider: "github",
      actor: ACTOR,
      repo: "acme/tracker",
    });
    expect(invoker.calls[0].params.owner).toBe("acme");
    expect(invoker.calls[0].params.repo).toBe("tracker");
  });

  it("linear requires a team: 400-shaped error, no provider call", async () => {
    const invoker = fakeInvoker(() => GITHUB_OK);
    await expect(
      fileFindingIssue(invoker.deps(db), {
        engagement: ENGAGEMENT,
        finding: finding({ id: "fnd_1" }),
        provider: "linear",
        actor: ACTOR,
      }),
    ).rejects.toThrow(new IssueRequestError("Pick a Linear team for this engagement."));
    expect(invoker.calls).toHaveLength(0);
  });

  it("linear happy path: invokes create_issue with the team and parses the MCP text result", async () => {
    const invoker = fakeInvoker(() => ({
      ok: true,
      // The Linear MCP action returns text content — often JSON text.
      result: JSON.stringify({
        identifier: "SEC-12",
        url: "https://linear.app/acme/issue/SEC-12/idor-on-sessions",
      }),
    }));

    const filed = await fileFindingIssue(invoker.deps(db), {
      engagement: ENGAGEMENT,
      finding: finding({ id: "fnd_1" }),
      provider: "linear",
      actor: ACTOR,
      teamId: "team_sec",
    });

    expect(filed.created).toBe(true);
    expect(filed.link.provider).toBe("linear");
    expect(filed.link.externalId).toBe("SEC-12");
    expect(filed.link.url).toBe("https://linear.app/acme/issue/SEC-12/idor-on-sessions");
    const req = invoker.calls[0];
    expect(req.service).toBe("linear");
    expect(req.action).toBe("create_issue");
    expect(req.params.team).toBe("team_sec");
    expect(req.params.title).toBe("[high] IDOR on sessions");
  });

  it("linear prose result: scrapes the issue URL and identifier", async () => {
    const invoker = fakeInvoker(() => ({
      ok: true,
      result: "Created issue SEC-13: see https://linear.app/acme/issue/SEC-13/x.",
    }));
    const filed = await fileFindingIssue(invoker.deps(db), {
      engagement: ENGAGEMENT,
      finding: finding({ id: "fnd_1" }),
      provider: "linear",
      actor: ACTOR,
      teamId: "team_sec",
    });
    expect(filed.link.externalId).toBe("SEC-13");
    expect(filed.link.url).toBe("https://linear.app/acme/issue/SEC-13/x");
  });

  it("maps a thrown 'no credential connected' to the Linear corrective copy", async () => {
    const deps: SecurityIssuesDeps = {
      db,
      webBaseUrl: WEB,
      invokeAction: async () => {
        // mcpActionPlugin.resolveActions throws this before any action exists.
        throw new Error("linear: no credential connected");
      },
    };
    await expect(
      fileFindingIssue(deps, {
        engagement: ENGAGEMENT,
        finding: finding({ id: "fnd_1" }),
        provider: "linear",
        actor: ACTOR,
        teamId: "team_sec",
      }),
    ).rejects.toThrow(new MissingIntegrationError("Connect the Linear integration in Settings."));
    // No link row for a failed filing.
    expect(await db.select().from(securityFindingLinks)).toHaveLength(0);
  });

  it("maps the github missing-token error result to the GitHub corrective copy", async () => {
    const invoker = fakeInvoker(() => ({
      ok: false,
      error: "Missing GitHub access token. Connect the GitHub integration in Settings.",
    }));
    await expect(
      fileFindingIssue(invoker.deps(db), {
        engagement: ENGAGEMENT,
        finding: finding({ id: "fnd_1" }),
        provider: "github",
        actor: ACTOR,
      }),
    ).rejects.toThrow(new MissingIntegrationError("Connect the GitHub integration in Settings."));
  });

  it("digest: one issue, every finding listed with its permalink, NO link rows", async () => {
    const invoker = fakeInvoker(() => GITHUB_OK);
    const findings = [
      finding({ id: "fnd_1", title: "IDOR on sessions" }),
      finding({ id: "fnd_2", title: "verbose logging", file: null, line: null, severity: "low" }),
    ];

    const digest = await fileDigestIssue(invoker.deps(db), {
      engagement: ENGAGEMENT,
      findings,
      provider: "github",
      actor: ACTOR,
    });

    expect(digest.url).toBe("https://github.com/acme/api/issues/7");
    expect(invoker.calls).toHaveLength(1);
    const req = invoker.calls[0];
    expect(req.params.title).toBe("Valet Security: 2 findings — acme/api");
    const body = req.params.body;
    expect(typeof body === "string" && body).toContain("- [ ] [high] IDOR on sessions");
    expect(body).toContain("`src/routes/sessions.ts:42`");
    expect(body).toContain("- [ ] [low] verbose logging");
    expect(body).toContain(`${WEB}/sessions/sess_1?finding=fnd_1`);
    expect(body).toContain(`${WEB}/sessions/sess_1?finding=fnd_2`);

    // The digest is not per-finding linkage.
    expect(await db.select().from(securityFindingLinks)).toHaveLength(0);
  });

  it("digest with no findings is a request error", async () => {
    const invoker = fakeInvoker(() => GITHUB_OK);
    await expect(
      fileDigestIssue(invoker.deps(db), {
        engagement: ENGAGEMENT,
        findings: [],
        provider: "github",
        actor: ACTOR,
      }),
    ).rejects.toThrow(IssueRequestError);
  });

  it("createIssueViaProvider refuses a malformed github repo", async () => {
    const invoker = fakeInvoker(() => GITHUB_OK);
    await expect(
      createIssueViaProvider(invoker.deps(db), {
        provider: "github",
        actor: ACTOR,
        title: "t",
        body: "b",
        repoFullName: "not-owner-repo",
      }),
    ).rejects.toThrow(IssueRequestError);
    expect(invoker.calls).toHaveLength(0);
  });
});

describe("issue body builders", () => {
  it("blob permalink carries the line anchor only when a line exists", () => {
    expect(blobPermalink("acme/api", SHA, "src/a.ts", 7)).toBe(
      `https://github.com/acme/api/blob/${SHA}/src/a.ts#L7`,
    );
    expect(blobPermalink("acme/api", SHA, "src/a.ts", null)).toBe(
      `https://github.com/acme/api/blob/${SHA}/src/a.ts`,
    );
  });

  it("omits the Location line for a file-less finding", () => {
    const body = buildIssueBody({
      finding: finding({ id: "fnd_1", file: null, line: null }),
      repoFullName: "acme/api",
      repoRef: SHA,
      valetPermalink: `${WEB}/sessions/sess_1?finding=fnd_1`,
    });
    expect(body).not.toContain("Location:");
    expect(body).not.toContain("/blob/");
    expect(body).toContain("## Evidence");
  });

  it("title carries severity and the finding title", () => {
    expect(buildIssueTitle(finding({ id: "f", severity: "critical", title: "RCE" }))).toBe(
      "[critical] RCE",
    );
  });

  it("permalink trims trailing slashes off the web base", () => {
    expect(findingPermalink("https://x.test/", "s1", "f1")).toBe(
      "https://x.test/sessions/s1?finding=f1",
    );
  });

  it("digest body handles a location-less finding", () => {
    const body = buildDigestBody({
      findings: [finding({ id: "f1", file: null, line: null })],
      repoFullName: "acme/api",
      repoRef: SHA,
      permalinkFor: (id) => `${WEB}/f/${id}`,
    });
    expect(body).toContain("- [ ] [high] IDOR on sessions —");
    expect(body).not.toContain("()");
  });
});
