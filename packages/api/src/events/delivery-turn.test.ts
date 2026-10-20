import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDeliveries, events, eventSubscriptions } from "../schema/index.js";
import type { EventLogResponse } from "../wire/types.js";
import { markFailedDeliveryTurns, wireDeliveryTurnFailures } from "./delivery-turn.js";


let api: TestApi | undefined;
let faux: FauxProviderRegistration | undefined;
let unwire: (() => void) | undefined;
afterEach(async () => {
  unwire?.();
  unwire = undefined;
  await api?.cleanup();
  api = undefined;
  faux?.unregister();
  faux = undefined;
  vi.unstubAllEnvs();
});

/** One assistant rule, one received push, and its pending delivery. */
async function deliverPush(response: ReturnType<typeof fauxAssistantMessage>, opts: { watch?: boolean } = {}) {
  vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
  faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  faux.setResponses([response]);
  api = await bootTestApi();
  if (opts.watch !== false) unwire = wireDeliveryTurnFailures(api.providers.eventStream, api.providers.db);
  const now = Date.now();
  await api.providers.db.insert(eventSubscriptions).values({
    id: "sub_triage", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Triage",
    eventKeys: ["github.push"], filters: [], target: { kind: "assistant" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  await api.providers.db.insert(events).values({
    id: "ev_push", orgId: "local-org", service: "github", eventKey: "github.push", dedupeKey: "ev_push", refs: {}, summary: "push to main",
    payload: {}, occurredAt: now, receivedAt: now,
  });
  await api.providers.db.insert(eventDeliveries).values({
    id: "d_push", eventId: "ev_push", subscriptionId: "sub_triage", status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: now,
  });
  await api.providers.eventDispatcher.pollOnce();
  const [delivery] = await api.providers.db.select().from(eventDeliveries).where(eq(eventDeliveries.id, "d_push"));
  const queueItemId = delivery?.queueItemId;
  if (!queueItemId) throw new Error("The dispatcher did not record the delivery's queue item");
  const local = api;
  // The turn runs after the dispatcher queues the prompt.
  await vi.waitFor(async () => {
    const result = await local.providers.db.execute(sql`SELECT status FROM engine_queue_items WHERE id = ${queueItemId}`) as { rows: Array<{ status: string }> };
    if (result.rows[0]?.status !== "settled") throw new Error("Waiting for the turn to settle");
  }, { timeout: 10_000 });
  return { local, queueItemId };
}

async function deliveryRow(local: TestApi) {
  const [delivery] = await local.providers.db.select().from(eventDeliveries).where(eq(eventDeliveries.id, "d_push"));
  return delivery;
}

async function problems(local: TestApi) {
  const res = await fetch(`${local.baseUrl}/api/events/log?ownerType=user&ownerId=local-user&problems=1`);
  return ((await res.json()) as EventLogResponse).items;
}

it("marks a delivered event failed with the turn's reason when its turn fails, and lists it under Problems", async () => {
  const { local } = await deliverPush(fauxAssistantMessage("Partial triage", { stopReason: "length" }));
  await vi.waitFor(async () => {
    expect(await deliveryRow(local)).toMatchObject({ status: "dead", lastError: expect.stringContaining("output limit") });
  });
  expect(await problems(local)).toEqual([
    expect.objectContaining({ id: "ev_push", status: "failed", detail: expect.stringMatching(/^The assistant turn failed: The model reached its output limit/) }),
  ]);
}, 30_000);

it("keeps a delivery whose turn completes delivered and out of Problems", async () => {
  const { local } = await deliverPush(fauxAssistantMessage("Triage posted."));
  expect((await deliveryRow(local))?.status).toBe("delivered");
  expect(await local.providers.eventDispatcher.sweepFailedDeliveryTurns()).toBe(0);
  expect(await problems(local)).toEqual([]);
}, 30_000);

// The settle watcher's one write can fail, or the API can exit before it.
it("marks a failed turn the watcher missed on the dispatcher's next sweep", async () => {
  const { local } = await deliverPush(fauxAssistantMessage("Partial triage", { stopReason: "length" }), { watch: false });
  expect((await deliveryRow(local))?.status).toBe("delivered");
  expect(await local.providers.eventDispatcher.sweepFailedDeliveryTurns()).toBe(1);
  expect(await deliveryRow(local)).toMatchObject({ status: "dead", lastError: expect.stringContaining("output limit") });
}, 30_000);

// An admission from before `queue_item_id` existed has no recorded item.
it("finds a failed turn through the dispatch id when the delivery recorded no queue item", async () => {
  const { local, queueItemId } = await deliverPush(fauxAssistantMessage("Partial triage", { stopReason: "length" }), { watch: false });
  await local.providers.db.update(eventDeliveries).set({ queueItemId: null }).where(eq(eventDeliveries.id, "d_push"));
  expect(await markFailedDeliveryTurns(local.providers.db, { queueItemId })).toBe(1);
  expect(await deliveryRow(local)).toMatchObject({ status: "dead", queueItemId });
}, 30_000);
