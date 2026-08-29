import { describe, expect, it } from "vitest";
import { protocolMarkdown } from "./protocol.js";
import { PROTOCOL_VERSION } from "./state-doc.js";

describe("protocolMarkdown", () => {
  it("returns the state-doc contract naming the validated protocol version", () => {
    const md = protocolMarkdown();
    expect(md).toContain(`State Doc Protocol (version ${PROTOCOL_VERSION})`);
    expect(md).toContain("protocol_version: 1");
    // Cached second read returns identical content.
    expect(protocolMarkdown()).toBe(md);
  });
});
