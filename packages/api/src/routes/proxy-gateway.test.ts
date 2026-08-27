// packages/api/src/routes/proxy-gateway.test.ts
import { describe, it, expect } from "vitest";
import { outboundHeaders, sanitizeResponseHeaders, injectIncludeUsage } from "./proxy-gateway.js";

describe("injectIncludeUsage", () => {
  const chat = "/v1/chat/completions";
  it("adds stream_options.include_usage to a streaming chat/completions request", () => {
    const out = JSON.parse(injectIncludeUsage("openai", chat, JSON.stringify({ model: "gpt-5", stream: true, messages: [] })));
    expect(out.stream_options).toEqual({ include_usage: true });
  });
  it("preserves other stream_options fields", () => {
    const out = JSON.parse(injectIncludeUsage("openai", chat, JSON.stringify({ stream: true, stream_options: { foo: 1 } })));
    expect(out.stream_options).toEqual({ foo: 1, include_usage: true });
  });
  it("leaves a NON-streaming chat request untouched (usage already returned)", () => {
    const body = JSON.stringify({ model: "gpt-5", stream: false, messages: [] });
    expect(injectIncludeUsage("openai", chat, body)).toBe(body);
  });
  it("leaves a request that already opted in untouched", () => {
    const body = JSON.stringify({ stream: true, stream_options: { include_usage: true } });
    expect(injectIncludeUsage("openai", chat, body)).toBe(body);
  });
  it("does not touch the Responses endpoint or anthropic", () => {
    const body = JSON.stringify({ stream: true });
    expect(injectIncludeUsage("openai", "/v1/responses", body)).toBe(body);
    expect(injectIncludeUsage("anthropic", "/v1/messages", body)).toBe(body);
  });
  it("returns a non-JSON body unchanged", () => {
    expect(injectIncludeUsage("openai", chat, "not json")).toBe("not json");
  });
  it("treats a malformed (non-object) stream_options as empty instead of spreading it", () => {
    const out = JSON.parse(injectIncludeUsage("openai", chat, JSON.stringify({ stream: true, stream_options: "oops" })));
    expect(out.stream_options).toEqual({ include_usage: true }); // not {0:"o",1:"o",...}
  });
});

describe("sanitizeResponseHeaders", () => {
  it("strips upstream set-cookie and hop-by-hop, keeps the rest", () => {
    const res = new Response(null, {
      headers: {
        "set-cookie": "sess=upstream-secret; HttpOnly",
        "content-encoding": "gzip",
        connection: "keep-alive",
        "content-type": "application/json",
        "anthropic-ratelimit-requests-remaining": "42",
      },
    });
    const out = sanitizeResponseHeaders(res);
    expect(out.get("set-cookie")).toBeNull();          // upstream session material never reaches the client
    expect(out.get("content-encoding")).toBeNull();     // tee decodes the body
    expect(out.get("connection")).toBeNull();
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("anthropic-ratelimit-requests-remaining")).toBe("42");
  });
});

describe("outboundHeaders", () => {
  it("forwards provider headers, drops the valet key + hop-by-hop, sets real auth", () => {
    const raw = new Headers({
      "x-api-key": "vlt_secret", "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching",
      "x-stainless-lang": "js", "content-type": "application/json", "content-length": "42", "host": "localhost",
      connection: "keep-alive",
    });
    const out = outboundHeaders(raw, "anthropic", "sk-real");
    expect(out.get("anthropic-version")).toBe("2023-06-01");
    expect(out.get("anthropic-beta")).toBe("prompt-caching");
    expect(out.get("x-stainless-lang")).toBe("js");
    expect(out.get("x-api-key")).toBe("sk-real");           // swapped, not the valet key
    expect(out.get("content-length")).toBeNull();           // hop-by-hop stripped
    expect(out.get("host")).toBeNull();
    expect(out.get("connection")).toBeNull();
  });
  it("uses Authorization: Bearer for openai and drops the incoming bearer", () => {
    const raw = new Headers({ authorization: "Bearer vlt_secret", "openai-beta": "responses=v1" });
    const out = outboundHeaders(raw, "openai", "sk-real");
    expect(out.get("authorization")).toBe("Bearer sk-real");
    expect(out.get("openai-beta")).toBe("responses=v1");
  });
});
