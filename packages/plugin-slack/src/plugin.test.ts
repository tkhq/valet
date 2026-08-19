/**
 * The identity-link declaration's contract with the transport and the web
 * card: the DM `deliveryDm` builds must contain a line the transport's own
 * `LINK_COMMAND_RE` accepts, and the card echoes the string byte-identical,
 * so it must be deterministic.
 */
import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";
import { LINK_COMMAND_RE } from "./transport/transport.js";

function deliveryDm(code: string): string {
  const build = plugin.identityLink?.deliveryDm;
  if (!build) throw new Error("slack plugin must declare identityLink.deliveryDm");
  return build({ code });
}

describe("identityLink.deliveryDm", () => {
  it("embeds the code in a link line the transport's parser accepts", () => {
    const dm = deliveryDm("abc-123_XY");
    const codeLine = dm
      .split("\n")
      .map((line) => line.replaceAll("`", ""))
      .find((line) => LINK_COMMAND_RE.test(line));
    if (codeLine === undefined) throw new Error("no line of the DM matches LINK_COMMAND_RE");
    expect(LINK_COMMAND_RE.exec(codeLine)?.[1]).toBe("abc-123_XY");
  });

  it("is deterministic — the card's echo must match the DM byte-identical", () => {
    expect(deliveryDm("abc")).toBe(deliveryDm("abc"));
  });

  it("names the ten-minute expiry", () => {
    expect(deliveryDm("abc")).toContain("10 minutes");
  });
});
