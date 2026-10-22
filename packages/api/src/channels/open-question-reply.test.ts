import { describe, expect, it } from "vitest";
import { cardForReply } from "./open-question-reply.js";

describe("cardForReply", () => {
  const refs = new Map([
    ["slack:T1:D1:100.1#200.5", { gateId: "g-dm" }],
    ["slack:T1:C9:300.1#300.9", { gateId: "g-channel" }],
  ]);

  it("finds the card a reply hangs under by the card's own timestamp", () => {
    expect(cardForReply(refs, "slack:T1:D1:200.5")).toEqual({ gateId: "g-dm" });
  });

  it("ignores a reply in another channel or under another message", () => {
    expect(cardForReply(refs, "slack:T1:D2:200.5")).toBeUndefined();
    expect(cardForReply(refs, "slack:T1:D1:200.6")).toBeUndefined();
    expect(cardForReply(refs, "no-colon")).toBeUndefined();
  });
});
