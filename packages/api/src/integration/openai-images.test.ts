import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import openaiPlugin from "@valet/plugin-openai/plugin";
import type { CreateSessionResponse, ListMessagesResponse, WireEvent } from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

let api: TestApi | undefined;
let unregister: (() => void) | undefined;
afterEach(async () => {
  unregister?.();
  await api?.cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("an ordinary OpenAI chat turn generates and edits through Responses, retaining sandbox bytes, live media, and REST history", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-openai-key");
  const faux = registerFauxProvider({ api: "openai-responses", provider: "openai", models: [{ id: "gpt-6.1-sol", input: ["text", "image"] }] });
  unregister = () => faux.unregister();
  api = await bootTestApi({ plugins: [openaiPlugin] });
  const testApi = api;
  const response = await fetch(`${testApi.baseUrl}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace: "/workspace" }),
  });
  expect(response.status).toBe(201);
  const created = await response.json() as CreateSessionResponse;
  const session = await testApi.providers.engineHost.sessionFor(created.id, { orgId: "local-org", userId: "local-user", workspace: "/workspace" });
  session.options.resolveModel = async () => ({ model: faux.getModel(), apiKey: "fixture-openai-key" });
  await session.setModel("gpt-6.1-sol");
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const b64 = png.toString("base64");
  const nativeFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "https://api.openai.com/v1/responses") {
      const body: unknown = JSON.parse(String(init?.body));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid request");
      requests.push(body as Record<string, unknown>);
      expect(init?.headers).toMatchObject({ authorization: "Bearer fixture-openai-key" });
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "image_generation_call", status: "completed", result: b64 }] }));
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
            prompt: "Draw a red square", model: "gpt-image-2.5-flare", responses_model: "gpt-6.1-sol", output_path: path,
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
    expect(requests[0]).toMatchObject({ model: "gpt-6.1-sol", tools: [{ type: "image_generation", model: "gpt-image-2.5-flare", action: "generate" }] });
    expect(requests[1]).toMatchObject({ model: "gpt-6.1-sol", tools: [{ type: "image_generation", model: "gpt-image-2.5-flare", action: "edit" }], input: [{ content: expect.arrayContaining([{ type: "input_image", image_url: `data:image/png;base64,${b64}`, detail: "auto" }]) }] });
    // A second session cannot consume the first session's working-directory file.
    const other = await testApi.providers.engineHost.sessionFor("other-image-session", { orgId: "local-org", userId: "local-user", workspace: "/other" });
    const { sandbox: otherSandbox } = await other.attachment.ensureReady({ timeoutMs: 10_000 });
    await expect(otherSandbox.readBinary("/workspace/generate_image.png")).rejects.toThrow();
  } finally {
    ws.close();
  }
});
