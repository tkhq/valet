// packages/api/src/routes/proxy-gateway.test.ts
import { describe, it, expect } from "vitest";
import { outboundHeaders, sanitizeResponseHeaders, injectIncludeUsage, proxySubpath, refusedUpstream, upstreamFetch } from "./proxy-gateway.js";
import { guardedFetch } from "../lib/outbound-url.js";

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

describe("proxySubpath", () => {
  it("keeps Anthropic paths that already carry /v1", () => {
    expect(proxySubpath("anthropic", "/proxy/anthropic/v1/messages")).toBe("/v1/messages");
    expect(proxySubpath("anthropic", "/proxy/anthropic/v1/messages/count_tokens")).toBe("/v1/messages/count_tokens");
    expect(proxySubpath("anthropic", "/proxy/anthropic/v1")).toBe("/v1");
  });

  it("adds /v1 for a client that appends /messages to the Claude Code base URL", () => {
    // OpenCode with baseURL `/proxy/anthropic` sends this path. Before the
    // fix the gateway forwarded `/messages` upstream, and Anthropic 404'd.
    expect(proxySubpath("anthropic", "/proxy/anthropic/messages")).toBe("/v1/messages");
    expect(proxySubpath("anthropic", "/proxy/anthropic/models")).toBe("/v1/models");
    // A segment that only starts with "v1" is not the version segment.
    expect(proxySubpath("anthropic", "/proxy/anthropic/v1beta")).toBe("/v1/v1beta");
  });

  it("leaves OpenAI paths and the bare root untouched", () => {
    expect(proxySubpath("openai", "/proxy/openai/v1/responses")).toBe("/v1/responses");
    expect(proxySubpath("openai", "/proxy/openai/chat/completions")).toBe("/chat/completions");
    expect(proxySubpath("anthropic", "/proxy/anthropic")).toBe("/");
  });
});

describe("refusedUpstream", () => {
  it("calls the public defaults without a check", () => {
    expect(refusedUpstream("anthropic", "https://api.anthropic.com")).toBeNull();
    expect(refusedUpstream("openai", "https://api.openai.com")).toBeNull();
  });

  it("allows a public configured base URL", () => {
    expect(refusedUpstream("openai", "https://llm-gateway.example.com")).toBeNull();
  });

  it("refuses a configured base URL that points inside the cluster, so the key is never sent", () => {
    expect(refusedUpstream("anthropic", "http://169.254.169.254")).toMatch(/^The anthropic provider base URL is refused\. The URL points at 169\.254\.169\.254/);
    expect(refusedUpstream("openai", "http://valet-api.valet.svc.cluster.local:8787")).toMatch(/internal or cluster service/);
  });
});

describe("upstreamFetch", () => {
  it("uses the guarded fetch for a configured base URL, so DNS rebinding and redirects are checked", () => {
    expect(upstreamFetch("anthropic", "https://llm-gateway.example.com")).toBe(guardedFetch);
    expect(upstreamFetch("openai", "https://llm-gateway.example.com")).toBe(guardedFetch);
  });

  it("uses the platform fetch for the fixed public defaults", () => {
    expect(upstreamFetch("anthropic", "https://api.anthropic.com")).not.toBe(guardedFetch);
    expect(upstreamFetch("openai", "https://api.openai.com")).not.toBe(guardedFetch);
  });
});
