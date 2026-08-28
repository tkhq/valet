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
import { bootTestApi } from "./_setup.js";
import { securityCells, securityEngagements } from "../schema/index.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  SecurityPlanCellInput,
  SecurityPreviewResponse,
} from "../wire/types.js";

/** A fake 40-hex SHA the start path accepts without a GitHub lookup. */
const FAKE_SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: FAKE_SHA };

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
      ]);
      // The preview created nothing.
      const after = await api.providers.db.select().from(securityEngagements);
      expect(after.length).toBe(before.length);
    } finally {
      await api.cleanup();
    }
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
      ]);
    } finally {
      await api.cleanup();
    }
  });
});
