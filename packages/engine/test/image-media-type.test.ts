import { entriesToAgentMessages } from "../src/thread.js";
import type { MessageEntry } from "../src/types.js";
import { describe, expect, it } from "vitest";
import { correctImageBlocks, isSafeSvg, sniffImageMediaType, validatedImageMediaType } from "../src/image-media-type.js";

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

describe("validatedImageMediaType", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

  it("takes the type from raster bytes, whatever the name says", () => {
    expect(validatedImageMediaType(png, "chart.bin")).toBe("image/png");
  });

  it("refuses an image name whose bytes are not an image", () => {
    expect(validatedImageMediaType(encode("<html>not an image</html>"), "report.png")).toBeUndefined();
    expect(validatedImageMediaType(encode("plain text"), "photo.jpg")).toBeUndefined();
  });

  it("accepts a well-formed SVG with an svg root, including a declaration and a comment", () => {
    expect(validatedImageMediaType(encode('<?xml version="1.0"?>\n<!-- chart -->\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n'), "chart.svg")).toBe("image/svg+xml");
  });

  it.each([
    ["a script element", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["an event handler", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ["a javascript URL", '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)">x</a></svg>'],
    ["a DOCTYPE", '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ["an HTML root", "<html><svg></svg></html>"],
    ["no closing tag", '<svg xmlns="http://www.w3.org/2000/svg"><rect/>'],
  ])("refuses an SVG with %s", (_label, text) => {
    expect(isSafeSvg(encode(text))).toBe(false);
    expect(validatedImageMediaType(encode(text), "chart.svg")).toBeUndefined();
  });

  it("accepts a self-closed svg root", () => {
    expect(isSafeSvg(encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
  });

  it("does not treat SVG text as an image without the .svg name", () => {
    expect(validatedImageMediaType(encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "notes.txt")).toBeUndefined();
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(isSafeSvg(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe]))).toBe(false);
  });
});
