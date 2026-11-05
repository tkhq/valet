import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { linearTriggerDefs } from "./triggers.js";

const issueDef = linearTriggerDefs.find((t) => t.id === "linear.issue")!;
const SECRET = "test-secret";

function makeReq(payload: Record<string, unknown>, secret = SECRET) {
  const body = JSON.stringify({ webhookTimestamp: Date.now(), ...payload });
  const rawBody = new TextEncoder().encode(body);
  const sig = createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex");
  return { headers: { "linear-signature": sig, "linear-delivery": "del-1" }, rawBody };
}

describe("linear verify", () => {
  const payload = { action: "create", type: "Issue", organizationId: "org-1", data: { id: "i1", identifier: "TKAI-9", title: "Bug", team: { key: "TKAI" }, creatorId: "u-1" } };

  it("accepts a correctly signed fresh delivery", async () => {
    const verified = await issueDef.verify(makeReq(payload), { webhookSecret: SECRET });
    expect(verified).not.toBeNull();
    expect(verified!.eventType).toBe("Issue");
    expect(verified!.deliveryId).toBe("del-1");
  });

  it("rejects a bad signature", async () => {
    const verified = await issueDef.verify(makeReq(payload, "wrong"), { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("accepts a stringified webhookTimestamp (SDK shape drift)", async () => {
    const verified = await issueDef.verify(
      makeReq({ ...payload, webhookTimestamp: String(Date.now()) }),
      { webhookSecret: SECRET },
    );
    expect(verified).not.toBeNull();
  });

  it("accepts a seconds-encoded webhookTimestamp", async () => {
    const verified = await issueDef.verify(
      makeReq({ ...payload, webhookTimestamp: Math.floor(Date.now() / 1000) }),
      { webhookSecret: SECRET },
    );
    expect(verified).not.toBeNull();
  });

  it("rejects a stale webhookTimestamp", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now() - 600_000, ...payload });
    const rawBody = new TextEncoder().encode(body);
    const sig = createHmac("sha256", SECRET).update(Buffer.from(rawBody)).digest("hex");
    const verified = await issueDef.verify({ headers: { "linear-signature": sig, "linear-delivery": "d" }, rawBody }, { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("rejects when the type doesn't match the def's family", async () => {
    const verified = await issueDef.verify(makeReq({ ...payload, type: "Comment" }), { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("rejects when Linear-Delivery header is absent", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), ...payload });
    const rawBody = new TextEncoder().encode(body);
    const sig = createHmac("sha256", SECRET).update(Buffer.from(rawBody)).digest("hex");
    const verified = await issueDef.verify({ headers: { "linear-signature": sig }, rawBody }, { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("rejects when webhookTimestamp is missing", async () => {
    const { webhookTimestamp: _ts, ...rest } = { webhookTimestamp: 0, ...payload };
    void _ts;
    const body = JSON.stringify(rest);
    const rawBody = new TextEncoder().encode(body);
    const sig = createHmac("sha256", SECRET).update(Buffer.from(rawBody)).digest("hex");
    const verified = await issueDef.verify({ headers: { "linear-signature": sig, "linear-delivery": "d" }, rawBody }, { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("rejects when action is not create/update/remove", async () => {
    const verified = await issueDef.verify(makeReq({ ...payload, action: "delete" }), { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });
});

describe("linear explainRejection", () => {
  const payload = { action: "create", type: "Issue", organizationId: "org-1", webhookId: "wh-9", data: { id: "i1" } };
  const explain = (req: { headers: Record<string, string>; rawBody: Uint8Array }) => issueDef.explainRejection!(req, { webhookSecret: SECRET });

  it("tells a bad signature apart from a signed delivery Valet does not handle", async () => {
    expect((await explain(makeReq(payload, "wrong"))).reason).toBe("bad_signature");
    expect(await explain(makeReq({ ...payload, type: "Document" }))).toEqual({
      reason: "unsupported_event",
      detail: expect.stringContaining("Linear sent Document create from webhook wh-9"),
    });
    expect((await explain(makeReq({ ...payload, action: "restore" }))).reason).toBe("unsupported_event");
  });

  it("reports a stale delivery and a missing delivery header", async () => {
    expect((await explain(makeReq({ ...payload, webhookTimestamp: Date.now() - 600_000 }))).reason).toBe("stale_delivery");
    const req = makeReq(payload);
    expect((await explain({ ...req, headers: { "linear-signature": req.headers["linear-signature"] } })).reason).toBe("malformed_callback");
  });

  it("logs only a well-formed webhook ID from an unsigned body", async () => {
    const rejection = await explain(makeReq({ ...payload, webhookId: "<script>alert(1)</script>" }, "wrong"));
    expect(rejection.reason).toBe("bad_signature");
    expect(rejection.detail).not.toContain("script");
  });
});

describe("linear toEvent", () => {
  it("normalizes an issue create", async () => {
    const payload = { action: "create", type: "Issue", organizationId: "org-1", url: "https://linear.app/t/issue/TKAI-9", data: { id: "i1", identifier: "TKAI-9", title: "Fix bug", team: { key: "TKAI", id: "team-1" }, creatorId: "u-1" } };
    const verified = await issueDef.verify(makeReq(payload), { webhookSecret: SECRET });
    const event = issueDef.toEvent(verified!);
    expect(event.key).toBe("linear.issue.create");
    expect(event.dedupeKey).toBe("del-1");
    expect(event.refs.team).toBe("TKAI");
    expect(event.refs.identifier).toBe("TKAI-9");
    expect(event.summary).toContain("TKAI-9");
  });
});
