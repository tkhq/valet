// packages/api/src/routes/proxy-gateway.test.ts
import { describe, it, expect } from "vitest";
import { outboundHeaders } from "./proxy-gateway.js";

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
