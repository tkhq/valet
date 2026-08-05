/**
 * GET /api/usage/summary — cost attribution over the `cost_entries` view.
 *
 * The route reads the view, never `engine_entries` directly, so these cases
 * pin the behavior that view exists to guarantee: workflow-session spend is
 * counted, cache tokens are counted, an unpriced turn is reported as
 * unpriced instead of $0, and no other org's spend ever appears.
 */
import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { orchestratorSessionId } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import {
  agentSessions,
  orgMembers,
  orgs,
  users,
  workflowDefinitions,
  workflowRuns,
} from "../schema/index.js";
import type { UsageSummaryResponse } from "../wire/types.js";

const HOUR_MS = 60 * 60 * 1000;

interface TurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Writes one turn's final assistant entry straight into `engine_entries`.
 * `costTotal` null = the engine reported no price for the model. */
async function seedTurn(
  api: TestApi,
  opts: {
    id: string;
    sessionId: string;
    tokens: TurnTokens;
    costTotal: number | null;
    createdAt: number;
  },
): Promise<void> {
  const { input, output, cacheRead, cacheWrite } = opts.tokens;
  const usage = JSON.stringify({
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  });
  const cost =
    opts.costTotal === null
      ? null
      : JSON.stringify({
          input: opts.costTotal,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: opts.costTotal,
        });

  await api.providers.db.execute(sql`
    INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
    VALUES (${opts.id}, ${opts.sessionId}, 'th-1', 'message', 'assistant', 'test-model',
            ${usage}, ${cost}, ${opts.createdAt})
  `);
}

/** A workflow definition + run owned by `owner`, ready to host `wf:` turns. */
async function seedWorkflowRun(
  api: TestApi,
  opts: {
    workflowId: string;
    runId: string;
    orgId: string;
    ownerType: "user" | "team" | "org";
    ownerId: string;
  },
): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(workflowDefinitions).values({
    id: opts.workflowId,
    orgId: opts.orgId,
    ownerType: opts.ownerType,
    ownerId: opts.ownerId,
    name: `Workflow ${opts.workflowId}`,
    definition: { version: "dag/v1" },
    createdAt: now,
    updatedAt: now,
  });
  await api.providers.db.insert(workflowRuns).values({
    id: opts.runId,
    workflowId: opts.workflowId,
    definitionVersionId: "v1",
    definition: { version: "dag/v1" },
    params: { workflowId: opts.workflowId },
    ownerType: opts.ownerType,
    ownerId: opts.ownerId,
    createdAt: now,
    updatedAt: now,
  });
}

async function getSummary(api: TestApi): Promise<UsageSummaryResponse> {
  const res = await fetch(`${api.baseUrl}/api/usage/summary`);
  expect(res.status).toBe(200);
  return (await res.json()) as UsageSummaryResponse;
}

