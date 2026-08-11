/**
 * Dev-only smoke test for the webhook → event → subscription → workflow
 * pipeline, plus the direct workflow webhook trigger. Run with the api
 * RUNNING and `scripts/dev-seed-linear.ts` already applied:
 *
 *   cd packages/api && npx tsx scripts/dev-events-smoke.ts
 *
 * Steps:
 *   1. POST a signed Linear webhook -> event appears in the org feed.
 *   2. Create a minimal workflow and a subscription targeting it.
 *   3. POST a second signed webhook -> delivery lands, workflow run settles.
 *   4. Create a workflow webhook trigger, POST to its URL -> run settles.
 */
import { createHmac } from "node:crypto";
import type { WorkflowWebhookResponse } from "../src/wire/types.js";

const API = "http://localhost:8788";
const SECRET = "dev-webhook-secret";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) fail(`${what}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function poll<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function signedLinearWebhook(action: string, identifier: string, title: string) {
  const body = JSON.stringify({
    webhookTimestamp: Date.now(),
    action,
    type: "Issue",
    organizationId: "ws-dev-seed",
    data: {
      id: `iss-${identifier}`,
      identifier,
      title,
      team: { key: "DEV" },
      creatorId: "u-dev",
    },
  });
  const sig = createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
  return { body, headers: { "content-type": "application/json", "linear-signature": sig, "linear-delivery": `del-${identifier}` } };
}

interface EventRow { id: string; service: string; eventKey: string; summary: string }
interface Delivery { status: string; attempts: number; lastError: string | null }

// Unique per run: ingest dedupes on the Linear delivery id, so re-running
// with fixed identifiers silently drops the webhook and the test hangs.
const RUN_TAG = Date.now().toString(36);
const ID_1 = `SMK${RUN_TAG}-1`;
const ID_2 = `SMK${RUN_TAG}-2`;

// ── 1. signed webhook -> event in the feed ─────────────────────────────────
const hook1 = signedLinearWebhook("create", ID_1, "First smoke issue");
const res1 = await fetch(`${API}/webhooks/events/linear`, { method: "POST", headers: hook1.headers, body: hook1.body });
if (res1.status !== 204) fail(`webhook 1: expected 204, got ${res1.status} ${await res1.text()}`);

const event1 = await poll("event 1 in feed", async () => {
  const { events } = await json<{ events: EventRow[] }>(await req("GET", "/api/events"), "list events");
  return events.find((e) => e.summary.includes(ID_1)) ?? null;
});
console.log(`ok: webhook ingested -> event ${event1.id} (${event1.eventKey}: "${event1.summary}")`);

// ── 2. workflow + subscription targeting it ────────────────────────────────
const workflow = await json<{ id: string }>(
  await req("POST", "/api/workflows", {
    name: `events-smoke-${RUN_TAG}`,
    definition: {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "stop", type: "stop", outcome: "success" },
      ],
      edges: [{ from: "trigger", to: "stop" }],
    },
  }),
  "create workflow",
);
const sub = await json<{ id: string }>(
  await req("POST", "/api/event-subscriptions", {
    name: "smoke: linear issues -> workflow",
    eventKeys: [event1.eventKey],
    target: { kind: "workflow", workflowId: workflow.id },
  }),
  "create subscription",
);
console.log(`ok: workflow ${workflow.id} + subscription ${sub.id} on ${event1.eventKey}`);

// ── 3. second webhook -> delivery + settled run ────────────────────────────
const hook2 = signedLinearWebhook("create", ID_2, "Second smoke issue");
const res2 = await fetch(`${API}/webhooks/events/linear`, { method: "POST", headers: hook2.headers, body: hook2.body });
if (res2.status !== 204) fail(`webhook 2: expected 204, got ${res2.status}`);

const event2 = await poll("event 2 in feed", async () => {
  const { events } = await json<{ events: EventRow[] }>(await req("GET", "/api/events"), "list events");
  return events.find((e) => e.summary.includes(ID_2)) ?? null;
});
const delivery = await poll("delivery for event 2", async () => {
  const { deliveries } = await json<{ deliveries: Delivery[] }>(
    await req("GET", `/api/events/${event2.id}`),
    "event 2 detail",
  );
  const d = deliveries[0];
  if (!d) return null;
  if (d.status === "failed" || d.status === "dead") fail(`delivery ${d.status}: ${d.lastError}`);
  return d.status === "delivered" ? d : null;
});
console.log(`ok: delivery delivered (${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"})`);

interface Run { runId: string; status: string }
const run = await poll("subscription-started run to settle", async () => {
  const { runs } = await json<{ runs: Run[] }>(
    await req("GET", `/api/workflows/${workflow.id}/runs`),
    "list runs",
  );
  const r = runs[0];
  return r && r.status === "settled" ? r : null;
});
console.log(`ok: event-triggered workflow run ${run.runId} settled`);

// ── 4. direct workflow webhook trigger ─────────────────────────────────────
const hook = await json<WorkflowWebhookResponse>(
  await req("POST", `/api/workflows/${workflow.id}/webhook`),
  "create workflow webhook",
);

const fired = await fetch(`${API}/api/hooks/workflows/${workflow.id}/${hook.hookId}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ smoke: true }),
});
const firedBody = await json<{ runId: string }>(fired, "fire workflow webhook");
const hookRun = await poll("webhook-triggered run to settle", async () => {
  const { runs } = await json<{ runs: Run[] }>(
    await req("GET", `/api/workflows/${workflow.id}/runs`),
    "list runs",
  );
  const r = runs.find((x) => x.runId === firedBody.runId);
  return r && r.status === "settled" ? r : null;
});
console.log(`ok: webhook-triggered run ${hookRun.runId} settled`);

// ── 5. clean up the artifacts this run created ─────────────────────────────
// The two smoke events stay in the feed: there is no delete-event API
// (retention is a deferred follow-up in the event-system spec).
const delSub = await req("DELETE", `/api/event-subscriptions/${sub.id}`);
if (delSub.status !== 204) fail(`cleanup subscription: ${delSub.status}`);
const delWf = await req("DELETE", `/api/workflows/${workflow.id}`);
if (!delWf.ok) fail(`cleanup workflow: ${delWf.status}`);
console.log("ok: cleaned up the smoke subscription and workflow");

console.log("\nPASS: webhook -> event -> subscription -> workflow run, and direct workflow webhook trigger.");
