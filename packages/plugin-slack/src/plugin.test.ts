/**
 * The identity-link declaration's contract with the transport and the web
 * card: the anchor DM `deliveryDm` must carry NO link code (the code lives
 * only in the authenticated web response — the user carrying it into the
 * chat is the ownership proof), while still showing the reply shape the
 * transport's `LINK_COMMAND_RE` parses.
 */
import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";
import { LINK_COMMAND_RE } from "./transport/transport.js";

function deliveryDm(): string {
  const dm = plugin.identityLink?.deliveryDm;
  if (dm === undefined) throw new Error("slack plugin must declare identityLink.deliveryDm");
  return dm;
}

describe("identityLink.deliveryDm", () => {
  it("carries no code — only the <code> placeholder", () => {
    const dm = deliveryDm();
    expect(dm).toContain("link <code>");
    // No line is a complete link command with anything but the placeholder.
    // A real code here would let a bare reply complete a link the replier
    // never initiated.
    for (const line of dm.split("\n").map((l) => l.replaceAll("`", ""))) {
      const match = LINK_COMMAND_RE.exec(line);
      if (match) expect(match[1]).toBe("<code>");
    }
  });

  it("shows a reply shape the transport parser accepts once the code is filled in", () => {
    const filled = deliveryDm().replace("<code>", "abc-123_XY");
    const codeLine = filled
      .split("\n")
      .flatMap((line) => line.split(": "))
      .map((part) => part.replaceAll("`", "").split(" — ")[0] ?? "")
      .find((part) => LINK_COMMAND_RE.test(part));
    if (codeLine === undefined) throw new Error("no part of the DM matches LINK_COMMAND_RE after filling <code>");
    expect(LINK_COMMAND_RE.exec(codeLine)?.[1]).toBe("abc-123_XY");
  });

  it("names the ten-minute expiry and tells an unexpecting recipient to ignore it", () => {
    expect(deliveryDm()).toContain("10 minutes");
    expect(deliveryDm()).toContain("ignore this message");
  });
});
