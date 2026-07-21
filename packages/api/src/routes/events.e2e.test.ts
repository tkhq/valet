/**
 * Event system end-to-end (event-system plan, Task 10): a signed Linear
 * webhook travels the full pipeline over real HTTP — ingress verification →
 * event row → subscription match → delivery row → dispatcher → workflow run
 * on the real `LocalRunHost`.
 *
 * The ingest path nudges the dispatcher in-process (fire-and-forget), so the
 * delivery may already be resolved by the time the webhook POST returns. The
 * test therefore awaits `providers.eventDispatcher.pollOnce()` for the
 * deterministic path and asserts final DB state via `expect.poll` — covering
 * both the "nudge already delivered" and "manual poll delivers" orderings
 * without sleeps.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDeliveries, events, linearInstallations, workflowRuns } from "../schema/index.js";
import type { CreateEventSubscriptionResponse, CreateWorkflowResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const WEBHOOK_SECRET = "s1";
const HEADERS = { "Content-Type": "application/json" };

/** Minimal valid DAG — same literal as `routes/workflows.test.ts`. */
const VALID_DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

/** Signs a Linear body the way plugin-linear verifies it (HMAC-SHA256 hex
 * over the raw body). */
function linearSig(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

/** Org linear credential (webhook secret in metadata) + installation row
 * mapping the Linear workspace to `local-org` — same seeding as
 * `event-webhooks.test.ts`. */
async function seedLinearOrg(a: TestApi): Promise<void> {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "linear", {
    type: "oauth2",
    accessToken: "linear-access-token",
    metadata: { webhookSecret: WEBHOOK_SECRET },
  });
  const now = Date.now();
  await a.providers.db.insert(linearInstallations).values({
    id: "li_e2e",
    orgId: "local-org",
    workspaceId: "lin-org-1",
    workspaceName: "Linear Test Workspace",
    connectedBy: "local-user",
    createdAt: now,
    updatedAt: now,
  });
}

function issueCreateBody(teamKey: string, id: string): string {
  return JSON.stringify({
    action: "create",
    type: "Issue",
    organizationId: "lin-org-1",
    webhookTimestamp: Date.now(),
    data: { id, identifier: `${teamKey}-1`, title: "Bug", team: { key: teamKey } },
    webhookId: `wh-${id}`,
    createdAt: new Date().toISOString(),
  });
}

async function postLinear(baseUrl: string, body: string, deliveryId: string): Promise<Response> {
  return fetch(`${baseUrl}/webhooks/events/linear`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Signature": linearSig(body),
      "Linear-Delivery": deliveryId,
    },
    body,
  });
}

/** The `params` jsonb shape is owned by the dispatcher's `startWorkflow`
 * (a `RunParams` whose `input` is a `WorkflowTriggerPayload`). */
interface RunParamsShape {
  workflowId: string;
  input: { type: string; data: { key: string } };
}

describe("event system e2e: signed webhook → subscription match → workflow run", () => {
  it("delivers a matching Linear event into a workflow run; filtered events create no delivery", async () => {
    api = await bootTestApi({ plugins: [githubPlugin, linearPlugin] });
    await seedLinearOrg(api);

    // ── Workflow definition via the API ─────────────────────────────────
    const wfRes = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "on-issue", definition: VALID_DEFINITION }),
    });
    expect(wfRes.status).toBe(201);
    const workflow = (await wfRes.json()) as CreateWorkflowResponse;

    // ── Subscription targeting it, filtered to team TKAI ────────────────
    const subRes = await fetch(`${api.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        name: "tkai issues",
        eventKeys: ["linear.issue.create"],
        filters: [{ field: "team", op: "eq", value: "TKAI" }],
        target: { kind: "workflow", workflowId: workflow.id },
      }),
    });
    expect(subRes.status).toBe(201);
    const sub = (await subRes.json()) as CreateEventSubscriptionResponse;

    // ── Signed webhook, team TKAI → 204 ─────────────────────────────────
    const res = await postLinear(api.baseUrl, issueCreateBody("TKAI", "iss-1"), "del-1");
    expect(res.status).toBe(204);

    // Deterministic drive: if the ingest nudge's poll is still in flight,
    // this is a no-op (draining guard) and expect.poll below covers it; if
    // the nudge already finished, this poll is what delivers.
    await api.providers.eventDispatcher.pollOnce();

    const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].eventKey).toBe("linear.issue.create");

    await expect
      .poll(
        async () => {
          const rows = await api!.providers.db
            .select()
            .from(eventDeliveries)
            .where(eq(eventDeliveries.eventId, eventRows[0].id));
          return rows.map((r) => ({ status: r.status, subscriptionId: r.subscriptionId }));
        },
        { timeout: 5_000 },
      )
      .toEqual([{ status: "delivered", subscriptionId: sub.id }]);

    const runRows = await api.providers.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflow.id));
    expect(runRows).toHaveLength(1);
    const params = runRows[0].params as RunParamsShape;
    expect(params.workflowId).toBe(workflow.id);
    expect(params.input.type).toBe("event");
    expect(params.input.data.key).toBe("linear.issue.create");

    // ── Negative: team OTHER fails the filter — event row, no delivery ──
    const negRes = await postLinear(api.baseUrl, issueCreateBody("OTHER", "iss-2"), "del-2");
    expect(negRes.status).toBe(204);

    const allEvents = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(allEvents).toHaveLength(2);
    const negEvent = allEvents.find((e) => e.id !== eventRows[0].id);
    expect(negEvent).toBeDefined();
    expect(negEvent!.eventKey).toBe("linear.issue.create");

    await api.providers.eventDispatcher.pollOnce();
    const negDeliveries = await api.providers.db
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.eventId, negEvent!.id));
    expect(negDeliveries).toHaveLength(0);

    // The run count is unchanged — the filtered event started nothing.
    const runsAfter = await api.providers.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflow.id));
    expect(runsAfter).toHaveLength(1);
  }, 30_000);
});
