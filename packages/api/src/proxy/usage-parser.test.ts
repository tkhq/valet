// packages/api/src/proxy/usage-parser.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUsage } from "./usage-parser.js";

const fx = (n: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)),
    "utf8",
  );

describe("parseUsage", () => {
  it("extracts Anthropic usage, model, and message id", () => {
    const r = parseUsage("anthropic", fx("anthropic-stream.txt"));
    expect(r).not.toBeNull();
    expect(r!.model).toBe("claude-sonnet-4-5-20250929");
    expect(r!.providerResponseId).toBe("msg_01ABC");
    expect(r!.usage).toEqual({
      input: 1200,
      output: 350,
      cacheRead: 10,
      cacheWrite: 40,
      total: 1600,
    });
  });
  it("extracts OpenAI Responses usage, model, and response id", () => {
    const r = parseUsage("openai", fx("openai-responses-stream.txt"));
    expect(r).not.toBeNull();
    expect(r!.model).toBe("gpt-5");
    expect(r!.providerResponseId).toBe("resp_01XYZ");
    expect(r!.usage).toEqual({
      input: 900,
      output: 220,
      cacheRead: 30,
      cacheWrite: 0,
      total: 1120,
    });
  });
  it("returns null when no usage is present", () => {
    expect(parseUsage("anthropic", "event: ping\ndata: {}\n")).toBeNull();
  });
  it("extracts usage from a NON-streaming Anthropic message body", () => {
    const body = JSON.stringify({
      type: "message",
      id: "msg_ns",
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 4, cache_read_input_tokens: 2 },
    });
    const r = parseUsage("anthropic", body);
    expect(r).not.toBeNull();
    expect(r!.model).toBe("claude-haiku-4-5-20251001");
    expect(r!.providerResponseId).toBe("msg_ns");
    expect(r!.usage).toEqual({ input: 12, output: 8, cacheRead: 2, cacheWrite: 4, total: 26 });
  });
  it("extracts usage from a NON-streaming OpenAI Responses body", () => {
    const body = JSON.stringify({
      object: "response",
      id: "resp_ns",
      model: "gpt-4o-mini-2024-07-18",
      usage: { input_tokens: 9, output_tokens: 11, total_tokens: 20, input_tokens_details: { cached_tokens: 3 } },
    });
    const r = parseUsage("openai", body);
    expect(r).not.toBeNull();
    expect(r!.model).toBe("gpt-4o-mini-2024-07-18");
    expect(r!.providerResponseId).toBe("resp_ns");
    expect(r!.usage).toEqual({ input: 9, output: 11, cacheRead: 3, cacheWrite: 0, total: 20 });
  });

  it("extracts usage from a NON-streaming Chat Completions body (prompt/completion tokens)", () => {
    const body = JSON.stringify({
      object: "chat.completion",
      id: "chatcmpl-ns",
      model: "gpt-4o-mini-2024-07-18",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42, prompt_tokens_details: { cached_tokens: 8 } },
    });
    const r = parseUsage("openai", body, "/v1/chat/completions");
    expect(r).not.toBeNull();
    expect(r!.model).toBe("gpt-4o-mini-2024-07-18");
    expect(r!.providerResponseId).toBe("chatcmpl-ns");
    expect(r!.usage).toEqual({ input: 30, output: 12, cacheRead: 8, cacheWrite: 0, total: 42 });
  });

  it("extracts usage from a STREAMING Chat Completions terminal chunk", () => {
    const body =
      `data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-5","choices":[{"index":0,"delta":{"content":"hey"}}]}\n\n` +
      `data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-5","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}\n\n` +
      `data: [DONE]\n`;
    const r = parseUsage("openai", body, "/v1/chat/completions");
    expect(r).not.toBeNull();
    expect(r!.model).toBe("gpt-5");
    expect(r!.usage).toEqual({ input: 5, output: 7, cacheRead: 0, cacheWrite: 0, total: 12 });
  });

  it("extracts usage from a legacy Completions body", () => {
    const body = JSON.stringify({
      object: "text_completion",
      id: "cmpl-1",
      model: "gpt-3.5-turbo-instruct",
      choices: [{ text: "world", finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    const r = parseUsage("openai", body, "/v1/completions");
    expect(r).not.toBeNull();
    expect(r!.usage).toEqual({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5 });
  });

  it("returns null for a streaming Chat Completions body with no usage chunk", () => {
    const body = `data: {"id":"c2","object":"chat.completion.chunk","model":"gpt-5","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n`;
    expect(parseUsage("openai", body, "/v1/chat/completions")).toBeNull();
  });
});
