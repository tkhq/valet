import { describe, it, expect, vi } from "vitest";
import { resolveProxyPrincipal, wireError } from "./principal.js";

const ok = {
  verifyApiKey: vi.fn(async ({ key }: { key: string }) =>
    key === "vlt_good" ? { valid: true, key: { id: "k1", userId: "u1" } } : { valid: false, key: null }),
  userOrg: vi.fn(async (userId: string) => (userId === "u1" ? "org1" : null)),
};

describe("resolveProxyPrincipal", () => {
  it("resolves from x-api-key", async () => {
    const h = new Headers({ "x-api-key": "vlt_good" });
    const r = await resolveProxyPrincipal(h, "anthropic", ok);
    expect(r).toEqual({ userId: "u1", orgId: "org1", keyId: "k1" });
  });
  it("resolves from Authorization: Bearer", async () => {
    const h = new Headers({ authorization: "Bearer vlt_good" });
    const r = await resolveProxyPrincipal(h, "openai", ok);
    expect(r).toEqual({ userId: "u1", orgId: "org1", keyId: "k1" });
  });
  it("prefers the vlt_ key when Claude Code also sends a real provider key as x-api-key", async () => {
    // Claude Code forwards ANTHROPIC_API_KEY as x-api-key even when the valet
    // key is in ANTHROPIC_AUTH_TOKEN (the bearer). The gateway must pick the
    // verifiable valet key, not the passed-through provider key.
    const h = new Headers({ "x-api-key": "sk-ant-api03-REALKEY", authorization: "Bearer vlt_good" });
    const r = await resolveProxyPrincipal(h, "anthropic", ok);
    expect(r).toEqual({ userId: "u1", orgId: "org1", keyId: "k1" });
  });
  it("returns a 401 anthropic-shaped body for a missing key", async () => {
    const r = await resolveProxyPrincipal(new Headers(), "anthropic", ok);
    expect(r).toBeInstanceOf(Response);
    const res = r as Response;
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });
  it("returns a 401 openai-shaped body for an invalid key", async () => {
    const h = new Headers({ authorization: "Bearer nope" });
    const r = await resolveProxyPrincipal(h, "openai", ok);
    const res = r as Response;
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
  });
});

describe("wireError", () => {
  it("names a corrective action in the message", async () => {
    const res = wireError("anthropic", 502, "Configure an Anthropic provider in valet Settings.");
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).message).toMatch(/Settings/);
  });
});
