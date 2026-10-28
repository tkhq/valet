import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHttpRequest } from "@valet/engine";
import { granolaHttpRoutes } from "./http.js";
import { granolaTriggerDefs } from "./triggers.js";

const route = granolaHttpRoutes[0];
if (route.auth !== "signature") throw new Error("expected a signature route");
const KEY = Buffer.from("granola-http-test-key-0123456789a");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

afterEach(() => vi.restoreAllMocks());

function request(timestampSeconds: number, key: Uint8Array = KEY): PluginHttpRequest {
  const body = JSON.stringify({ event_id: "evt-1", event_type: "note.generated", note_id: "not_1", occurred_at: "2026-01-27T15:30:00Z" });
  const signature = `v1,${createHmac("sha256", key).update(`evt-1.${timestampSeconds}.${body}`).digest("base64")}`;
  return {
    url: "https://valet.test/plugins/granola/http/events/org-1", params: { orgId: "org-1" },
    headers: { "webhook-id": "evt-1", "webhook-timestamp": String(timestampSeconds), "webhook-signature": signature },
    rawBody: new TextEncoder().encode(body), signal: new AbortController().signal,
  };
}

/** Each clock read returns a value 1.5 seconds later than the one before. */
function advancingClock() {
  let now = NOW_MS;
  return vi.spyOn(Date, "now").mockImplementation(() => { const value = now; now += 1500; return value; });
}

const verify = (req: PluginHttpRequest) => route.verify(req, { signingSecret: SECRET }, granolaTriggerDefs);

describe("granola route verification with one clock reading", () => {
  it.each([
    ["past", NOW_S - 301],
    ["future", NOW_S + 301],
  ])("keeps a signed %s delivery just outside the window retryable while the clock advances", async (_label, ts) => {
    const clock = advancingClock();
    const result = await verify(request(ts));
    expect(result).toMatchObject({ accepted: false, rejection: { reason: "stale_delivery", retry: true } });
    // Exactly one clock reading decided the outcome. A second read 1.5s later would put the
    // future case at the window edge and acknowledge it, which Granola never resends.
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it("answers bad_signature without retry for a wrong key, even with a stale timestamp", async () => {
    advancingClock();
    const result = await verify(request(NOW_S - 3600, Buffer.from("wrong-key")));
    expect(result).toMatchObject({ accepted: false, rejection: { reason: "bad_signature" } });
    expect(result.accepted ? undefined : result.rejection.retry).toBeUndefined();
  });

  it("accepts a fresh signed delivery", async () => {
    advancingClock();
    const result = await verify(request(NOW_S));
    expect(result).toMatchObject({ accepted: true, events: [{ key: "granola.note.generated", dedupeKey: "evt-1" }] });
  });

  it("accepts a delivery at the window edge", async () => {
    advancingClock();
    expect((await verify(request(NOW_S - 300))).accepted).toBe(true);
  });
});
