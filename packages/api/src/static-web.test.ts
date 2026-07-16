/**
 * Route tests for the api-serves-web static/SPA fallback (kubernetes-
 * deployment design decision 3). Exercises `createApp`'s wiring through
 * `bootTestApi({ webDistDir })` against a fixture build directory — no
 * Docker/cluster required, so this runs in the normal `pnpm test` pass.
 *
 * Covers the adversarial-review catch: a naive SPA fallback would serve
 * `index.html` for any unmatched path, which would shadow `/api/*` 404s,
 * `/mcp`, and `/.well-known/oauth-authorization-server` with HTML instead
 * of their real (JSON, or real-handler) responses.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApi, type TestApi } from "./integration/_setup.js";

let distDir: string;
let api: TestApi | undefined;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), "valet-web-dist-"));
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>valet-spa-fixture</title>");
  writeFileSync(join(distDir, "app.css"), "body { color: red; }");
});

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("api serves web (static + SPA fallback)", () => {
  it("serves a real static asset from the dist dir", async () => {
    api = await bootTestApi({ webDistDir: distDir });
    const res = await fetch(`${api.baseUrl}/app.css`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("color: red");
  });

  it("falls back to index.html for a client-side route", async () => {
    api = await bootTestApi({ webDistDir: distDir });
    const res = await fetch(`${api.baseUrl}/settings`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/html/);
    expect(await res.text()).toContain("valet-spa-fixture");
  });

  it("does not shadow an unknown /api/* route with html", async () => {
    api = await bootTestApi({ webDistDir: distDir });
    const res = await fetch(`${api.baseUrl}/api/nope`, {
      headers: { "x-valet-test-user-id": "local-user" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("does not shadow /mcp with html when auth is not configured", async () => {
    api = await bootTestApi({ webDistDir: distDir });
    const res = await fetch(`${api.baseUrl}/mcp`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toMatch(/html/);
  });

  it("does not shadow /mcp with html when auth IS configured (reaches the real handler)", async () => {
    api = await bootTestApi({ webDistDir: distDir, auth: true });
    const res = await fetch(`${api.baseUrl}/mcp`, { method: "POST" });
    // The real mcp handler 401s a bearer-less request — never a 200/html.
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).not.toMatch(/html/);
  });

  it("does not shadow /.well-known/oauth-authorization-server when auth is not configured", async () => {
    api = await bootTestApi({ webDistDir: distDir });
    const res = await fetch(`${api.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toMatch(/html/);
  });

  it("reaches the real oauth discovery handler when auth IS configured", async () => {
    api = await bootTestApi({ webDistDir: distDir, auth: true });
    const res = await fetch(`${api.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).not.toMatch(/html/);
    const body = (await res.json()) as { authorization_endpoint?: string };
    expect(body.authorization_endpoint).toBeTruthy();
  });

  it("is a no-op when webDistDir is not provided (dev-mode parity)", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/settings`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toMatch(/html/);
  });
});
