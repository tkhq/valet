/**
 * Finding comments carried into a re-scan (M-F4, valet-security design
 * §Re-scan / iterate). Proves:
 *   - the service inserts a note and lists notes oldest-first (thread order);
 *   - a parent finding's notes ride into the child engagement's
 *     /prior/findings.md, so the persona sees the prior human reasoning;
 *   - the comment route is view-gated (any viewer, NOT admin-only), human-only
 *     (the internal token is refused), and rejects a foreign finding;
 *   - the findings list surfaces `comments` per finding.
 *
 * No ANTHROPIC_API_KEY and no model turn: the parent engagement is started at
 * the service level and the re-scan is created with `rescanOf`.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import { securityFindings, teamMembers, teams } from "../schema/index.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  ListSecurityFindingsResponse,
  SecurityAddFindingCommentResponse,
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
      workspace: `/tmp/valet-sec-comments-${randomUUID()}`,
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
  id: string,
): Promise<void> {
  await api.providers.db.insert(securityFindings).values({
    id,
    engagementId,
    cellId: "cell_x",
    fingerprint: `fp_${id}`,
    severity: "high",
    title: "IDOR on sessions",
    file: "src/routes/sessions.ts",
    line: 42,
    body: EVIDENCE,
    status: "open",
    createdAt: Date.now(),
  });
}

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("api integration: security finding comments (M-F4)", () => {
  it("service inserts a note and lists notes oldest-first", async () => {
    const api = await bootTestApi();
    try {
      const { engagementId } = await createSecuritySession(api.baseUrl);
      await seedFinding(api, engagementId, "fnd_1");
      // A monotonic clock so the two notes land on distinct timestamps —
      // thread order is (created_at, id), and two same-ms inserts would tie.
      let clock = Date.now();
      const service = createSecurityEngagementService({
        db: api.providers.db,
        now: () => clock++,
      });

      const first = await service.addFindingComment(engagementId, {
        findingId: "fnd_1",
        body: "Intended — the check lives in middleware X.",
        authorUserId: "user-a",
      });
      const second = await service.addFindingComment(engagementId, {
        findingId: "fnd_1",
        body: "Confirm this is fixed next scan.",
        authorUserId: "user-b",
      });
      expect(first.id).not.toBe(second.id);

      const notes = await service.listFindingComments(engagementId, { findingId: "fnd_1" });
      expect(notes.map((n) => n.body)).toEqual([
        "Intended — the check lives in middleware X.",
        "Confirm this is fixed next scan.",
      ]);
      expect(notes[0].authorUserId).toBe("user-a");

      // Empty body refuses with a corrective message.
      await expect(
        service.addFindingComment(engagementId, {
          findingId: "fnd_1",
          body: "   ",
          authorUserId: "user-a",
        }),
      ).rejects.toThrow(/needs a body/);
    } finally {
      await api.cleanup();
    }
  });

  it("carries a parent finding's notes into the child's /prior/findings.md", async () => {
    const api = await bootTestApi();
    try {
      // Parent engagement with a finding + a human note.
      const parent = await createSecuritySession(api.baseUrl);
      await seedFinding(api, parent.engagementId, "fnd_parent");
      const service = createSecurityEngagementService({ db: api.providers.db });
      await service.startEngagement(parent.engagementId, {
        resolvedSha: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
      });
      await service.addFindingComment(parent.engagementId, {
        findingId: "fnd_parent",
        body: "Intended by design — auth is enforced upstream in middleware X.",
        authorUserId: "user-a",
      });

      // A re-scan child of the parent session.
      const rescanRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: `/tmp/valet-sec-rescan-${randomUUID()}`,
          kind: "security",
          rescanOf: parent.session.id,
        }),
      });
      expect(rescanRes.status).toBe(201);
      const rescan = (await rescanRes.json()) as CreateSessionResponse;
      const child = await service.getEngagementBySession(rescan.id);
      expect(child).not.toBeNull();

      // The digest the persona reads carries the human note under "Notes:".
      const digest = await service.readFile(child!.engagement.id, "/prior/findings.md");
      expect(digest.content).toContain("IDOR on sessions");
      expect(digest.content).toContain("Notes:");
      expect(digest.content).toContain(
        "team note: Intended by design — auth is enforced upstream in middleware X.",
      );
    } finally {
      await api.cleanup();
    }
  });

  it("comment route: any viewer may comment, internal token refused, foreign finding rejected", async () => {
    const api = await bootTestApi();
    try {
      const now = Date.now();
      await api.providers.db
        .insert(teams)
        .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
      // local-user (org admin) creates; test-member is a plain viewer.
      await api.providers.db.insert(teamMembers).values([
        { teamId: "team_1", userId: "local-user", role: "member" },
        { teamId: "team_1", userId: "test-member", role: "member" },
      ]);

      const { session, engagementId } = await createSecuritySession(api.baseUrl, {
        teamId: "team_1",
      });
      await seedFinding(api, engagementId, "fnd_1");
      const commentsUrl = `${api.baseUrl}/api/sessions/${session.id}/security/findings/fnd_1/comments`;

      // The internal token is refused — commenting is a human action.
      const asRunner = await postJson(commentsUrl, { body: "x" }, {
        "x-valet-internal": internalToken(),
      });
      expect(asRunner.status).toBe(403);
      expect(((await asRunner.json()) as { error: string }).error).toContain("human");

      // A plain viewer (no admin right) MAY comment — not admin-gated.
      const asMember = await postJson(commentsUrl, { body: "This looks intended to me." }, {
        "x-valet-test-user-id": "test-member",
      });
      expect(asMember.status).toBe(200);
      const created = (await asMember.json()) as SecurityAddFindingCommentResponse;
      expect(created.comment.body).toBe("This looks intended to me.");
      expect(created.comment.authorUserId).toBe("test-member");

      // Empty body → 400 naming the fix.
      const empty = await postJson(commentsUrl, { body: "  " }, {
        "x-valet-test-user-id": "test-member",
      });
      expect(empty.status).toBe(400);

      // A foreign finding id → 404.
      const foreign = await postJson(
        `${api.baseUrl}/api/sessions/${session.id}/security/findings/fnd_missing/comments`,
        { body: "hi" },
        { "x-valet-test-user-id": "test-member" },
      );
      expect(foreign.status).toBe(404);

      // The findings list surfaces the note per finding.
      const list = await fetch(`${api.baseUrl}/api/sessions/${session.id}/security/findings`);
      const listBody = (await list.json()) as ListSecurityFindingsResponse;
      const finding = listBody.findings.find((f) => f.id === "fnd_1");
      expect(finding?.comments).toHaveLength(1);
      expect(finding?.comments?.[0].body).toBe("This looks intended to me.");
    } finally {
      await api.cleanup();
    }
  });
});