describe("GET /api/usage/summary", () => {
  it("counts a workflow session's turn, which has no agent_sessions row", async () => {
    const api = await bootTestApi();
    try {
      await seedWorkflowRun(api, {
        workflowId: "wf-1",
        runId: "run-1",
        orgId: "local-org",
        ownerType: "user",
        ownerId: "local-user",
      });
      await seedTurn(api, {
        id: "turn-wf",
        sessionId: "wf:run-1:node-a",
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        costTotal: 0.25,
        createdAt: Date.now() - HOUR_MS,
      });
      // A foreach body carries an extra `:{iteration}` segment.
      await seedTurn(api, {
        id: "turn-wf-foreach",
        sessionId: "wf:run-1:node-a:3",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        costTotal: 0.05,
        createdAt: Date.now() - HOUR_MS,
      });

      const body = await getSummary(api);
      expect(body.me.day.turns).toBe(2);
      expect(body.me.day.inputTokens).toBe(110);
      expect(body.me.day.outputTokens).toBe(55);
      expect(body.me.day.costUsd).toBeCloseTo(0.3, 6);
    } finally {
      await api.cleanup();
    }
  });

  it("still counts an orchestrator session's turn", async () => {
    const api = await bootTestApi();
    try {
      const now = Date.now();
      const orchId = orchestratorSessionId({ type: "user", id: "local-user" });
      await api.providers.db.insert(agentSessions).values({
        id: orchId,
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/orch",
        title: "Assistant",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
      await seedTurn(api, {
        id: "turn-orch",
        sessionId: orchId,
        tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
        costTotal: 0.11,
        createdAt: now - HOUR_MS,
      });

      const body = await getSummary(api);
      expect(body.me.day.turns).toBe(1);
      expect(body.me.day.inputTokens).toBe(7);
      expect(body.me.day.costUsd).toBeCloseTo(0.11, 6);
    } finally {
      await api.cleanup();
    }
  });

  it("sums cache-read and cache-write tokens into the window total", async () => {
    const api = await bootTestApi();
    try {
      const now = Date.now();
      await api.providers.db.insert(agentSessions).values({
        id: "sess-cache",
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/cache",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
      await seedTurn(api, {
        id: "turn-cache",
        sessionId: "sess-cache",
        tokens: { input: 100, output: 20, cacheRead: 9000, cacheWrite: 300 },
        costTotal: 0.5,
        createdAt: now - HOUR_MS,
      });

      const body = await getSummary(api);
      expect(body.me.day.cacheReadTokens).toBe(9000);
      expect(body.me.day.cacheWriteTokens).toBe(300);
      expect(body.me.day.totalTokens).toBe(9420);
    } finally {
      await api.cleanup();
    }
  });

  it("reports an unpriced turn as unpriced, not as $0 of real spend", async () => {
    const api = await bootTestApi();
    try {
      const now = Date.now();
      await api.providers.db.insert(agentSessions).values({
        id: "sess-unpriced",
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/unpriced",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
      await seedTurn(api, {
        id: "turn-unpriced",
        sessionId: "sess-unpriced",
        tokens: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
        costTotal: null,
        createdAt: now - HOUR_MS,
      });
      await seedTurn(api, {
        id: "turn-priced",
        sessionId: "sess-unpriced",
        tokens: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
        costTotal: 0.75,
        createdAt: now - HOUR_MS,
      });

      const body = await getSummary(api);
      expect(body.me.day.turns).toBe(2);
      expect(body.me.day.unpricedTurns).toBe(1);
      // The known price is exact; the unpriced turn adds nothing to it.
      expect(body.me.day.costUsd).toBeCloseTo(0.75, 6);
    } finally {
      await api.cleanup();
    }
  });

  it("never counts another org's turns, for sessions or workflows", async () => {
    const api = await bootTestApi();
    try {
      const now = Date.now();
      const { db } = api.providers;
      await db.insert(orgs).values({ id: "other-org", name: "Other Org", createdAt: now });
      await db.insert(users).values({ id: "other-user", email: "other@dev", name: "Other", role: "member" });
      await db
        .insert(orgMembers)
        .values({ orgId: "other-org", userId: "other-user", role: "admin", createdAt: now });
      await db.insert(agentSessions).values({
        id: "sess-other",
        userId: "other-user",
        orgId: "other-org",
        workspace: "/tmp/other",
        status: "active",
        ownerType: "user",
        ownerId: "other-user",
        createdAt: now,
        updatedAt: now,
      });
      await seedWorkflowRun(api, {
        workflowId: "wf-other",
        runId: "run-other",
        orgId: "other-org",
        ownerType: "user",
        ownerId: "other-user",
      });
      await seedTurn(api, {
        id: "turn-other-session",
        sessionId: "sess-other",
        tokens: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
        costTotal: 12.5,
        createdAt: now - HOUR_MS,
      });
      await seedTurn(api, {
        id: "turn-other-workflow",
        sessionId: "wf:run-other:node-x",
        tokens: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
        costTotal: 12.5,
        createdAt: now - HOUR_MS,
      });

      // Enable the org comparison so the member list is exercised too.
      await db
        .update(orgs)
        .set({ features: { organizations: true } })
        .where(eq(orgs.id, "local-org"));

      const body = await getSummary(api);
      expect(body.me.day.turns).toBe(0);
      expect(body.me.day.costUsd).toBe(0);
      expect(body.org?.members.map((m) => m.userId)).toEqual([]);
    } finally {
      await api.cleanup();
    }
  });

  it("lists a member's workflow spend in the org comparison", async () => {
    const api = await bootTestApi();
    try {
      const now = Date.now();
      const { db } = api.providers;
      await db
        .update(orgs)
        .set({ features: { organizations: true } })
        .where(eq(orgs.id, "local-org"));
      await seedWorkflowRun(api, {
        workflowId: "wf-member",
        runId: "run-member",
        orgId: "local-org",
        ownerType: "user",
        ownerId: "test-member",
      });
      await seedTurn(api, {
        id: "turn-member-wf",
        sessionId: "wf:run-member:node-a",
        tokens: { input: 60, output: 40, cacheRead: 1000, cacheWrite: 0 },
        costTotal: 2,
        createdAt: now - HOUR_MS,
      });

      const body = await getSummary(api);
      expect(body.org?.members).toHaveLength(1);
      expect(body.org?.members[0]?.userId).toBe("test-member");
      expect(body.org?.members[0]?.costUsd).toBeCloseTo(2, 6);
      expect(body.org?.members[0]?.totalTokens).toBe(1100);
    } finally {
      await api.cleanup();
    }
  });

  it("excludes turns older than the window", async () => {
    const api = await bootTestApi();
    try {
      const now = Date.now();
      await api.providers.db.insert(agentSessions).values({
        id: "sess-old",
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/old",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
      await seedTurn(api, {
        id: "turn-old",
        sessionId: "sess-old",
        tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
        costTotal: 1,
        createdAt: now - 40 * 24 * HOUR_MS,
      });
      await seedTurn(api, {
        id: "turn-week",
        sessionId: "sess-old",
        tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
        costTotal: 1,
        createdAt: now - 3 * 24 * HOUR_MS,
      });

      const body = await getSummary(api);
      expect(body.me.day.turns).toBe(0);
      expect(body.me.week.turns).toBe(1);
      expect(body.me.month.turns).toBe(1);
    } finally {
      await api.cleanup();
    }
  });
});
