import { createAssistantMessageEventStream, getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { Type } from "typebox";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type ActionPlugin, type PolicyInvocationRecord, type PolicyResolver } from "../src/index.js";
import { buildPluginCatalog } from "../src/plugin-catalog.js";
import { ELIDED_TOOL_OUTPUT, walkTranscriptDag } from "../src/compaction.js";
import { NativeImageBridge, NATIVE_IMAGE_RESULT_TOOL, NATIVE_IMAGE_TOOL_PARAMS } from "../src/native-images.js";
import { isAnimatedPng, validateImage } from "../src/image-output.js";
import { crc32 } from "node:zlib";
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
/** Raw SSE for streams that end mid-call. `wire` only models complete items. */
function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
/** The plugin action native generation stands in for. Its policy decides whether the hosted tool is offered. */
const openaiPlugin: ActionPlugin = { service: "openai", actions: ["generate_image", "edit_image"].map((name) => ({
  id: `openai.${name}`, name, description: name, riskLevel: "low" as const, parameters: Type.Object({}), execute: async () => ({ success: true }),
})) };
const openaiCatalog = () => buildPluginCatalog([openaiPlugin]);
function requestTools(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): string {
  const [, init] = fetchMock.mock.calls[index];
  return JSON.stringify(JSON.parse(String(init?.body)).tools ?? []);
}

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
  expect(bridge.savedInRequest).toBe(true);
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
  // The retry did not offer the hosted tool, so its plugin generation must not be hidden.
  expect(bridge.offered).toBe(false);
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

