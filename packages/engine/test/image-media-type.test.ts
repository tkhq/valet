import { entriesToAgentMessages } from "../src/thread.js";
import type { MessageEntry } from "../src/types.js";
import { describe, expect, it } from "vitest";
import { correctImageBlocks, sniffImageMediaType } from "../src/image-media-type.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const img = (b: Buffer, mimeType: string) => ({ type: "image", data: b.toString("base64"), mimeType });
const run = (block: unknown) =>
  (correctImageBlocks([{ role: "user", content: [{ type: "text", text: "hi" }, block] }])[0] as { content: unknown[] }).content[1];

describe("image media type correction", () => {
  it("sniffs supported formats", () => {
    expect(sniffImageMediaType(WEBP)).toBe("image/webp");
    expect(sniffImageMediaType(Buffer.from("GIF89a"))).toBe("image/gif");
  });
  it("sends a PNG labelled image/jpeg as image/png", () => {
    expect(run(img(PNG, "image/jpeg"))).toMatchObject({ type: "image", mimeType: "image/png" });
  });
  it("fixes a JPEG labelled image/png, also in tool results", () => {
    expect(run(img(JPEG, "image/png"))).toMatchObject({ mimeType: "image/jpeg" });
    const [m] = correctImageBlocks([{ role: "toolResult", content: [img(JPEG, "image/png")] }]) as Array<{ content: unknown[] }>;
    expect(m.content[0]).toMatchObject({ mimeType: "image/jpeg" });
  });
  it("replaces unsupported bytes with a text placeholder", () => {
    expect(run(img(Buffer.from("<html>nope</html>"), "image/png"))).toMatchObject({ type: "text" });
  });
  it("keeps a correct block unchanged", () => {
    const block = img(PNG, "image/png");
    expect(run(block)).toBe(block);
  });
  it.each([
    ["4-byte PNG prefix", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["PNG prefix with wrong tail", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])],
    ["4-byte GIF8", Buffer.from("GIF8")],
    ["GIF80x", Buffer.from("GIF80a")],
  ])("replaces %s with a placeholder", (_name, bytes) => {
    expect(run(img(bytes, "image/png"))).toMatchObject({ type: "text" });
  });

  it("builds a correct provider request from a stored thread with a mislabelled image", () => {
    const entry: MessageEntry = {
      id: "e1", sessionId: "s", threadId: "t", parentId: null, createdAt: 1, type: "message", role: "user",
      content: "look",
      attachments: [{ type: "image", data: new Uint8Array(PNG), mimeType: "image/jpeg" }],
    };
    const restored = entriesToAgentMessages([entry], { api: "anthropic", provider: "anthropic", id: "model" });
    const [msg] = correctImageBlocks(restored) as Array<{ content: Array<{ type: string; mimeType?: string }> }>;
    expect(msg.content.find((c) => c.type === "image")?.mimeType).toBe("image/png");
  });
});
