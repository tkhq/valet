/**
 * The identity-link declaration's contract with the transport and the web
 * card: the `deliveryDm` carries the code for the person to type into
 * Valet (v1's flow) and never phrases it as a chat command, and
 * `deliveryReply` must build a line the transport's `LINK_COMMAND_RE`
 * parses verbatim, because the show-code card tells the user to send it
 * unchanged.
 */
import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";
import { LINK_COMMAND_RE } from "./transport/transport.js";

const link = plugin.identityLink;
if (!link?.deliveryDm || !link.deliveryReply) {
  throw new Error("slack plugin must declare identityLink.deliveryDm and .deliveryReply");
}
const deliveryReply = link.deliveryReply;
const CODE = "Ab3_dE-9fGh1jK2lMn4pQr";
const dm = link.deliveryDm({ code: CODE });

describe("identityLink.deliveryDm", () => {
  it("carries the code in a code span, so mrkdwn cannot italicize an underscore", () => {
    expect(dm).toContain(`\`${CODE}\``);
    // No angle brackets for the code-span path to restore raw.
    expect(dm).not.toMatch(/[<>]/);
  });

  it("never phrases the code as a chat command", () => {
    // The host never redeems a DMed code from chat; the DM must not invite it.
    for (const candidate of dm.replaceAll("`", "").split(/[\n.]/)) {
      expect(LINK_COMMAND_RE.test(candidate.trim())).toBe(false);
    }
  });

  it("says to enter the code in Valet, names the expiry, and tells an unexpecting recipient to ignore it", () => {
    expect(dm).toContain("Enter it in Valet");
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
