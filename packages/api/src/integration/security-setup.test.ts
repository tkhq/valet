/**
 * Pre-creation setup flow (valet-security design §Web Surfaces, Deviations):
 * the setup page's preview endpoint + the create route's config/plan overrides.
 *
 *   - POST /sessions/security/preview returns the seeded config + plan and
 *     creates NOTHING.
 *   - Create with `securityConfig` + `planCells` overrides stores the config
 *     columns, uses the edited plan, and materializes the engagement to running
 *     (the setup page's "Start review" click is the spend approval).
 *   - A create with no overrides still works and stays planning (regression).
 *   - A `triad: true` step round-trips through create → cells (expandTriads).
 *
 * No engine turns and no ANTHROPIC_API_KEY: create resolves a 40-hex ref
 * without a GitHub lookup, so start is offline-deterministic.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { securityCells, securityEngagements } from "../schema/index.js";
import {
  OnePasswordAuthError,
  type OnePasswordScope,
  type OnePasswordService,
} from "../services/onepassword.js";
import { createTeam } from "../services/teams.js";
import { contentsBody, startGithubFixture } from "../test-helpers/github-fixture.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  SecurityPlanCellInput,
  SecurityPreviewRequest,
  SecurityPreviewResponse,
} from "../wire/types.js";

/** A fake 40-hex SHA the start path accepts without a GitHub lookup. */
const FAKE_SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: FAKE_SHA };

/** A repo config declaring one credential. The reference is well formed, so
 * the config parses and the preflight is what has to resolve it. */
const REPO_CREDENTIALS_YAML = `version: 1
credentials:
  - label: admin
    kind: password
    env: ADMIN_PASSWORD
    reference: op://Sec/Admin/password
`;

/**
 * Boot an api whose GitHub serves the config above and whose 1Password
 * refuses every reference, recording the scopes it was asked for. `scopesSeen`
 * is how a test asserts which owner the preview evaluated.
 */
