/**
 * Security session minting + read routes: kind on create/list, the
 * engagement seeded in the create transaction, the dual-auth ladder on
 * GET /:id/security, and the findings filters. No engine turns and no
 * ANTHROPIC_API_KEY — nothing here prompts.
 */
import { describe, expect, it } from "vitest";
import { bootTestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { securityFindings, users } from "../schema/index.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  ListSecurityFindingsResponse,
  ListSessionsResponse,
} from "../wire/types.js";

const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git" };

/** A body long enough to clear the 200-character evidence floor. */
const EVIDENCE = `The route reads the session id from the URL and never checks ownership. Excerpt: db.select().from(sessions).where(eq(sessions.id, id)) — any authenticated caller can read any session, which leaks other tenants' transcripts.`;

async function createSecuritySession(baseUrl: string): Promise<CreateSessionResponse> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp/valet-security-routes-test", kind: "security", repo: REPO }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateSessionResponse;
}

describe("api integration: security session minting + read routes", () => {
  it("mints a security session with its engagement seeded in the create transaction", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      expect(created.kind).toBe("security");

      const res = await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as GetSessionSecurityResponse;
      expect(body.engagement.status).toBe("planning");
      expect(body.engagement.repoFullName).toBe(REPO.fullName);
      expect(body.engagement.plan).toContain("code-review");
      // Cells materialize at sec_start, not at create.
      expect(body.cells).toEqual([]);
      // The engagement carries its spend (spec §engagement cost); a planning
      // review with no turns reports zeros.
      expect(body.cost).toEqual({ costUsd: 0, totalTokens: 0, priced: true });

      // The detail route reports the kind too.
      const detail = await fetch(`${api.baseUrl}/api/sessions/${created.id}`);
      const detailBody = (await detail.json()) as CreateSessionResponse;
      expect(detailBody.kind).toBe("security");
    } finally {
      await api.cleanup();
    }
  });

  it("refuses a security session without a repo binding, naming the fix", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp/valet-security-routes-test", kind: "security" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("A security review needs a repository. Pick one when you start the review.");
    } finally {
      await api.cleanup();
    }
  });

  it("filters the session list by kind and stamps kind on every summary", async () => {
    const api = await bootTestApi();
    try {
      await createSecuritySession(api.baseUrl);
      const code = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp/valet-security-routes-test-code" }),
      });
      expect(code.status).toBe(201);

      const all = (await (await fetch(`${api.baseUrl}/api/sessions`)).json()) as ListSessionsResponse;
      expect(all.sessions.map((s) => s.kind).sort()).toEqual(["code", "security"]);

      const onlySecurity = (await (
        await fetch(`${api.baseUrl}/api/sessions?kind=security`)
      ).json()) as ListSessionsResponse;
      expect(onlySecurity.sessions).toHaveLength(1);
      expect(onlySecurity.sessions[0].kind).toBe("security");
    } finally {
      await api.cleanup();
    }
  });

  it("404s with a corrective message when the session has no engagement", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp/valet-security-routes-test-code" }),
      });
      const created = (await res.json()) as CreateSessionResponse;
      const security = await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`);
      expect(security.status).toBe(404);
      const body = (await security.json()) as { error: string };
      expect(body.error).toBe(
        "This session has no security engagement. Create the session with kind 'security' to start one.",
      );
    } finally {
      await api.cleanup();
    }
  });

  it("gates reads on session view access; the internal token bypasses", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);

      // Another user (not the owner) gets the existence-hiding 404.
      const { db } = api.providers;
      await db.insert(users).values({ id: "intruder", email: "intruder@x.test", name: "I", role: "member" });
      const asIntruder = await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`, {
        headers: { "x-valet-test-user-id": "intruder" },
      });
      expect(asIntruder.status).toBe(404);

      // The internal token is the tools' path: no session user, still 200.
      const asInternal = await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`, {
        headers: { "x-valet-internal": internalToken() },
      });
      expect(asInternal.status).toBe(200);

      // A wrong token falls through to the session user (stub auth) — it
      // must never grant internal trust on its own.
      const wrongToken = await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`, {
        headers: { "x-valet-internal": "wrong-token" },
      });
      expect(wrongToken.status).toBe(200); // stub session user IS the owner
    } finally {
      await api.cleanup();
    }
  });

  it("lists findings with severity/status/path filters", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const { db } = api.providers;
      const security = await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`);
      const { engagement } = (await security.json()) as GetSessionSecurityResponse;

      // Seed rows directly — reporting goes through the persona tools (M4).
      const now = Date.now();
      await db.insert(securityFindings).values([
        {
          id: "fnd_a",
          engagementId: engagement.id,
          cellId: "cell_x",
          fingerprint: "fp_a",
          severity: "high" as const,
          title: "IDOR on sessions",
          file: "src/routes/sessions.ts",
          line: 42,
          body: EVIDENCE,
          status: "open" as const,
          createdAt: now,
        },
        {
          id: "fnd_b",
          engagementId: engagement.id,
          cellId: "cell_y",
          fingerprint: "fp_b",
          severity: "low" as const,
          title: "verbose logging",
          file: "src/lib/log.ts",
          line: 7,
          body: EVIDENCE,
          status: "refuted" as const,
          statusReason: "log level is gated",
          statusActor: "user:local-user",
          createdAt: now + 1,
        },
      ]);

      const all = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}/security/findings`)
      ).json()) as ListSecurityFindingsResponse;
      expect(all.findings).toHaveLength(2);
      expect(all.nextCursor).toBeNull();

      const high = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}/security/findings?severity=high`)
      ).json()) as ListSecurityFindingsResponse;
      expect(high.findings.map((f) => f.id)).toEqual(["fnd_a"]);

      const refuted = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}/security/findings?status=refuted`)
      ).json()) as ListSecurityFindingsResponse;
      expect(refuted.findings.map((f) => f.id)).toEqual(["fnd_b"]);

      const byPath = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}/security/findings?path=lib/log`)
      ).json()) as ListSecurityFindingsResponse;
      expect(byPath.findings.map((f) => f.id)).toEqual(["fnd_b"]);

      const badSeverity = await fetch(
        `${api.baseUrl}/api/sessions/${created.id}/security/findings?severity=terrible`,
      );
      expect(badSeverity.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  });
});

describe("api integration: security session model selection", () => {
  it("defaults a modelless security session to a capable model, not haiku", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      // The create route sets the model before the kickoff, which materializes
      // the session — so the detail route reports it.
      const detail = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}`)
      ).json()) as CreateSessionResponse;
      expect(detail.model).toBe("claude-sonnet-4-6");
      expect(detail.model).not.toBe("claude-haiku-4-5");
    } finally {
      await api.cleanup();
    }
  });

  it("uses an explicit model on a security create", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: "/tmp/valet-security-routes-test",
          kind: "security",
          repo: REPO,
          model: "claude-opus-4-7",
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as CreateSessionResponse;
      expect(created.model).toBe("claude-opus-4-7");

      const detail = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}`)
      ).json()) as CreateSessionResponse;
      expect(detail.model).toBe("claude-opus-4-7");
    } finally {
      await api.cleanup();
    }
  });

  it("rejects an empty model string, naming GET /api/models", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: "/tmp/valet-security-routes-test",
          kind: "security",
          repo: REPO,
          model: "",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("GET /api/models");
    } finally {
      await api.cleanup();
    }
  });

  it("leaves a modelless code session on normal resolution", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp/valet-security-routes-test-code" }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as CreateSessionResponse;
      // No model set at create: the code session was never materialized, so
      // the create response carries no session-default model.
      expect(created.model).toBeUndefined();
    } finally {
      await api.cleanup();
    }
  });
});
