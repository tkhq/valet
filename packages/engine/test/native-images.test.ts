import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "../src/index.js";
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
  const response = { id: "resp_test", status: terminal, output: items, ...(terminal === "failed" ? { error: { code: "server_error", message: "503 Service unavailable" } } : {}), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
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

it.each(["response-failure", "second-image-failure"])("delivers saved receipts after %s without regenerating", async (failure) => {
  const fetchMock = mockProvider(failure === "response-failure" ? [item()] : [item(), { ...item("img_failed"), status: "failed" }], failure === "response-failure" ? "failed" : "completed");
  const sandbox = new VirtualSandbox("partial-save");
  const bridge = new NativeImageBridge();
  const final = await bridge.stream(model, { messages: [] }, { apiKey: "fixture-key", maxRetries: 2 }, sandbox).result();
  expect(final.stopReason).toBe("toolUse");
  expect(final.errorMessage).toBeUndefined();
  const calls = final.content.filter((block) => block.type === "toolCall");
  expect(calls).toHaveLength(1);
  expect(calls[0].name).toBe(NATIVE_IMAGE_RESULT_TOOL);
  expect(bridge.savedInTurn).toBe(true);
  expect(bridge.enabled(model)).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  if (typeof calls[0].arguments.path !== "string") throw new Error("missing receipt");
  expect(Buffer.from(await sandbox.readBinary(calls[0].arguments.path)).equals(png)).toBe(true);
  const result = await bridge.tool().execute(calls[0].arguments, { sandbox, signal: new AbortController().signal } as ToolContext);
  expect(result.text).toContain(calls[0].arguments.path);
});

it("retains the paid original and its receipt if preview creation fails", async () => {
  const helpers = await import("../src/image-output.js");
  const preview = vi.spyOn(helpers, "imageAttachment").mockRejectedValue(new Error("preview failed"));
  try {
    mockProvider([item()]);
    const sandbox = new VirtualSandbox("preview-failure");
    const bridge = new NativeImageBridge();
    const write = vi.spyOn(sandbox, "writeBinary");
    const final = await bridge.stream(model, { messages: [] }, { apiKey: "fixture-key", maxRetries: 0 }, sandbox).result();
    const call = final.content.find((block) => block.type === "toolCall");
    if (call?.type !== "toolCall" || typeof call.arguments.path !== "string") throw new Error("missing receipt");
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(preview.mock.invocationCallOrder[0]);
    expect(Buffer.from(await sandbox.readBinary(call.arguments.path)).equals(png)).toBe(true);
    const result = await bridge.tool().execute(call.arguments, { sandbox, signal: new AbortController().signal } as ToolContext);
    expect(JSON.parse(result.text)).toMatchObject({ path: call.arguments.path, warning: expect.stringContaining("do not regenerate") });
    expect(result.attachments).toBeUndefined();
  } finally { preview.mockRestore(); }
});

it.each([
  [400, "image_generation is not supported for this model"],
  [403, "Your organization does not have access to gpt-image-2.5-sunburst"],
  [403, "Your organization must be verified to use gpt-image-2.5-sunburst"],
  [404, "gpt-image-2.5-sunburst model not found"],
  [403, "This API key does not have permission to use image_generation"],
  [403, "gpt-image-2.5-sunburst is not available in your billing tier"],
] as const)("retries a %s image-tool rejection once without hosted tools", async (status, message) => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param: "tools" } }), { status, headers: { "content-type": "application/json" } }))
    .mockResolvedValueOnce(wire([{ type: "message", id: "msg_chat", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Chat still works.", annotations: [] }] }]));
  vi.stubGlobal("fetch", fetchMock);
  const bridge = new NativeImageBridge();
  const context = { messages: [{ role: "system" as const, content: "tools", timestamp: 1, toolsAdded: [{ name: "openai__generate_image", description: "Generate", parameters: { type: "object", properties: {} } }] }] };
  const final = await bridge.stream(model, context, { apiKey: "sk-fixture-key", maxRetries: 0 }, new VirtualSandbox("access")).result();
  expect(final.stopReason).toBe("stop");
  expect(final.content).toContainEqual(expect.objectContaining({ type: "text", text: "Chat still works." }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0].tools).toContainEqual({ type: "image_generation", model: "gpt-image-2.5-sunburst", output_format: "png", quality: "auto" });
  expect(JSON.stringify(bodies[1].tools)).not.toContain('"type":"image_generation"');
  expect(JSON.stringify(bodies[1].tools)).toContain("openai__generate_image");
  expect(JSON.stringify(bodies[1].input)).not.toContain("Use native image_generation");
  expect(bridge.enabled(model)).toBe(false);
});

it.each([
  [401, "invalid API key for image_generation"],
  [400, "invalid image_generation output format"],
  [429, "image_generation quota exceeded"],
  [404, "main chat model not found"],
  [503, "Service unavailable"],
  [500, "image_generation unavailable for the image labelled 400"],
] as const)("does not retry unrelated request rejection %s: %s", async (status, message) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  expect((await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, new VirtualSandbox("unrelated")).result()).stopReason).toBe("error");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("makes only one tool-free retry when that retry is also rejected", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ error: { message: "image_generation not supported" } }), { status: 400 }));
  vi.stubGlobal("fetch", fetchMock);
  expect((await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, new VirtualSandbox("twice")).result()).stopReason).toBe("error");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("omits only orphaned image-turn reasoning from the exact replay payload", async () => {
  const reasoning = { type: "reasoning", id: "rs_image", summary: [{ type: "summary_text", text: "Draw an image" }], encrypted_content: "encrypted-image-reasoning" };
  const fetchMock = mockProvider([reasoning, item()]);
  const bridge = new NativeImageBridge();
  const sandbox = new VirtualSandbox("reasoning-replay");
  const user = { role: "user" as const, content: "Draw a square", timestamp: 1 };
  const final = await bridge.stream(model, { messages: [user] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  expect(final.content).toContainEqual({ type: "thinking", thinking: "Draw an image", thinkingSignature: JSON.stringify(reasoning) });
  const call = final.content.find((block) => block.type === "toolCall");
  if (call?.type !== "toolCall") throw new Error("missing receipt");
  const result = await bridge.tool().execute(call.arguments, { sandbox, signal: new AbortController().signal } as ToolContext);
  const unrelatedReasoning = { ...reasoning, id: "rs_unrelated", encrypted_content: "encrypted-unrelated" };
  const prior: typeof final = { ...final, content: [{ type: "thinking", thinking: "Prior task", thinkingSignature: JSON.stringify(unrelatedReasoning) }, { type: "text", text: "Prior answer", textSignature: "msg_prior" }] };
  fetchMock.mockImplementation(async () => wire([]));
  await bridge.stream(model, { messages: [prior, user, final, {
    role: "toolResult", toolCallId: call.id, toolName: NATIVE_IMAGE_RESULT_TOOL,
    content: [{ type: "text", text: result.text }, { type: "image", data: base64, mimeType: "image/png" }], isError: false, timestamp: 2,
  }, { role: "user", content: "Make it blue", timestamp: 3 }] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  const [, init] = fetchMock.mock.calls[1];
  const body = JSON.parse(String(init?.body));
  expect(body.input).toEqual([
    unrelatedReasoning,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Prior answer", annotations: [] }], status: "completed", id: "msg_prior" },
    { role: "user", content: [{ type: "input_text", text: "Draw a square" }] },
    { role: "user", content: [{ type: "input_text", text: result.text }, { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${base64}` }] },
    { role: "user", content: [{ type: "input_text", text: "Make it blue" }] },
  ]);
  expect(JSON.stringify(body.input)).not.toContain("rs_image");
});

it.each([false, true])("blocks retries after an image is saved (earlier retry: %s)", async (earlierRetry) => {
  const store = new InMemorySessionStore();
  const events = new InMemoryEventStream();
  const engine = new Engine({ providers: { store, stream: events, sandboxProvider: new VirtualSandboxProvider() } });
  const fallback = vi.fn(async () => null);
  const fetchMock = vi.fn<typeof fetch>();
  if (earlierRetry) fetchMock.mockResolvedValueOnce(wire([], "failed"));
  fetchMock.mockResolvedValueOnce(wire([item()], "failed"))
    .mockImplementation(async () => wire([], "failed"));
  vi.stubGlobal("fetch", fetchMock);
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/workspace", sandbox: {}, model,
    purpose: "child", turnRetry: { maxAttempts: 2, backoffMs: [1] }, resolveFallbackModel: fallback,
    resolveModel: async () => ({ model, apiKey: "sk-fixture-key" }),
  });
  let settled = false;
  events.subscribe({ sessionId: session.id }, ({ event }) => { if (event.type === "submission_settled") settled = true; });
  try {
    const receipt = await session.prompt("Draw a square");
    await expect.poll(() => settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(earlierRetry ? 3 : 2);
    expect(fallback).toHaveBeenCalledTimes(earlierRetry ? 1 : 0);
    const messages = await store.getEntries(session.id, receipt.threadId);
    expect(JSON.stringify(messages)).toContain("generated-images/");
    expect(JSON.stringify(messages)).toContain(NATIVE_IMAGE_RESULT_TOOL);
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.filter((request) => request.tools?.some((tool: { type: string }) => tool.type === "image_generation"))).toHaveLength(earlierRetry ? 2 : 1);
  } finally { await session.destroy(); }
});

it("reports a saved path even if the turn aborts immediately after its write", async () => {
  mockProvider([item()]);
  const sandbox = new VirtualSandbox("abort-after-save");
  const controller = new AbortController();
  const write = sandbox.writeBinary.bind(sandbox);
  vi.spyOn(sandbox, "writeBinary").mockImplementation(async (path, bytes) => { await write(path, bytes); controller.abort(); });
  const bridge = new NativeImageBridge();
  const final = await bridge.stream(model, { messages: [] }, { apiKey: "sk-fixture-key", signal: controller.signal, maxRetries: 0 }, sandbox).result();
  expect(final.stopReason).toBe("aborted");
  const path = final.errorMessage?.match(/generated-images\/[a-f0-9-]+\.png/)?.[0];
  if (!path) throw new Error("missing saved path in abort error");
  expect(Buffer.from(await sandbox.readBinary(path)).equals(png)).toBe(true);
  expect(bridge.savedInTurn).toBe(true);
});

it("does not retry a streamed image-tool error as a request-time rejection", async () => {
  const response = new Response('data: {"type":"response.failed","response":{"status":"failed","error":{"message":"403 image_generation access unavailable"}}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  expect((await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, new VirtualSandbox("stream-rejection")).result()).stopReason).toBe("error");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("propagates a replay-tool abort instead of treating it as a preview failure", async () => {
  const helpers = await import("../src/image-output.js");
  const controller = new AbortController();
  const preview = vi.spyOn(helpers, "imageAttachment").mockImplementation(async () => { controller.abort(); return png; });
  try {
    const sandbox = new VirtualSandbox("replay-abort");
    const path = "generated-images/1234-abcd.png";
    await sandbox.writeBinary(path, png);
    await expect(new NativeImageBridge().tool().execute({ path, image_id: "img_saved" }, { sandbox, signal: controller.signal } as ToolContext)).rejects.toMatchObject({ name: "AbortError" });
    expect(Buffer.from(await sandbox.readBinary(path)).equals(png)).toBe(true);
  } finally { preview.mockRestore(); }
});
