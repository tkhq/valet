import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { NativeImageBridge, NATIVE_IMAGE_RESULT_TOOL } from "../src/native-images.js";
import { bundledModel } from "../src/model-catalog.js";
import { VirtualSandbox } from "../src/providers/sandbox/virtual.js";
import type { ToolContext } from "../src/types.js";
import { imageAttachment, imageDecoder } from "../src/image-output.js";

const model = bundledModel("openai", "gpt-6.1-sol");
if (!model) throw new Error("missing model");
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
const base64 = png.toString("base64");
afterEach(() => vi.unstubAllGlobals());

function wire(items: unknown[], terminal = "completed"): Response {
  const events = items.map((item, output_index) => ({ type: "response.output_item.done", item, output_index }));
  const response = { id: "resp_test", status: terminal, output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return new Response([...events, { type: `response.${terminal}`, response }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function mockProvider(items: unknown[], terminal = "completed") {
  const fetchMock = vi.fn<typeof fetch>(async () => wire(items, terminal));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function item(id = "img_1") { return { id, type: "image_generation_call", status: "completed", result: base64, output_format: "png" }; }

it("captures every native result, deduplicates final output, and saves before the receipt", async () => {
  const fetchMock = mockProvider([item(), item("img_2")]);
  const sandbox = new VirtualSandbox("s");
  const write = vi.spyOn(sandbox, "writeBinary");
  const bridge = new NativeImageBridge();
  const stream = bridge.stream(model, { messages: [{ role: "user", content: "Draw two squares", timestamp: 1 }] }, { apiKey: "fixture-key", maxRetries: 0 }, sandbox);
  const final = await stream.result();
  expect(final.stopReason).toBe("toolUse");
  const calls = final.content.filter((block) => block.type === "toolCall");
  expect(calls).toHaveLength(2);
  expect(write).toHaveBeenCalledTimes(2);
  for (const call of calls) {
    expect(call.name).toBe(NATIVE_IMAGE_RESULT_TOOL);
    if (typeof call.arguments.path !== "string") throw new Error("missing path");
    expect(await sandbox.readBinary(call.arguments.path)).toEqual(new Uint8Array(png));
  }
  const [, init] = fetchMock.mock.calls[0];
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-6.1-sol", tools: [{ type: "image_generation", model: "gpt-image-2.5-sunburst", output_format: "png", quality: "auto" }] });
});

it.each([null, "broken", "aGVsbG8="])("rejects malformed or null native image %j without a file", async (result) => {
  mockProvider([{ ...item(), result }]);
  const sandbox = new VirtualSandbox("s");
  const write = vi.spyOn(sandbox, "writeBinary");
  const final = await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "fixture-key", maxRetries: 0 }, sandbox).result();
  expect(final.stopReason).toBe("error");
  expect(write).not.toHaveBeenCalled();
  expect(final.content.some((block) => block.type === "toolCall")).toBe(false);
});

it.each(["failed", "incomplete"])("rejects a %s native call", async (status) => {
  mockProvider([{ ...item(), status }]);
  const sandbox = new VirtualSandbox("s");
  const write = vi.spyOn(sandbox, "writeBinary");
  expect((await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "fixture-key", maxRetries: 0 }, sandbox).result()).stopReason).toBe("error");
  expect(write).not.toHaveBeenCalled();
});

it("reports no success if the sandbox write fails", async () => {
  mockProvider([item()]);
  const sandbox = new VirtualSandbox("s");
  vi.spyOn(sandbox, "writeBinary").mockRejectedValue(new Error("disk full"));
  const final = await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "fixture-key", maxRetries: 0 }, sandbox).result();
  expect(final.stopReason).toBe("error");
  expect(final.errorMessage).toContain("Check the sandbox storage");
  expect(final.content.some((block) => block.type === "toolCall")).toBe(false);
});

