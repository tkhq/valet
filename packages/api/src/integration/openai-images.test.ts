import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { bundledModel } from "@valet/engine/model-catalog";
import { entriesToAgentMessages } from "@valet/engine";
import openaiPlugin from "@valet/plugin-openai/plugin";
import type { CreateSessionResponse, ListMessagesResponse, WireEvent } from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

let workspace: string | undefined;
let api: TestApi | undefined;
let unregister: (() => void) | undefined;
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  await api?.cleanup();
  if (workspace) await rm(workspace, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function responseStream(id: string, item: Record<string, unknown>): Response {
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

it("the selected OpenAI model generates and edits natively with sandbox files, live images, and persisted context", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-openai-key");
  api = await bootTestApi({ plugins: [openaiPlugin] });
  const testApi = api;
  workspace = await mkdtemp(join(tmpdir(), "valet-openai-images-"));
  const response = await fetch(`${testApi.baseUrl}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace }),
  });
  expect(response.status).toBe(201);
  const created = await response.json() as CreateSessionResponse;
  const session = await testApi.providers.engineHost.sessionFor(created.id, { orgId: "local-org", userId: "local-user", workspace });
  const model = bundledModel("openai", "gpt-6.1-sol");
  if (!model) throw new Error("missing capable model");
  session.options.resolveModel = async () => ({ model, apiKey: "fixture-openai-key", canonicalId: `openai/${model.id}` });
  await session.setModel(`openai/${model.id}`);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const b64 = png.toString("base64");
  const nativeFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "https://api.openai.com/v1/responses") {
      const body: unknown = JSON.parse(String(init?.body));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid request");
      requests.push(body as Record<string, unknown>);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-openai-key");
      const round = requests.length;
      return responseStream(`resp_${round}`, round % 2 === 1
        ? { type: "image_generation_call", id: `img_${round}`, status: "completed", result: b64, output_format: "png" }
        : { type: "message", id: `msg_${round}`, role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "The image is saved.", annotations: [] }] });
    }
    return nativeFetch(url, init);
  }));
  const events: WireEvent[] = [];
  const ws = new WebSocket(`${testApi.wsUrl}/api/sessions/${created.id}/ws`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (event) => { const wire: WireEvent = JSON.parse(String(event.data)); events.push(wire); if (wire.type === "init") resolve(); };
      ws.onerror = () => reject(new Error("WebSocket failed"));
    });
    for (const prompt of ["Draw a red square", "Make that square blue"]) {
      const receipt = await session.prompt(prompt, { author: { id: "local-user" } });
      await expect.poll(() => events.filter((event) => event.type === "tool_end" && event.toolName === "openai_native_image").length).toBe(prompt.startsWith("Draw") ? 1 : 2);
      await expect.poll(() => requests.length).toBe(prompt.startsWith("Draw") ? 2 : 4);
      const live = [...events].reverse().find((event) => event.type === "tool_end" && event.toolName === "openai_native_image");
      expect(live?.type === "tool_end" ? live.resultData : undefined).toMatchObject({ content: expect.arrayContaining([{ type: "image", data: b64, mimeType: "image/png" }]) });
      const historyResponse = await fetch(`${testApi.baseUrl}/api/sessions/${created.id}/messages?threadId=${receipt.threadId}`);
      const history = await historyResponse.json() as ListMessagesResponse;
      const parts = history.messages.flatMap((message) => message.parts).filter((part) => part.kind === "tool_call" && part.toolName === "openai_native_image");
      const part = parts[parts.length - 1];
      if (part?.kind !== "tool_call" || !part.args || typeof part.args !== "object" || !("path" in part.args) || typeof part.args.path !== "string") throw new Error("missing persisted native receipt");
      expect(part.status).toBe("completed");
      expect(part.result).toMatchObject({ text: expect.stringContaining(part.args.path), content: expect.arrayContaining([{ type: "image", data: b64, mimeType: "image/png" }]) });
      const sandbox = session.attachment.current();
      if (!sandbox) throw new Error("missing sandbox");
      expect(await sandbox.readBinary(part.args.path)).toEqual(new Uint8Array(png));
      const reloaded = entriesToAgentMessages(await session.readEntries("web:default"), model);
      expect(reloaded.filter((message) => message.role === "toolResult").flatMap((message) => message.content)).toContainEqual({ type: "image", data: b64, mimeType: "image/png" });
      const other = await testApi.providers.engineHost.sessionFor("other-image-session", { orgId: "local-org", userId: "local-user", workspace: "/other" });
      const { sandbox: otherSandbox } = await other.attachment.ensureReady({ timeoutMs: 10_000 });
      await expect(otherSandbox.readBinary(part.args.path)).rejects.toThrow();
    }
    testApi.providers.engineHost.evictCache(created.id);
    const restored = await testApi.providers.engineHost.sessionFor(created.id, { orgId: "local-org", userId: "local-user", workspace });
    expect(restored).not.toBe(session);
    const restoredContext = entriesToAgentMessages(await restored.readEntries("web:default"), model);
    expect(restoredContext.filter((message) => message.role === "toolResult").flatMap((message) => message.content)).toContainEqual({ type: "image", data: b64, mimeType: "image/png" });
    expect(JSON.stringify(restoredContext)).toContain("generated-images/");
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request).toMatchObject({ model: "gpt-6.1-sol", tools: expect.arrayContaining([{ type: "image_generation", model: "gpt-image-2.5-sunburst", output_format: "png", quality: "auto" }]) });
      expect(JSON.stringify(request.tools)).not.toContain('"name":"openai_native_image"');
    }
    expect(JSON.stringify(requests[2].input)).toContain(`data:image/png;base64,${b64}`);
    expect(JSON.stringify(requests[2].input)).toContain("generated-images/");
  } finally { ws.close(); }
});

it("an unsupported session model generates and edits through direct Images with saved files and inline history", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-openai-key");
  const faux = registerFauxProvider({ api: "openai-responses", provider: "image-fallback", models: [{ id: "image-fallback", input: ["text", "image"] }] });
  unregister = () => faux.unregister();
  api = await bootTestApi({ plugins: [openaiPlugin] });
  const testApi = api;
  workspace = await mkdtemp(join(tmpdir(), "valet-openai-images-"));
  const response = await fetch(`${testApi.baseUrl}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace }),
  });
  expect(response.status).toBe(201);
  const created = await response.json() as CreateSessionResponse;
  const session = await testApi.providers.engineHost.sessionFor(created.id, { orgId: "local-org", userId: "local-user", workspace });
  session.options.resolveModel = async () => ({ model: faux.getModel(), apiKey: "fixture-openai-key" });
  await session.setModel("image-fallback");
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const b64 = png.toString("base64");
  const nativeFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).startsWith("https://api.openai.com/v1/images/")) {
      const body: unknown = init?.body instanceof FormData ? { model: init.body.get("model"), prompt: init.body.get("prompt"), image: init.body.get("image") } : JSON.parse(String(init?.body));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid request");
      requests.push(body as Record<string, unknown>);
      expect(init?.headers).toMatchObject({ authorization: "Bearer fixture-openai-key" });
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }));
    }
    return nativeFetch(url, init);
  }));
  const events: WireEvent[] = [];
  const ws = new WebSocket(`${testApi.wsUrl}/api/sessions/${created.id}/ws`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (event) => {
        const wire: WireEvent = JSON.parse(String(event.data));
        events.push(wire);
        if (wire.type === "init") resolve();
      };
      ws.onerror = () => reject(new Error("WebSocket failed"));
    });
    for (const action of ["generate_image", "edit_image"]) {
      const path = `/workspace/${action}.png`;
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("call_tool", {
          tool_id: `openai.${action}`, summary: "Create a sandbox image", params: {
            prompt: "Draw a red square", model: action === "generate_image" ? "gpt-image-2.5-sunburst" : "gpt-image-2.5-flare", output_path: path,
            ...(action === "edit_image" ? { image_path: "/workspace/generate_image.png" } : {}),
          },
        }, { id: action })], { stopReason: "toolUse" }),
        (context) => {
          const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
          expect(result?.role === "toolResult" ? result.content : undefined).toContainEqual({ type: "image", data: b64, mimeType: "image/png" });
          return fauxAssistantMessage("Saved the image.");
        },
      ]);
      const receipt = await session.prompt(`${action} using the current OpenAI chat model.`, { author: { id: "local-user" } });
      await expect.poll(() => events.some((event) => event.type === "tool_end" && event.callId === action)).toBe(true);
      await expect.poll(() => faux.getPendingResponseCount()).toBe(0);
      const sandbox = session.attachment.current();
      if (!sandbox) throw new Error("missing sandbox");
      expect(await sandbox.readBinary(path)).toEqual(new Uint8Array(png));
      const live = events.find((event) => event.type === "tool_end" && event.callId === action);
      expect(live?.type === "tool_end" ? live.resultData : undefined).toMatchObject({ content: expect.arrayContaining([{ type: "image", data: b64, mimeType: "image/png" }]) });
      const historyResponse = await fetch(`${testApi.baseUrl}/api/sessions/${created.id}/messages?threadId=${receipt.threadId}`);
      expect(historyResponse.status).toBe(200);
      const history = await historyResponse.json() as ListMessagesResponse;
      const part = history.messages.flatMap((message) => message.parts).find((part) => part.kind === "tool_call" && part.callId === action);
      expect(part?.kind === "tool_call" ? part.result : undefined).toMatchObject({ text: expect.stringContaining(path), content: expect.arrayContaining([{ type: "image", data: b64, mimeType: "image/png" }]) });
      expect(part?.kind === "tool_call" ? part.status : undefined).toBe("completed");
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: "gpt-image-2.5-sunburst" });
    expect(requests[1]).toMatchObject({ model: "gpt-image-2.5-flare", image: expect.any(Blob) });
    // A second session cannot consume the first session's working-directory file.
    const other = await testApi.providers.engineHost.sessionFor("other-image-session", { orgId: "local-org", userId: "local-user", workspace: "/other" });
    const { sandbox: otherSandbox } = await other.attachment.ensureReady({ timeoutMs: 10_000 });
    await expect(otherSandbox.readBinary("/workspace/generate_image.png")).rejects.toThrow();
  } finally {
    ws.close();
  }
});