async function withSecurityYamlFixture(
  run: (ctx: {
    api: TestApi;
    scopesSeen: OnePasswordScope[];
    preview: (body: SecurityPreviewRequest) => Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  const fixture = startGithubFixture({
    getContents: (_owner, _repo, path) =>
      path === ".valet/security.yml"
        ? contentsBody(REPO_CREDENTIALS_YAML, "blob-security-yml")
        : { status: 404, body: { message: "Not Found" } },
  });
  const scopesSeen: OnePasswordScope[] = [];
  const onePassword: OnePasswordService = {
    tokenConnected: async () => true,
    listVaults: async () => [],
    resolveReference: async (scope) => {
      scopesSeen.push(scope);
      throw new OnePasswordAuthError("no such item", "reference");
    },
    resolveCredential: async (row) => row,
    findCandidates: async () => [],
    findCredentialForService: async () => null,
  };
  const prevGithubApiUrl = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = fixture.url;
  const api = await bootTestApi({ onePassword });
  try {
    await run({
      api,
      scopesSeen,
      preview: (body) =>
        fetch(`${api.baseUrl}/api/sessions/security/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    });
  } finally {
    await api.cleanup();
    await fixture.close();
    if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = prevGithubApiUrl;
  }
}

describe("api integration: security setup flow", () => {
  it("preview returns config + planCells and creates no session", async () => {
    const api = await bootTestApi();
    try {
      const before = await api.providers.db.select().from(securityEngagements);
      const res = await fetch(`${api.baseUrl}/api/sessions/security/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "acme/api", preset: "code-review" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecurityPreviewResponse;
      // No repo config offline → the preset plan, hasRepoConfig false.
      expect(body.config.hasRepoConfig).toBe(false);
      expect(body.planCells.map((c) => c.name)).toEqual([
        "recon",
        "authz-sweep",
        "injection-sweep",
        "secrets-config",
        "verify",
        "report",
      ]);
      // The preview created nothing.
      const after = await api.providers.db.select().from(securityEngagements);
      expect(after.length).toBe(before.length);
    } finally {
      await api.cleanup();
    }
  });

  it("preview warns about a repo-declared credential that fails preflight", async () => {
    // A repo-declared credential takes the same preflight as a request-declared
    // one. The preview REPORTS the failure and still returns the declarations;
    // create is the gate that refuses.
    await withSecurityYamlFixture(async ({ preview, scopesSeen }) => {
      const res = await preview({ repo: "acme/api", preset: "code-review" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecurityPreviewResponse;
      expect(body.credentialWarnings).toHaveLength(1);
      expect(body.credentialWarnings[0]?.label).toBe("admin");
      // The remedy names the corrective action, never the resolved value.
      expect(body.credentialWarnings[0]?.message).toMatch(/Update the reference/);
      // The declarations still reach the wizard, so the page is usable.
      expect(body.config.credentials).toEqual([
        { label: "admin", kind: "password", env: "ADMIN_PASSWORD", reference: "op://Sec/Admin/password" },
      ]);
      // A user-owned preview never consults a team token.
      expect(scopesSeen).toEqual(["org", "personal"]);
    });
  });

  it("preview evaluates credential scopes as the named team", async () => {
    await withSecurityYamlFixture(async ({ preview, scopesSeen, api }) => {
      const team = await createTeam(api.providers.db, {
        orgId: "local-org",
        creatorUserId: "local-user",
        name: "Platform",
      });
      const res = await preview({ repo: "acme/api", preset: "code-review", teamId: team.id });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecurityPreviewResponse;
      expect(body.credentialWarnings).toHaveLength(1);
      // A configured team token is authoritative, so team is tried first and a
      // refusal that is not "no token" never falls through to org.
      expect(scopesSeen).toEqual(["team"]);
    });
  });

  it("preview refuses a team the caller does not belong to", async () => {
    await withSecurityYamlFixture(async ({ preview, scopesSeen }) => {
      const res = await preview({ repo: "acme/api", preset: "code-review", teamId: "team-of-someone-else" });
      expect(res.status).toBe(404);
      // No vault token was consulted for a team the caller cannot name.
      expect(scopesSeen).toEqual([]);
    });
  });

  it("preview rejects a non-owner/repo shaped repo", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/sessions/security/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "not-a-repo", preset: "code-review" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  });

  it("create with planCells + securityConfig stores them and starts running", async () => {
    const api = await bootTestApi();
    try {
      const cells: SecurityPlanCellInput[] = [
        { persona: "code-review", name: "recon", goal: "Map the tree", reads: [] },
        // A triad step: expandTriads turns it into three materialized cells.
        {
          persona: "code-review",
          name: "authz",
          goal: "Sweep authz",
          playbook: "authz",
          reads: [1],
          triad: true,
        },
        {
          persona: "code-review",
          name: "verify",
          goal: "Attack open findings",
          reads: [1, 2],
          review: true,
        },
      ];
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: "/tmp/valet-security-setup",
          kind: "security",
          repo: REPO,
          securityConfig: {
            focus: "the multi-tenant data path",
            invariants: ["every admin route sits behind requireAdmin"],
            categories: ["authz"],
          },
          planCells: cells,
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as CreateSessionResponse;

      // The auto-title names the repo and the pinned ref, shortened to 7 chars.
      expect(created.title).toBe(`Security review · acme/api@${FAKE_SHA.slice(0, 7)}`);

      const security = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`)
      ).json()) as GetSessionSecurityResponse;

      // The config columns carry the setup-page overrides.
      expect(security.engagement.focus).toBe("the multi-tenant data path");
      expect(security.engagement.invariants).toEqual(["every admin route sits behind requireAdmin"]);
      expect(security.engagement.categories).toEqual(["authz"]);
      // A preset-only review with user overrides is NOT a repo config.
      expect(security.engagement.hasRepoConfig).toBe(false);

      // The engagement materialized to running — no editable planning limbo.
      expect(security.engagement.status).toBe("running");
      expect(security.engagement.repoRef).toBe(FAKE_SHA);

      // The triad step expanded into architect → worker → verifier; the plain
      // steps stayed single. So 1 (recon) + 3 (authz triad) + 1 (verify) = 5.
      const dbCells = await api.providers.db
        .select()
        .from(securityCells)
        .where(eq(securityCells.engagementId, security.engagement.id));
      expect(dbCells.length).toBe(5);
      const personas = dbCells.sort((a, b) => a.ordinal - b.ordinal).map((c) => c.persona);
      expect(personas).toEqual(["code-review", "architect", "code-review", "verifier", "code-review"]);
    } finally {
      await api.cleanup();
    }
  });

  it("create with no overrides still works and stays planning (regression)", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: "/tmp/valet-security-setup-plain",
          kind: "security",
          repo: REPO,
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as CreateSessionResponse;
      const security = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`)
      ).json()) as GetSessionSecurityResponse;
      // No overrides → the runner-driven start, so the engagement stays planning
      // until sec_start, and the default preset plan seeds it.
      expect(security.engagement.status).toBe("planning");
      expect(security.planCells.map((c) => c.name)).toEqual([
        "recon",
        "authz-sweep",
        "injection-sweep",
        "secrets-config",
        "verify",
        "report",
      ]);
    } finally {
      await api.cleanup();
    }
  });

  it("create with declared credentials preflights and stores credentials_json", async () => {
    const resolved: Record<string, string> = {
      "op://Sec/Admin/password": "correct-horse-battery",
      "op://Sec/Api/token": "abcdefgh-bearer-token",
    };
    const onePassword: OnePasswordService = {
      tokenConnected: async () => true,
      listVaults: async () => [],
      resolveReference: async (_scope, _ctx, reference) => resolved[reference] ?? "",
      resolveCredential: async (row) => row,
      findCandidates: async () => [],
      findCredentialForService: async () => null,
    };
    const api = await bootTestApi({ onePassword });
    try {
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: "/tmp/valet-security-setup-creds",
          kind: "security",
          repo: REPO,
          securityConfig: {
            credentials: [
              { label: "admin", env: "ADMIN_PASSWORD", reference: "op://Sec/Admin/password", kind: "password" },
              { label: "api-token", env: "API_TOKEN", reference: "op://Sec/Api/token", kind: "headerToken" },
            ],
          },
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as CreateSessionResponse;

      // Preflight-validated references only (INV-37), never a resolved value.
      const rows = await api.providers.db
        .select()
        .from(securityEngagements)
        .where(eq(securityEngagements.sessionId, created.id));
      expect(rows[0]?.credentialsJson).toEqual([
        { label: "admin", env: "ADMIN_PASSWORD", reference: "op://Sec/Admin/password", kind: "password" },
        { label: "api-token", env: "API_TOKEN", reference: "op://Sec/Api/token", kind: "headerToken" },
      ]);
    } finally {
      await api.cleanup();
    }
  });

  it("create with no declared credentials leaves credentials_json null", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: "/tmp/valet-security-setup-creds-empty",
          kind: "security",
          repo: REPO,
          securityConfig: { credentials: [] },
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as CreateSessionResponse;
      const rows = await api.providers.db
        .select()
        .from(securityEngagements)
        .where(eq(securityEngagements.sessionId, created.id));
      expect(rows[0]?.credentialsJson).toBeNull();
    } finally {
      await api.cleanup();
    }
  });

  it.each([
    ["invalid label", [{ label: "-admin", env: "ADMIN", reference: "op://Sec/Admin/field", kind: "password" }], /Label "-admin" is not valid/],
    ["reserved label", [{ label: "valet-secrets", env: "ADMIN", reference: "op://Sec/Admin/field", kind: "password" }], /reserved/],
    ["duplicate label", [
      { label: "admin", env: "ADMIN_A", reference: "op://Sec/AdminA/field", kind: "password" },
      { label: "admin", env: "ADMIN_B", reference: "op://Sec/AdminB/field", kind: "password" },
    ], /declared more than once/],
    ["unknown kind", [{ label: "x", env: "X_TOKEN", reference: "op://Sec/X/field", kind: "bogus" }], /unknown kind/],
    // INV-33 preflight: a malformed op:// reference refuses before any resolve
    // attempt. INV-37: the corrective remedy names the fix, never the resolved value.
    ["bad op:// reference", [{ label: "x", env: "X_TOKEN", reference: "not-an-op-reference", kind: "password" }], /not a valid op:\/\/ path/],
  ])("create rejects %s before preflight", async (_name, credentials, expected) => {
    const api = await bootTestApi();
    try {
      const res = await fetch(api.baseUrl + "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: "/tmp/valet-security-setup-creds-invalid",
          kind: "security",
          repo: REPO,
          securityConfig: { credentials },
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(expected);
    } finally {
      await api.cleanup();
    }
  });
});
