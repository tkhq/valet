// packages/api/src/proxy/upstream.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveUpstream, resolveUpstreamBase } from "./upstream.js";

function fakeCreds(map: Record<string, { apiKey: string }>) {
  return { get: vi.fn(async (_o: unknown, svc: string) => map[svc] ?? undefined) };
}

describe("resolveUpstream", () => {
  it("uses the org provider credential when present", async () => {
    const db = { /* not read on this path */ } as never;
    const listProviders = vi.fn(async () => [{ id: "p1", kind: "anthropic", baseUrl: null }]);
    const creds = fakeCreds({ "llm:p1": { apiKey: "sk-real" } });
    const up = await resolveUpstream(db, creds as never, "org1", "anthropic", { listProviders, envKey: () => undefined });
    expect(up).toEqual({ baseUrl: "https://api.anthropic.com", apiKey: "sk-real" });
  });
  it("falls back to the env key when no provider row exists", async () => {
    const creds = fakeCreds({});
    const up = await resolveUpstream({} as never, creds as never, "org1", "openai",
      { listProviders: async () => [], envKey: (k) => (k === "openai" ? "sk-env" : undefined) });
    expect(up).toEqual({ baseUrl: "https://api.openai.com", apiKey: "sk-env" });
  });
  it("returns null when neither provider nor env key exists", async () => {
    const creds = fakeCreds({});
    const up = await resolveUpstream({} as never, creds as never, "org1", "openai",
      { listProviders: async () => [], envKey: () => undefined });
    expect(up).toBeNull();
  });
});

describe("resolveUpstreamBase", () => {
  it("honors an org's configured custom baseUrl (so pass-through hits the same host)", async () => {
    const base = await resolveUpstreamBase({} as never, "org1", "openai", {
      listProviders: async () => [{ id: "p1", kind: "openai", baseUrl: "https://myorg.openai.azure.com/openai" }],
      envKey: () => undefined,
    });
    expect(base).toBe("https://myorg.openai.azure.com/openai");
  });
  it("falls back to the public default when no custom baseUrl is set", async () => {
    const base = await resolveUpstreamBase({} as never, "org1", "anthropic", {
      listProviders: async () => [{ id: "p1", kind: "anthropic", baseUrl: null }],
      envKey: () => undefined,
    });
    expect(base).toBe("https://api.anthropic.com");
  });
});
