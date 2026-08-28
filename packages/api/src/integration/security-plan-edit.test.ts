/**
 * Structured plan-edit route + planCells read (dynamic-config M-F2): the step
 * editor's read/write path. GET /security carries `planCells` parsed from the
 * plan; POST /security/plan/cells assigns dense ordinals, serializes, and
 * setPlan persists. No engine turns and no ANTHROPIC_API_KEY.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_PERSONAS, parsePlan } from "@valet/plugin-security";
import { eq } from "drizzle-orm";
import { bootTestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { securityEngagements, users } from "../schema/index.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  SecurityPlanCellInput,
  SecuritySetPlanResponse,
} from "../wire/types.js";

const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git" };

async function createSecuritySession(baseUrl: string): Promise<CreateSessionResponse> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp/valet-security-plan-edit", kind: "security", repo: REPO }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateSessionResponse;
}

function postCells(baseUrl: string, id: string, cells: SecurityPlanCellInput[], headers?: Record<string, string>) {
  return fetch(`${baseUrl}/api/sessions/${id}/security/plan/cells`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify({ cells }),
  });
}

describe("api integration: structured plan edit", () => {
  it("GET /security parses the plan into planCells", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const res = await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`);
      const body = (await res.json()) as GetSessionSecurityResponse;
      // The default code-review plan parses back into planCells, ending in the
      // report cell (M-P3).
      expect(body.planCells.map((c) => c.name)).toEqual([
        "recon",
        "authz-sweep",
        "injection-sweep",
        "secrets-config",
        "verify",
        "report",
      ]);
      expect(body.planCells[0].ordinal).toBe(1);
      expect(body.planCells[0].reads).toEqual([]);
      // Verify (second-to-last) reviews and reads the four earlier sweeps.
      const verify = body.planCells[body.planCells.length - 2];
      expect(verify.name).toBe("verify");
      expect(verify.review).toBe(true);
      expect(verify.reads).toEqual([1, 2, 3, 4]);
      // The report cell is last and reads every prior ordinal.
      const last = body.planCells[body.planCells.length - 1];
      expect(last.name).toBe("report");
      expect(last.reads).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await api.cleanup();
    }
  });

  it("assigns dense ordinals, serializes, and persists a plan that round-trips", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const cells: SecurityPlanCellInput[] = [
        { persona: "code-review", name: "map", goal: "Map the tree", reads: [] },
        { persona: "code-review", name: "authz", goal: "Sweep authz", playbook: "authz", reads: [1] },
        {
          persona: "code-review",
          name: "verify",
          goal: "Attack open findings",
          reads: [1, 2],
          review: true,
        },
      ];
      const res = await postCells(api.baseUrl, created.id, cells);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecuritySetPlanResponse;
      expect(body.cellCount).toBe(3);

      // The persisted plan parses back to the same cells with dense ordinals.
      const sec = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`)
      ).json()) as GetSessionSecurityResponse;
      const plan = parsePlan(sec.engagement.plan, KNOWN_PERSONAS);
      expect(plan.cells.map((c) => c.ordinal)).toEqual([1, 2, 3]);
      expect(plan.cells.map((c) => c.name)).toEqual(["map", "authz", "verify"]);
      expect(plan.cells[1].playbook).toBe("authz");
      expect(plan.cells[1].reads).toEqual([1]);
      expect(plan.cells[2].review).toBe(true);
      expect(plan.cells[2].reads).toEqual([1, 2]);

      // planCells mirrors it for the editor.
      expect(sec.planCells.map((c) => c.name)).toEqual(["map", "authz", "verify"]);
    } finally {
      await api.cleanup();
    }
  });

  it("rejects an unknown persona, naming the corrective action", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const res = await postCells(api.baseUrl, created.id, [
        { persona: "no-such-persona", goal: "Do a thing", reads: [] },
      ]);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("no-such-persona");
    } finally {
      await api.cleanup();
    }
  });

  it("rejects reads that name a later step", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const res = await postCells(api.baseUrl, created.id, [
        { persona: "code-review", goal: "First", reads: [2] },
        { persona: "code-review", goal: "Second", reads: [] },
      ]);
      // The plan-level rule (reads name earlier ordinals only) is enforced by
      // parsePlan inside setPlan and surfaces as a 409 with the corrective text.
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("earlier");
    } finally {
      await api.cleanup();
    }
  });

  it("refuses to edit a running engagement, surfacing the immutable-plan error", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const sec = (await (
        await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`)
      ).json()) as GetSessionSecurityResponse;
      // Flip the engagement to running directly — the plan is frozen once it
      // is not planning.
      await api.providers.db
        .update(securityEngagements)
        .set({ status: "running" })
        .where(eq(securityEngagements.id, sec.engagement.id));

      const res = await postCells(api.baseUrl, created.id, [
        { persona: "code-review", goal: "Too late", reads: [] },
      ]);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("immutable");
    } finally {
      await api.cleanup();
    }
  });

  it("refuses a non-admin, non-internal caller with the existence-hiding 404", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      const { db } = api.providers;
      await db.insert(users).values({ id: "intruder", email: "intruder@x.test", name: "I", role: "member" });
      const res = await postCells(
        api.baseUrl,
        created.id,
        [{ persona: "code-review", goal: "Sneak", reads: [] }],
        { "x-valet-test-user-id": "intruder" },
      );
      expect(res.status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });

  it("admits a human admin (the session owner) on the mutate ladder", async () => {
    const api = await bootTestApi();
    try {
      const created = await createSecuritySession(api.baseUrl);
      // No internal token, no acting-session header — the default stub user is
      // the owner (role admin), so the mutate ladder admits it.
      const res = await postCells(api.baseUrl, created.id, [
        { persona: "code-review", goal: "One step", reads: [] },
      ]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SecuritySetPlanResponse;
      expect(body.cellCount).toBe(1);
    } finally {
      await api.cleanup();
    }
  });
});