it.each([false, true])("replays image-turn items without orphaned IDs (mixed response: %s)", async (mixed) => {
  const reasoning = { type: "reasoning", id: "rs_image", summary: [{ type: "summary_text", text: "Draw an image" }], encrypted_content: "encrypted-image-reasoning" };
  const text = { type: "message", id: "msg_image", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Checking the image", annotations: [] }] };
  const bash = { type: "function_call", id: "fc_image_bash", call_id: "call_image_bash", name: "bash", arguments: '{"command":"ls"}', status: "completed" };
  const fetchMock = mockProvider([reasoning, item(), ...(mixed ? [text, bash] : [])]);
  const bridge = new NativeImageBridge();
  const sandbox = new VirtualSandbox("reasoning-replay");
  const user = { role: "user" as const, content: "Draw a square", timestamp: 1 };
  const final = await bridge.stream(model, { messages: [user] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  expect(final.content).toContainEqual({ type: "thinking", thinking: "Draw an image", thinkingSignature: JSON.stringify(reasoning) });
  const call = final.content.find((block) => block.type === "toolCall" && block.name === NATIVE_IMAGE_RESULT_TOOL);
  if (call?.type !== "toolCall") throw new Error("missing receipt");
  if (mixed) {
    expect(final.content).toContainEqual({ type: "text", text: "Checking the image", textSignature: JSON.stringify({ v: 1, id: "msg_image", phase: "commentary" }) });
    expect(final.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "call_image_bash|fc_image_bash", name: "bash" }));
    // Tools run in content order: the receipt must run before a slow or gated call can be stopped.
    const names = final.content.filter((block) => block.type === "toolCall").map((block) => block.name);
    expect(names).toEqual([NATIVE_IMAGE_RESULT_TOOL, "bash"]);
  }
  const result = await bridge.tool().execute(call.arguments, { sandbox, signal: new AbortController().signal } as ToolContext);
  const unrelatedReasoning = { ...reasoning, id: "rs_unrelated", encrypted_content: "encrypted-unrelated" };
  const prior: typeof final = { ...final, content: [{ type: "thinking", thinking: "Prior task", thinkingSignature: JSON.stringify(unrelatedReasoning) }, { type: "text", text: "Prior answer", textSignature: "msg_prior" }] };
  fetchMock.mockImplementation(async () => wire([]));
  await bridge.stream(model, { messages: [prior, user, final, ...(mixed ? [{
    role: "toolResult" as const, toolCallId: "call_image_bash|fc_image_bash", toolName: "bash",
    content: [{ type: "text" as const, text: "image.png" }], isError: false, timestamp: 2,
  }] : []), {
    role: "toolResult", toolCallId: call.id, toolName: NATIVE_IMAGE_RESULT_TOOL,
    content: [{ type: "text", text: result.text }, { type: "image", data: base64, mimeType: "image/png" }], isError: false, timestamp: 2,
  }, { role: "user", content: "Make it blue", timestamp: 3 }] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  const [, init] = fetchMock.mock.calls[1];
  const body = JSON.parse(String(init?.body));
  expect(body.input).toEqual([
    unrelatedReasoning,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Prior answer", annotations: [] }], status: "completed", id: "msg_prior" },
    { role: "user", content: [{ type: "input_text", text: "Draw a square" }] },
    ...(mixed ? [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking the image", annotations: [] }], status: "completed", phase: "commentary" },
      { type: "function_call", call_id: "call_image_bash", name: "bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "call_image_bash", output: "image.png" },
    ] : []),
    { role: "user", content: [{ type: "input_text", text: result.text }, { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${base64}` }] },
    { role: "user", content: [{ type: "input_text", text: "Make it blue" }] },
  ]);
  expect(JSON.stringify(body.input)).not.toContain("rs_image");
});

it.each([false, true])("retries a later plain request without regenerating the saved image (earlier retry: %s)", async (earlierRetry) => {
  const store = new InMemorySessionStore();
  const events = new InMemoryEventStream();
  const engine = new Engine({ providers: { store, stream: events, sandboxProvider: new VirtualSandboxProvider() } });
  const fallback = vi.fn(async () => null);
  const fetchMock = vi.fn<typeof fetch>();
  if (earlierRetry) fetchMock.mockResolvedValueOnce(wire([], "failed"));
  fetchMock.mockResolvedValueOnce(wire([item()], "failed"))
    .mockResolvedValueOnce(wire([], "failed"))
    .mockImplementation(async () => wire([{ type: "message", id: "msg_recovered", role: "assistant", status: "completed", content: [{ type: "output_text", text: "The saved image is ready.", annotations: [] }] }]));
  vi.stubGlobal("fetch", fetchMock);
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/workspace", sandbox: {}, model,
    purpose: "child", turnRetry: { maxAttempts: 2, backoffMs: [1] }, resolveFallbackModel: fallback,
    resolveModel: async () => ({ model, apiKey: "sk-fixture-key" }), pluginCatalog: openaiCatalog(),
  });
  let settled = false;
  events.subscribe({ sessionId: session.id }, ({ event }) => { if (event.type === "submission_settled") settled = true; });
  try {
    const receipt = await session.prompt("Draw a square");
    await expect.poll(() => settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(earlierRetry ? 4 : 3);
    expect(fallback).toHaveBeenCalledTimes(1);
    const messages = await store.getEntries(session.id, receipt.threadId);
    expect(JSON.stringify(messages)).toContain("generated-images/");
    expect(JSON.stringify(messages)).toContain(NATIVE_IMAGE_RESULT_TOOL);
    expect(JSON.stringify(messages)).toContain("The saved image is ready.");
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.filter((request) => request.tools?.some((tool: { type: string }) => tool.type === "image_generation"))).toHaveLength(earlierRetry ? 2 : 1);
  } finally { await session.destroy(); }
});

it("allows provider fallback for a later plain request after image receipts", async () => {
  const backup = registerFauxProvider({ provider: "image-receipt-backup" });
  backup.setResponses([fauxAssistantMessage("Recovered after the image receipt.")]);
  const store = new InMemorySessionStore();
  const events = new InMemoryEventStream();
  const engine = new Engine({ providers: { store, stream: events, sandboxProvider: new VirtualSandboxProvider() } });
  const fallback = vi.fn(async () => ({ model: backup.getModel(), apiKey: "backup-key" }));
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(wire([item()], "failed"))
    .mockImplementation(async () => wire([], "failed"));
  vi.stubGlobal("fetch", fetchMock);
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/workspace", sandbox: {}, model,
    purpose: "child", resolveFallbackModel: fallback, resolveModel: async () => ({ model, apiKey: "sk-fixture-key" }), pluginCatalog: openaiCatalog(),
  });
  let settled = false;
  events.subscribe({ sessionId: session.id }, ({ event }) => { if (event.type === "submission_settled") settled = true; });
  try {
    const receipt = await session.prompt("Draw a square");
    await expect.poll(() => settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(1);
    const messages = await store.getEntries(session.id, receipt.threadId);
    expect(JSON.stringify(messages)).toContain("generated-images/");
    expect(JSON.stringify(messages)).toContain("Recovered after the image receipt.");
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.filter((request) => request.tools?.some((tool: { type: string }) => tool.type === "image_generation"))).toHaveLength(1);
  } finally {
    await session.destroy();
    backup.unregister();
  }
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
  // The thread persists an aborted message's text, not its error. The path must be in the text.
  expect(final.content).toContainEqual({ type: "text", text: expect.stringContaining(path) });
  expect(final.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: NATIVE_IMAGE_RESULT_TOOL, arguments: { path, image_id: "img_1" } }));
  expect(Buffer.from(await sandbox.readBinary(path)).equals(png)).toBe(true);
  expect(bridge.savedInRequest).toBe(true);
  // Pi drops the aborted message from the next request. The saved path must still arrive.
  const fetchMock = vi.fn<typeof fetch>(async () => wire([]));
  vi.stubGlobal("fetch", fetchMock);
  await bridge.stream(model, { messages: [final, { role: "user", content: "Make it blue", timestamp: 3 }] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  const input: unknown[] = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).input;
  expect(JSON.stringify(input)).toContain(path);
  expect(JSON.stringify(input)).not.toContain(NATIVE_IMAGE_RESULT_TOOL);
});

it("replays an interrupted receipt as its saved path", async () => {
  const fetchMock = mockProvider([item()]);
  const bridge = new NativeImageBridge();
  const sandbox = new VirtualSandbox("interrupted-replay");
  const final = await bridge.stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  const call = final.content.find((block) => block.type === "toolCall");
  if (call?.type !== "toolCall" || typeof call.arguments.path !== "string") throw new Error("missing receipt");
  fetchMock.mockImplementation(async () => wire([]));
  await bridge.stream(model, { messages: [final, {
    role: "toolResult", toolCallId: call.id, toolName: NATIVE_IMAGE_RESULT_TOOL,
    content: [{ type: "text", text: "Operation aborted" }], isError: true, timestamp: 2,
  }, { role: "user", content: "Make it blue", timestamp: 3 }] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  const input: unknown[] = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).input;
  expect(input).toContainEqual({ role: "user", content: [{ type: "input_text", text: expect.stringContaining(call.arguments.path) }] });
  expect(JSON.stringify(input)).not.toContain("Operation aborted");
});

it("rejects an animated PNG that Sharp reports as a single page", async () => {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdrEnd = 8 + 25;
  const actl = Buffer.alloc(8); actl.writeUInt32BE(2, 0); actl.writeUInt32BE(0, 4);
  const apng = Buffer.concat([png.subarray(0, ihdrEnd), chunk("acTL", actl), png.subarray(ihdrEnd)]);
  expect((await sharp(apng).metadata()).pages ?? 1).toBe(1);
  expect(isAnimatedPng(apng)).toBe(true);
  expect(isAnimatedPng(png)).toBe(false);
  await expect(validateImage(apng, sharp)).rejects.toThrow("Animated images are not accepted");
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

it("ends the stream with an error message when the provider throws before streaming", async () => {
  const original = getApiProvider("anthropic-messages");
  const stream = () => { throw new Error("No API key for anthropic"); };
  registerApiProvider({ api: "anthropic-messages", stream, streamSimple: stream }, "image-throw-test");
  try {
    const chatModel = bundledModel("anthropic", "claude-haiku-4-5");
    if (!chatModel) throw new Error("missing chat model");
    const final = await new NativeImageBridge().stream(chatModel, { messages: [] }, {}, new VirtualSandbox("throw")).result();
    expect(final).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "No API key for anthropic", content: [] });
  } finally {
    unregisterApiProviders("image-throw-test");
    if (original) registerApiProvider(original);
  }
});

it("preserves a provider final result without a terminal stream event", async () => {
  const original = getApiProvider("anthropic-messages");
  const final = fauxAssistantMessage("workflow completed");
  const stream = () => {
    const events = createAssistantMessageEventStream();
    events.end(final);
    return events;
  };
  registerApiProvider({ api: "anthropic-messages", stream, streamSimple: stream }, "image-end-result-test");
  try {
    const chatModel = bundledModel("anthropic", "claude-haiku-4-5");
    if (!chatModel) throw new Error("missing chat model");
    const wrapped = new NativeImageBridge().stream(chatModel, { messages: [] }, {}, new VirtualSandbox("end-result"));
    for await (const event of wrapped) expect(event).toBeUndefined();
    expect(await wrapped.result()).toEqual(final);
  } finally {
    unregisterApiProviders("image-end-result-test");
    if (original) registerApiProvider(original);
  }
});

const partialWrite = { type: "function_call", id: "fc_write", call_id: "call_write", name: "write", arguments: "", status: "in_progress" };
const writeDelta = { type: "response.function_call_arguments.delta", item_id: "fc_write", output_index: 1, delta: '{"path":"config.json","content":"{\\"trunc' };
const completeBash = { type: "function_call", id: "fc_bash", call_id: "call_bash", name: "bash", arguments: '{"command":"ls"}', status: "completed" };
const incompleteWrite = { ...partialWrite, arguments: '{"path":"config.json","content":"{\\"trunc', status: "incomplete" };
const cutOffs: Array<[string, unknown]> = [
  ["response.failed", { type: "response.failed", response: { id: "resp", status: "failed", error: { code: "server_error", message: "upstream failure" }, output: [item(), partialWrite] } }],
  ["response.incomplete max_output_tokens", { type: "response.incomplete", response: { id: "resp", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [item(), partialWrite] } }],
  ["response.incomplete content_filter", { type: "response.incomplete", response: { id: "resp", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [item(), partialWrite] } }],
];
it.each(cutOffs)("never runs a cut-off tool call after a saved image (%s)", async (name, terminal) => {
  // The provider may close the truncated item as done with status "incomplete"; pi still ends the call.
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => sse([
    { type: "response.output_item.done", output_index: 0, item: item() },
    { type: "response.output_item.added", output_index: 1, item: partialWrite },
    writeDelta,
    { type: "response.output_item.done", output_index: 1, item: incompleteWrite },
    terminal,
  ])));
  // Without the bridge, pi surfaces the truncated call. The bridge must not let it run.
  const raw = await streamSimple(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }).result();
  expect(raw.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "write" }));
  const sandbox = new VirtualSandbox("cut-off");
  const bridge = new NativeImageBridge();
  const final = await bridge.stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  expect(final.stopReason).toBe("toolUse");
  expect(final.errorMessage).toBeUndefined();
  const calls = final.content.filter((block) => block.type === "toolCall");
  expect(calls.map((call) => call.name)).toEqual([NATIVE_IMAGE_RESULT_TOOL]);
  const receipt = await bridge.tool().execute(calls[0].arguments, { sandbox, signal: new AbortController().signal } as ToolContext);
  const reason = name.includes("max_output_tokens") ? "length" : name.includes("content_filter") ? "content_filter" : "server_error";
  expect(JSON.parse(receipt.text)).toMatchObject({ stream_warning: expect.stringContaining(reason) });
  expect(bridge.enabled(model)).toBe(false);
});

it("keeps a tool call whose arguments finished streaming before the stream failed", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => sse([
    { type: "response.output_item.done", output_index: 0, item: item() },
    { type: "response.output_item.added", output_index: 1, item: completeBash },
    { type: "response.output_item.done", output_index: 1, item: completeBash },
    { type: "response.output_item.added", output_index: 2, item: partialWrite },
    writeDelta,
    { type: "response.failed", response: { id: "resp", status: "failed", error: { code: "server_error", message: "upstream failure" }, output: [item(), completeBash, partialWrite] } },
  ])));
  const final = await new NativeImageBridge().stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, new VirtualSandbox("complete-call")).result();
  expect(final.stopReason).toBe("toolUse");
  expect(final.content.filter((block) => block.type === "toolCall").map((call) => call.name)).toEqual([NATIVE_IMAGE_RESULT_TOOL, "bash"]);
});

it("replays a pruned receipt as its saved path", async () => {
  const fetchMock = mockProvider([item()]);
  const bridge = new NativeImageBridge();
  const sandbox = new VirtualSandbox("pruned-replay");
  const final = await bridge.stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  const call = final.content.find((block) => block.type === "toolCall");
  if (call?.type !== "toolCall" || typeof call.arguments.path !== "string") throw new Error("missing receipt");
  expect(bridge.tool().protectedFromPruning).toBeUndefined();
  fetchMock.mockImplementation(async () => wire([]));
  await bridge.stream(model, { messages: [final, {
    role: "toolResult", toolCallId: call.id, toolName: NATIVE_IMAGE_RESULT_TOOL,
    content: [{ type: "text", text: ELIDED_TOOL_OUTPUT }], isError: false, timestamp: 2,
  }, { role: "user", content: "Make it blue", timestamp: 3 }] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox).result();
  const [, init] = fetchMock.mock.calls[1];
  const input: unknown[] = JSON.parse(String(init?.body)).input;
  expect(input).toContainEqual({ role: "user", content: [{ type: "input_text", text: expect.stringContaining(call.arguments.path) }] });
  expect(JSON.stringify(input)).not.toContain(ELIDED_TOOL_OUTPUT);
  expect(JSON.stringify(input)).not.toContain(NATIVE_IMAGE_RESULT_TOOL);
});

it.each([false, "throw"] as const)("withholds the hosted tool when the policy check answers %s", async (answer) => {
  const fetchMock = mockProvider([]);
  const bridge = new NativeImageBridge();
  const permitted = answer === "throw" ? async () => { throw new Error("policy store unavailable"); } : async () => false;
  expect(bridge.offered).toBe(false);
  await bridge.stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, new VirtualSandbox("policy"), { permitted }).result();
  expect(requestTools(fetchMock)).not.toContain("image_generation");
  expect(bridge.enabled(model)).toBe(false);
  expect(bridge.offered).toBe(false);
  bridge.beginTurn();
  expect(bridge.enabled(model)).toBe(true);
});

it("checks policy once per turn, prepares the sandbox before the paid request, and reports saved originals", async () => {
  const fetchMock = mockProvider([item()]);
  const sandbox = new VirtualSandbox("prepare");
  const mkdir = vi.spyOn(sandbox, "mkdir");
  const permitted = vi.fn(async () => true);
  const saved = vi.fn();
  const bridge = new NativeImageBridge();
  await bridge.stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox, { permitted, saved }).result();
  expect(bridge.offered).toBe(true);
  expect(mkdir.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  expect(saved).toHaveBeenCalledWith({ path: expect.stringMatching(/^generated-images\//), image_id: "img_1", callId: expect.stringMatching(/^call_/) });
  await bridge.stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox, { permitted, saved }).result();
  expect(permitted).toHaveBeenCalledTimes(1);
  expect(requestTools(fetchMock, 1)).toContain("image_generation");
});

it("withholds the hosted tool when the sandbox is not ready, before any paid request", async () => {
  const fetchMock = mockProvider([item()]);
  const sandbox = new VirtualSandbox("cold");
  vi.spyOn(sandbox, "mkdir").mockRejectedValue(new Error("sandbox not ready"));
  const bridge = new NativeImageBridge();
  await bridge.stream(model, { messages: [] }, { apiKey: "sk-fixture-key", maxRetries: 0 }, sandbox, { permitted: async () => true }).result();
  expect(requestTools(fetchMock)).not.toContain("image_generation");
  expect(bridge.offered).toBe(false);
  expect(bridge.enabled(model)).toBe(false);
});

async function promptWithPolicy(options: { pluginCatalog?: ReturnType<typeof openaiCatalog>; policyResolver?: PolicyResolver }, items: unknown[] = []) {
  const store = new InMemorySessionStore();
  const events = new InMemoryEventStream();
  const engine = new Engine({ providers: { store, stream: events, sandboxProvider: new VirtualSandboxProvider() } });
  const plain = wire([{ type: "message", id: "msg_plain", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] }]);
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(items.length ? wire(items) : plain).mockImplementation(async () => wire([{ type: "message", id: "msg_plain", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] }]));
  vi.stubGlobal("fetch", fetchMock);
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/workspace", sandbox: {}, model,
    purpose: "child", resolveModel: async () => ({ model, apiKey: "sk-fixture-key" }), ...options });
  let settled = false;
  events.subscribe({ sessionId: session.id }, ({ event }) => { if (event.type === "submission_settled") settled = true; });
  try {
    await session.prompt("Draw a square");
    await expect.poll(() => settled).toBe(true);
  } finally { await session.destroy(); }
  return requestTools(fetchMock);
}

it.each(["deny", "require_approval"] as const)("offers no hosted tool when policy resolves %s for openai.generate_image", async (mode) => {
  const resolve = vi.fn(async () => ({ mode, provenance: { baseMode: mode, source: "team_policy" as const } }));
  expect(await promptWithPolicy({ pluginCatalog: openaiCatalog(), policyResolver: { resolve } })).not.toContain("image_generation");
  // Parameter-scoped policies see the hosted tool's fixed parameters.
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ actionId: "openai.generate_image", service: "openai", appliesIn: "session", params: NATIVE_IMAGE_TOOL_PARAMS }));
});

it("offers the hosted tool when policy allows the plugin action and audits each saved image", async () => {
  const resolve = vi.fn(async () => ({ mode: "allow" as const, provenance: { baseMode: "allow" as const, source: "risk_default" as const } }));
  const records: PolicyInvocationRecord[] = [];
  const tools = await promptWithPolicy({ pluginCatalog: openaiCatalog(), policyResolver: { resolve, onInvocation: async (record) => { records.push(record); } } }, [item()]);
  expect(tools).toContain("image_generation");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(records).toEqual([expect.objectContaining({
    service: "openai", actionId: "openai.generate_image", toolId: "openai.generate_image", status: "completed", resolvedMode: "allow", appliesIn: "session",
    params: { ...NATIVE_IMAGE_TOOL_PARAMS, path: expect.stringMatching(/^generated-images\//), image_id: "img_1" },
  })]);
});

it.each(["no plugin catalog", "catalog without the OpenAI plugin"])("offers no hosted tool with %s", async (setup) => {
  expect(await promptWithPolicy(setup === "no plugin catalog" ? {} : { pluginCatalog: buildPluginCatalog([]) })).not.toContain("image_generation");
});

it("offers no hosted tool when editing is denied, because the hosted tool also edits", async () => {
  const resolve = vi.fn(async (input: { actionId: string }) => input.actionId === "openai.edit_image"
    ? { mode: "deny" as const, provenance: { baseMode: "deny" as const, source: "org_policy" as const } }
    : { mode: "allow" as const, provenance: { baseMode: "allow" as const, source: "risk_default" as const } });
  expect(await promptWithPolicy({ pluginCatalog: openaiCatalog(), policyResolver: { resolve } })).not.toContain("image_generation");
  expect(resolve.mock.calls.map(([input]) => input.actionId).sort()).toEqual(["openai.edit_image", "openai.generate_image"]);
});

it("checkpoints a saved image as an assistant entry before the stream ends, then replaces it once", async () => {
  const store = new InMemorySessionStore();
  const events = new InMemoryEventStream();
  const engine = new Engine({ providers: { store, stream: events, sandboxProvider: new VirtualSandboxProvider() } });
  // The provider sends the finished image, then holds the stream open until released.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: item() })}\n\n`));
      await held;
      const response = { id: "resp_held", status: "completed", output: [item()], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  });
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }))
    .mockImplementation(async () => wire([{ type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Saved.", annotations: [] }] }]));
  vi.stubGlobal("fetch", fetchMock);
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/workspace", sandbox: {}, model,
    purpose: "child", resolveModel: async () => ({ model, apiKey: "sk-fixture-key" }), pluginCatalog: openaiCatalog() });
  let settled = false;
  events.subscribe({ sessionId: session.id }, ({ event }) => { if (event.type === "submission_settled") settled = true; });
  try {
    const receipt = await session.prompt("Draw a square");
    const checkpoint = await expect.poll(async () => {
      const entries = await store.getEntries(session.id, receipt.threadId);
      return entries.find((entry) => entry.type === "message" && entry.role === "assistant");
    }, { timeout: 5_000 }).toBeDefined().then(async () => (await store.getEntries(session.id, receipt.threadId)).find((entry) => entry.type === "message" && entry.role === "assistant"));
    if (checkpoint?.type !== "message") throw new Error("missing checkpoint");
    // Durable before the terminal event: a crash here resumes with the saved path in context.
    expect(checkpoint.parts).toEqual([expect.objectContaining({ type: "tool_call", toolName: NATIVE_IMAGE_RESULT_TOOL, status: "running", args: { path: expect.stringMatching(/^generated-images\//), image_id: "img_1" } })]);
    release?.();
    await expect.poll(() => settled, { timeout: 10_000 }).toBe(true);
    const entries = await store.getEntries(session.id, receipt.threadId);
    const assistants = entries.filter((entry) => entry.type === "message" && entry.role === "assistant");
    // The checkpoint entry became the full message: same id, receipt completed, no duplicate.
    expect(assistants.filter((entry) => entry.id === checkpoint.id)).toHaveLength(1);
    const final = assistants.find((entry) => entry.id === checkpoint.id);
    if (final?.type !== "message") throw new Error("missing final entry");
    expect(final.parts?.filter((part) => part.type === "tool_call" && part.toolName === NATIVE_IMAGE_RESULT_TOOL)).toEqual([expect.objectContaining({ status: "completed", callId: checkpoint.parts?.[0]?.type === "tool_call" ? checkpoint.parts[0].callId : "" })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { await session.destroy(); }
});

it("keeps earlier turns in the transcript DAG after a checkpointed image message", async () => {
  const store = new InMemorySessionStore();
  const events = new InMemoryEventStream();
  const engine = new Engine({ providers: { store, stream: events, sandboxProvider: new VirtualSandboxProvider() } });
  const plain = (text: string) => wire([{ type: "message", id: `msg_${text}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }]);
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(plain("A1"))
    .mockResolvedValueOnce(wire([item(), item("img_2")]))
    .mockImplementation(async () => plain("Saved."));
  vi.stubGlobal("fetch", fetchMock);
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/workspace", sandbox: {}, model,
    purpose: "child", resolveModel: async () => ({ model, apiKey: "sk-fixture-key" }), pluginCatalog: openaiCatalog() });
  let settledCount = 0;
  events.subscribe({ sessionId: session.id }, ({ event }) => { if (event.type === "submission_settled") settledCount++; });
  try {
    const first = await session.prompt("U1");
    await expect.poll(() => settledCount).toBe(1);
    await session.prompt("U2 draw two squares");
    await expect.poll(() => settledCount, { timeout: 10_000 }).toBe(2);
    const snapshot = await store.getThreadSnapshot(session.id, first.threadId);
    if (!snapshot) throw new Error("missing thread");
    const active = walkTranscriptDag(snapshot.entries, snapshot.thread.activeLeafEntryId);
    const texts = active.filter((entry) => entry.type === "message").map((entry) => entry.type === "message" ? `${entry.role}:${entry.content}` : "");
    // Every earlier turn survives the checkpoint replacement; nothing is unlinked from the DAG.
    expect(texts).toEqual(expect.arrayContaining(["user:U1", "assistant:A1", "user:U2 draw two squares", "assistant:Saved."]));
    expect(active.length).toBe(snapshot.entries.length);
    for (const entry of snapshot.entries.slice(1)) expect(entry.parentId).not.toBeNull();
  } finally { await session.destroy(); }
});