it("propagates abort before the sandbox write", async () => {
  mockProvider([item()]);
  const sandbox = new VirtualSandbox("s");
  const abort = new AbortController();
  vi.spyOn(sandbox, "mkdir").mockImplementation(async () => { abort.abort(); });
  const write = vi.spyOn(sandbox, "writeBinary");
  const final = await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "fixture-key", signal: abort.signal, maxRetries: 0 }, sandbox).result();
  expect(final.stopReason).toBe("aborted");
  expect(write).not.toHaveBeenCalled();
});

it("bounds the model-facing image after base64 encoding", async () => {
  const original = await sharp(randomBytes(1536 * 1024 * 4), { raw: { width: 1536, height: 1024, channels: 4 } }).png().toBuffer();
  const preview = await imageAttachment(original, "png", await imageDecoder());
  expect(Buffer.from(preview).toString("base64").length).toBeLessThan(5 * 1024 * 1024);
  expect((await sharp(preview).metadata()).width).toBe(1024);
});

it("does not offer hosted tools to unknown models", async () => {
  const fetchMock = mockProvider([]);
  await new NativeImageBridge().stream({ ...model, id: "unknown" }, { messages: [] }, { apiKey: "fixture-key", maxRetries: 0 }, new VirtualSandbox("s")).result();
  const [, init] = fetchMock.mock.calls[0];
  expect(JSON.stringify(JSON.parse(String(init?.body)).tools ?? [])).not.toContain("image_generation");
});

it("recovers a persisted receipt with sandbox bytes after bridge restart", async () => {
  const sandbox = new VirtualSandbox("restart");
  const path = "generated-images/1234-abcd.png";
  await sandbox.writeBinary(path, png);
  const ctx = { sandbox, signal: new AbortController().signal } as ToolContext;
  const result = await new NativeImageBridge().tool().execute({ path, image_id: "img_restored" }, ctx);
  expect(result.text).toContain(path);
  expect(Buffer.from(result.attachments?.[0]?.data ?? []).equals(png)).toBe(true);
  await expect(new NativeImageBridge().tool().execute({ path: "../../secret.png", image_id: "img_restored" }, ctx)).rejects.toThrow("Invalid native image receipt");
});

it("hides only pinned generation and internal receipts from native requests", async () => {
  const fetchMock = mockProvider([]);
  await new NativeImageBridge().stream(model, { messages: [{ role: "system", content: "tools", timestamp: 1,
    toolsAdded: [NATIVE_IMAGE_RESULT_TOOL, "openai__generate_image", "openai__edit_image"].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } })) }] },
    { apiKey: "fixture-key", maxRetries: 0 }, new VirtualSandbox("s")).result();
  const [, init] = fetchMock.mock.calls[0];
  const tools: unknown[] = JSON.parse(String(init?.body)).tools;
  expect(JSON.stringify(tools)).toContain("openai__edit_image");
  expect(JSON.stringify(tools)).not.toContain("openai__generate_image");
  expect(JSON.stringify(tools)).not.toContain(NATIVE_IMAGE_RESULT_TOOL);
});

it.each(["png", "jpeg", "webp"] as const)("validates native %s bytes and retains the correct extension", async (format) => {
  const bytes = await sharp(png).toFormat(format).toBuffer();
  mockProvider([{ ...item(), result: bytes.toString("base64"), output_format: format }]);
  const sandbox = new VirtualSandbox("format");
  const final = await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "fixture-key", maxRetries: 0 }, sandbox).result();
  const receipt = final.content.find((block) => block.type === "toolCall");
  if (receipt?.type !== "toolCall" || typeof receipt.arguments.path !== "string") throw new Error("missing receipt");
  expect(receipt.arguments.path).toMatch(new RegExp(`\\.${format === "jpeg" ? "jpg" : format}$`));
  expect(Buffer.from(await sandbox.readBinary(receipt.arguments.path)).equals(bytes)).toBe(true);
});
it("rejects a declared format that differs from the bytes", async () => {
  mockProvider([{ ...item(), output_format: "webp" }]);
  const sandbox = new VirtualSandbox("mismatch");
  const write = vi.spyOn(sandbox, "writeBinary");
  expect((await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "fixture-key", maxRetries: 0 }, sandbox).result()).stopReason).toBe("error");
  expect(write).not.toHaveBeenCalled();
});
