import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { granolaTriggerDefs, isGranolaSigningSecret } from "./triggers.js";

const def = granolaTriggerDefs[0];
const KEY = Buffer.from("granola-test-key-0123456789abcdef");
const SECRET = `whsec_${KEY.toString("base64")}`;

const payload = { event_id: "evt-1", event_type: "note.generated", note_id: "not_1d3tmYTlCICgjy", occurred_at: "2026-01-27T15:30:00Z" };

function sign(id: string, ts: string, body: string, key: Uint8Array = KEY): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

function makeReq(over: Record<string, unknown> = {}, opts: { ts?: string; id?: string; signature?: string; key?: Uint8Array } = {}) {
  const body = JSON.stringify({ ...payload, ...over });
  const id = opts.id ?? String((over.event_id ?? payload.event_id));
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return {
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": opts.signature ?? sign(id, ts, body, opts.key) },
    rawBody: new TextEncoder().encode(body),
  };
}

const secrets = { signingSecret: SECRET };

describe("granola verify", () => {
  it("accepts a correctly signed fresh delivery", async () => {
    const verified = await def.verify(makeReq(), secrets);
    expect(verified).toMatchObject({ eventType: "note.generated", deliveryId: "evt-1" });
  });

  it("accepts when one of several space-separated signatures matches", async () => {
    const req = makeReq();
    req.headers["webhook-signature"] = `v1,AAAA ${req.headers["webhook-signature"]}`;
    expect(await def.verify(req, secrets)).not.toBeNull();
  });

  it("rejects a wrong key", async () => {
    expect(await def.verify(makeReq({}, { key: Buffer.from("another-key") }), secrets)).toBeNull();
  });

  it("rejects a body changed after signing", async () => {
    const req = makeReq();
    req.rawBody = new TextEncoder().encode(JSON.stringify({ ...payload, note_id: "not_other" }));
    expect(await def.verify(req, secrets)).toBeNull();
  });

  it("rejects a missing signature header and a non-v1 version", async () => {
    const req = makeReq();
    delete (req.headers as Record<string, string>)["webhook-signature"];
    expect(await def.verify(req, secrets)).toBeNull();
    const v2 = makeReq();
    v2.headers["webhook-signature"] = v2.headers["webhook-signature"].replace("v1,", "v2,");
    expect(await def.verify(v2, secrets)).toBeNull();
  });

  it("rejects a stale and a future timestamp, even when signed", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await def.verify(makeReq({}, { ts: String(now - 600) }), secrets)).toBeNull();
    expect(await def.verify(makeReq({}, { ts: String(now + 600) }), secrets)).toBeNull();
    expect(await def.verify(makeReq({}, { ts: "not-a-number" }), secrets)).toBeNull();
  });

  it("rejects when the saved secret is missing or malformed", async () => {
    expect(await def.verify(makeReq(), {})).toBeNull();
    expect(await def.verify(makeReq(), { signingSecret: KEY.toString("base64") })).toBeNull();
    expect(await def.verify(makeReq(), { signingSecret: "whsec_" })).toBeNull();
  });

  it("rejects an unsupported event type and a mismatched event_id", async () => {
    expect(await def.verify(makeReq({ event_type: "note.deleted" }), secrets)).toBeNull();
    expect(await def.verify(makeReq({}, { id: "evt-other" }), secrets)).toBeNull();
  });

  it("rejects a signed payload without a note_id or with a bad occurred_at", async () => {
    expect(await def.verify(makeReq({ note_id: undefined }), secrets)).toBeNull();
    expect(await def.verify(makeReq({ occurred_at: "yesterday" }), secrets)).toBeNull();
  });

  it("rejects a signed body that is not a JSON object", async () => {
    const body = "[1]";
    const ts = String(Math.floor(Date.now() / 1000));
    const req = { headers: { "webhook-id": "evt-1", "webhook-timestamp": ts, "webhook-signature": sign("evt-1", ts, body) }, rawBody: new TextEncoder().encode(body) };
    expect(await def.verify(req, secrets)).toBeNull();
    expect(await def.explainRejection!(req, secrets)).toMatchObject({ reason: "malformed_callback" });
  });
});

describe("granola explainRejection", () => {
  it("names each reason", async () => {
    const explain = def.explainRejection!;
    expect(await explain(makeReq({}, { key: Buffer.from("x") }), secrets)).toMatchObject({ reason: "bad_signature" });
    expect(await explain(makeReq(), {})).toMatchObject({ reason: "bad_signature" });
    expect(await explain(makeReq({}, { ts: "1" }), secrets)).toMatchObject({ reason: "stale_delivery", retry: true });
    expect(await explain(makeReq({ event_type: "note.deleted" }), secrets)).toMatchObject({ reason: "unsupported_event" });
    expect(await explain(makeReq({ note_id: undefined }), secrets)).toMatchObject({ reason: "malformed_callback" });
  });

  it("asks for a retry only after the signature verifies", async () => {
    const explain = def.explainRejection!;
    const staleSigned = await explain(makeReq({}, { ts: "1" }), secrets);
    expect(staleSigned.retry).toBe(true);
    const staleForged = await explain(makeReq({}, { ts: "1", key: Buffer.from("x") }), secrets);
    expect(staleForged).toMatchObject({ reason: "bad_signature" });
    expect(staleForged.retry).toBeUndefined();
    for (const other of [{ event_type: "note.deleted" }, { note_id: undefined }]) {
      expect((await explain(makeReq(other), secrets)).retry).toBeUndefined();
    }
  });

  it("does not echo unverified body content", async () => {
    const result = await def.explainRejection!(makeReq({ event_type: "x".repeat(200) }, { key: Buffer.from("x") }), secrets);
    expect(result.detail).not.toContain("xxxx");
  });
});

describe("granola toEvent", () => {
  it("normalizes each supported event", async () => {
    for (const type of ["note.generated", "note.edited", "note.access_granted"]) {
      const verified = (await def.verify(makeReq({ event_type: type }), secrets))!;
      const event = def.toEvent(verified);
      expect(event).toMatchObject({
        key: `granola.${type}`, dedupeKey: "evt-1", occurredAt: "2026-01-27T15:30:00.000Z",
        refs: { note_id: "not_1d3tmYTlCICgjy" },
      });
      expect(event.payload).toMatchObject({ note_id: "not_1d3tmYTlCICgjy" });
      expect(def.catalog.map((entry) => entry.key)).toContain(event.key);
    }
  });

  it("exposes changed_fields for note.edited", async () => {
    const verified = (await def.verify(makeReq({ event_type: "note.edited", data: { changed_fields: ["summary"] } }), secrets))!;
    expect(def.toEvent(verified).refs.changed_fields).toBe("summary");
  });

  it("catalogs exactly the three documented events", () => {
    expect(def.catalog.map((entry) => entry.key).sort()).toEqual(["granola.note.access_granted", "granola.note.edited", "granola.note.generated"]);
  });
});

describe("isGranolaSigningSecret", () => {
  it("accepts a whsec_ base64 secret and rejects other forms", () => {
    expect(isGranolaSigningSecret(SECRET)).toBe(true);
    for (const bad of ["", "whsec_", KEY.toString("base64"), "whsec_not base64!", "op://vault/item/field"]) {
      expect(isGranolaSigningSecret(bad)).toBe(false);
    }
  });
});
