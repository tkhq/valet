// packages/api/src/routes/proxy-gateway.test.ts
import { describe, it, expect } from "vitest";
import { outboundHeaders, sanitizeResponseHeaders } from "./proxy-gateway.js";

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
