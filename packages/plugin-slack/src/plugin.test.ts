/**
 * The identity-link declaration's contract with the transport and the web
 * card: the anchor DM `deliveryDm` must carry no code-shaped token (the
 * code lives only in the authenticated web response — the user carrying it
 * into the chat is the ownership proof), and `deliveryReply` must build a
 * line the transport's `LINK_COMMAND_RE` parses verbatim, because the card
 * tells the user to send it unchanged.
 */
import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";
import { LINK_COMMAND_RE } from "./transport/transport.js";

const link = plugin.identityLink;
if (!link?.deliveryDm || !link.deliveryReply) {
  throw new Error("slack plugin must declare identityLink.deliveryDm and .deliveryReply");
}
const dm = link.deliveryDm;
const deliveryReply = link.deliveryReply;

describe("identityLink.deliveryDm", () => {
  it("carries no code-shaped token", () => {
    // Link codes are 22-char base64url (mintLinkCode). Any long
    // [A-Za-z0-9_-] run in the DM means a code (or something a recipient
    // could mistake for one) leaked into the unauthenticated channel.
    expect(dm).not.toMatch(/[A-Za-z0-9_-]{16,}/);
    // And no token in the DM parses as a complete link command.
    for (const candidate of dm.split(/[\n.]/)) {
      expect(LINK_COMMAND_RE.test(candidate.trim())).toBe(false);
    }
  });

  it("is plain prose — no backticks or angle brackets for the mrkdwn code-span path to mangle", () => {
    expect(dm).not.toMatch(/[`<>]/);
  });

  it("points at Valet for the command, names the expiry, and tells an unexpecting recipient to ignore it", () => {
    expect(dm).toContain("shown in Valet");
    expect(dm).toContain("10 minutes");
    expect(dm).toContain("ignore this message");
  });
});

describe("identityLink.deliveryReply", () => {
  it("builds a line LINK_COMMAND_RE parses verbatim — the card promises it can be sent unchanged", () => {
    const reply = deliveryReply({ code: "abc-123_XY" });
    expect(LINK_COMMAND_RE.exec(reply)?.[1]).toBe("abc-123_XY");
  });

  it("is deterministic", () => {
    expect(deliveryReply({ code: "abc" })).toBe(deliveryReply({ code: "abc" }));
  });
});
