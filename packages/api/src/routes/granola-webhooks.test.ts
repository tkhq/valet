/**
 * Granola webhook ingress at `/plugins/granola/http/events/:orgId`.
 * Real Hono app via `bootTestApi`, real HTTP requests, Standard Webhooks
 * signatures, assertions against actual DB rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import granolaPlugin from "@valet/plugin-granola/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDeliveries, eventDropLog, events, eventSubscriptions } from "../schema/index.js";
import type { GetEventCatalogResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const KEY = Buffer.from("granola-route-test-key-0123456789");
const SECRET = `whsec_${KEY.toString("base64")}`;

async function seedSecret(a: TestApi, secret = SECRET, orgId = "local-org"): Promise<void> {
  await a.providers.engineCredentials.save({ type: "org", id: orgId }, "granola-webhook", { type: "api_key", apiKey: secret });
}

async function seedSubscription(a: TestApi, eventKeys: string[]): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id: "sub_seed", orgId: "local-org", ownerType: "org", ownerId: "local-org", name: "granola subscription",
    eventKeys, filters: [], target: { kind: "assistant" }, enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
  });
}

function delivery(over: Record<string, unknown> = {}, opts: { key?: Uint8Array; ts?: string; id?: string } = {}) {
  const payload = { event_id: "evt-1", event_type: "note.generated", note_id: "not_1d3tmYTlCICgjy", occurred_at: new Date().toISOString(), ...over };
  const body = JSON.stringify(payload);
  const id = opts.id ?? String(payload.event_id);
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const signature = `v1,${createHmac("sha256", opts.key ?? KEY).update(`${id}.${ts}.${body}`).digest("base64")}`;
  return { body, headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signature } };
}

function putCredential(a: TestApi, body: Record<string, unknown>) {
  return fetch(`${a.baseUrl}/api/credentials/granola-webhook`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

function post(a: TestApi, d: ReturnType<typeof delivery>, orgId = "local-org") {
  return fetch(`${a.baseUrl}/plugins/granola/http/events/${orgId}`, { method: "POST", headers: d.headers, body: d.body });
}

describe("POST /plugins/granola/http/events/:orgId", () => {
  it.each(["note.generated", "note.edited", "note.access_granted"])("ingests a signed %s and matches the subscription", async (type) => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    // Stop the dispatcher so the delivery row stays "pending" for the assertion.
    await api.providers.eventDispatcher.stop();
    await seedSecret(api);
    await seedSubscription(api, [`granola.${type}`]);

    expect((await post(api, delivery({ event_type: type }))).status).toBe(200);

    const rows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: "granola", eventKey: `granola.${type}` });
    const deliveries = await api.providers.db.select().from(eventDeliveries).where(eq(eventDeliveries.eventId, rows[0].id));
    expect(deliveries).toMatchObject([{ subscriptionId: "sub_seed", status: "pending" }]);
  });

  it("does not match a subscription for a different Granola event", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await api.providers.eventDispatcher.stop();
    await seedSecret(api);
    await seedSubscription(api, ["granola.note.edited"]);
    expect((await post(api, delivery())).status).toBe(200);
    expect(await api.providers.db.select().from(eventDeliveries)).toHaveLength(0);
  });

  it("dedupes a retry that reuses event_id", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await api.providers.eventDispatcher.stop();
    await seedSecret(api);
    await seedSubscription(api, ["granola.note.generated"]);
    expect((await post(api, delivery())).status).toBe(200);
    expect((await post(api, delivery())).status).toBe(200);
    expect(await api.providers.db.select().from(events)).toHaveLength(1);
    expect(await api.providers.db.select().from(eventDeliveries)).toHaveLength(1);
  });

  it("answers 403 and logs bad_signature for a wrong key", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await seedSecret(api);
    const res = await post(api, delivery({}, { key: Buffer.from("wrong-key") }));
    expect(res.status).toBe(403);
    expect(await api.providers.db.select().from(events)).toHaveLength(0);
    const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
    expect(drops.map((d) => d.reason)).toEqual(["bad_signature"]);
  });

  it("does not accept a body signed for another organization's secret", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await seedSecret(api);
    await seedSecret(api, `whsec_${Buffer.from("other-org-key").toString("base64")}`, "other-org");
    expect((await post(api, delivery())).status).toBe(200);
    expect((await post(api, delivery({ event_id: "evt-2" }), "other-org")).status).toBe(403);
  });

  it("answers 503 and logs when no secret is saved for an existing organization", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    const res = await post(api, delivery());
    expect(res.status).toBe(503);
    expect(await api.providers.db.select().from(events)).toHaveLength(0);
    const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
    expect(drops.map((d) => d.reason)).toEqual(["secret_unavailable"]);
    expect(drops[0].detail).toContain("no signing secret is saved");
  });

  it("answers 503 for an unknown organization ID without writing a drop-log row", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    expect((await post(api, delivery(), "no-such-org")).status).toBe(503);
    expect(await api.providers.db.select().from(events)).toHaveLength(0);
    expect(await api.providers.db.select().from(eventDropLog)).toHaveLength(0);
  });

  it.each([
    ["a bot_token", { type: "bot_token" as const, accessToken: SECRET }],
    ["a 1Password reference", { type: "api_key" as const, metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } } }],
    ["an api_key row with no secret", { type: "api_key" as const }],
  ])("answers 503 and logs for %s, never acknowledging an unreadable secret", async (_label, stored) => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await api.providers.eventDispatcher.stop();
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "granola-webhook", stored);
    await seedSubscription(api, ["granola.note.generated"]);
    const res = await post(api, delivery());
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
    expect(await api.providers.db.select().from(events)).toHaveLength(0);
    const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
    expect(drops.map((d) => d.reason)).toEqual(["secret_unavailable"]);
    expect(drops[0].detail).toContain("cannot be read");
    expect(drops[0].detail).not.toContain(SECRET);
  });

  it("verifies and ingests with a secret saved through the credentials route", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await api.providers.eventDispatcher.stop();
    await seedSubscription(api, ["granola.note.generated"]);
    expect((await putCredential(api, { scope: "org", type: "api_key", apiKey: SECRET })).status).toBe(200);
    expect((await post(api, delivery())).status).toBe(200);
    expect(await api.providers.db.select().from(events)).toHaveLength(1);
  });

  it("acknowledges a signed unsupported event and logs why", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await seedSecret(api);
    expect((await post(api, delivery({ event_type: "note.deleted" }))).status).toBe(200);
    expect(await api.providers.db.select().from(events)).toHaveLength(0);
    const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
    expect(drops.map((d) => d.reason)).toEqual(["unsupported_event"]);
    expect(drops[0].detail).toContain("note.deleted");
  });

  it("acknowledges a signed stale delivery without ingesting it", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await seedSecret(api);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await post(api, delivery({}, { ts: stale }))).status).toBe(200);
    expect(await api.providers.db.select().from(events)).toHaveLength(0);
    const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
    expect(drops.map((d) => d.reason)).toEqual(["stale_delivery"]);
  });

  it("rejects an unsigned request and an invalid JSON body", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await seedSecret(api);
    const unsigned = await fetch(`${api.baseUrl}/plugins/granola/http/events/local-org`, { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(403);
    const garbage = delivery();
    garbage.body = "{";
    expect((await post(api, garbage)).status).toBe(403);
    expect(await api.providers.db.select().from(events)).toHaveLength(0);
  });

  it("returns 413 for a body over the 64 KiB limit", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    await seedSecret(api);
    const res = await fetch(`${api.baseUrl}/plugins/granola/http/events/local-org`, { method: "POST", body: "x".repeat(64 * 1024 + 1) });
    expect(res.status).toBe(413);
  });

  it.each([
    ["a bot_token", { scope: "org", type: "bot_token", accessToken: SECRET }],
    ["an oauth2 token", { scope: "org", type: "oauth2", accessToken: SECRET }],
    ["a 1Password reference", { scope: "org", type: "api_key", onepassword: { reference: "op://vault/item/field", tokenScope: "org" } }],
    ["a personal scope", { scope: "user", type: "api_key", apiKey: SECRET }],
    ["a secret without the whsec_ prefix", { scope: "org", type: "api_key", apiKey: KEY.toString("base64") }],
    ["an empty secret", { scope: "org", type: "api_key", apiKey: "" }],
  ])("refuses to save %s as the signing secret", async (_label, body) => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    const res = await putCredential(api, body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
    const list = await fetch(`${api.baseUrl}/api/credentials?scope=org`);
    expect(JSON.stringify(await list.json())).not.toContain("granola-webhook");
  });

  it("lists the three events in the catalog", async () => {
    api = await bootTestApi({ plugins: [granolaPlugin] });
    const res = await fetch(`${api.baseUrl}/api/events/catalog`);
    const body = (await res.json()) as GetEventCatalogResponse;
    const granola = body.services.find((s) => s.service === "granola");
    expect(granola?.entries.map((e) => e.key).sort()).toEqual(["granola.note.access_granted", "granola.note.edited", "granola.note.generated"]);
  });
});
