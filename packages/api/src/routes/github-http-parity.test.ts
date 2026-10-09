/**
 * Route parity for the GitHub HTTP surface. Each case pins the status and
 * body that a legacy URL answers. The deeper behavior suites (`github-app.test.ts`,
 * `github-connect.test.ts`) exercise the legacy URLs only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { credentials, githubInstallations } from "../schema/index.js";
import type { PostGithubConnectResponse } from "../wire/types.js";

const ADMIN = { "Content-Type": "application/json" };
const MEMBER = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

const { privateKey: TEST_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ENV_APP: Record<string, string> = {
  GITHUB_APP_ID: "777",
  GITHUB_APP_SLUG: "valet-env",
  GITHUB_APP_CLIENT_ID: "Iv1.envclient",
  GITHUB_APP_CLIENT_SECRET: "env-oauth-secret",
  GITHUB_APP_WEBHOOK_SECRET: "env-hook-secret",
  GITHUB_APP_PRIVATE_KEY: TEST_PEM,
};
const SAVED_ENV = Object.fromEntries(
  [...Object.keys(ENV_APP), "GITHUB_API_URL", "GITHUB_URL", "VALET_PUBLIC_URL"].map((name) => [name, process.env[name]]),
);

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function useFixture(overrides: Parameters<typeof startGithubFixture>[0] = {}): GithubFixture {
  fixture = startGithubFixture(overrides);
  process.env.GITHUB_API_URL = fixture.url;
  process.env.GITHUB_URL = fixture.url;
  return fixture;
}

type RouteId =
  | "app-status" | "app-manifest" | "app-setup" | "app-credential" | "app-refresh" | "app-disconnect"
  | "connect" | "org-status" | "callback" | "disconnect" | "webhook";

const LEGACY: Record<RouteId, string> = {
  "app-status": "/api/org/github-app",
  "app-manifest": "/api/org/github-app/manifest",
  "app-setup": "/api/org/github-app/setup",
  "app-credential": "/api/org/github-app/credential",
  "app-refresh": "/api/org/github-app/refresh",
  "app-disconnect": "/api/org/github-app",
  connect: "/api/me/github/connect",
  "org-status": "/api/me/github/org-status",
  callback: "/api/me/github/callback",
  disconnect: "/api/me/github",
  webhook: "/webhooks/github-app",
};

const SURFACES = [
  { name: "legacy", url: LEGACY },
] as const;

function sign(body: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe.each(SURFACES)("$name GitHub routes", ({ url }) => {
  async function call(id: RouteId, init: RequestInit = {}, query = ""): Promise<{ status: number; body: unknown }> {
    if (!api) throw new Error("Boot the test API first.");
    const response = await fetch(`${api.baseUrl}${url[id]}${query}`, { redirect: "manual", ...init });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  it("answers org-admin routes with the same refusals and reads", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    expect(await call("app-status", { headers: MEMBER })).toEqual({ status: 403, body: { error: "org admin required" } });
    expect(await call("app-status", { headers: ADMIN })).toEqual({
      status: 200,
      body: { configured: false, installations: [], webhook: { mode: "manual" }, installationsCheckedAt: null },
    });
    expect(await call("app-manifest", { method: "POST", headers: MEMBER, body: "{}" })).toEqual({
      status: 403, body: { error: "org admin required" },
    });
    expect(await call("app-manifest", { method: "POST", headers: ADMIN, body: JSON.stringify({ permissions: { contents: "owner" } }) })).toEqual({
      status: 400, body: { error: 'invalid permission "contents"="owner" — levels are read/write/admin' },
    });
    expect(await call("app-manifest", { method: "POST", headers: ADMIN, body: JSON.stringify({ events: ["Push"] }) })).toEqual({
      status: 400, body: { error: "events must be an array of snake_case event names" },
    });
    expect(await call("app-credential", { method: "POST", headers: ADMIN, body: "not json" })).toEqual({
      status: 400, body: { error: "Send a JSON body with the app id and the private key." },
    });
    expect(await call("app-credential", { method: "POST", headers: ADMIN, body: JSON.stringify({ appId: "1", privateKey: "nope" }) })).toEqual({
      status: 400,
      body: { error: "The private key is not a PEM. Paste the whole file GitHub downloaded, including the BEGIN and END lines." },
    });
    expect(await call("app-refresh", { method: "POST", headers: MEMBER })).toEqual({ status: 403, body: { error: "org admin required" } });
    expect(await call("app-disconnect", { method: "DELETE", headers: MEMBER })).toEqual({ status: 403, body: { error: "org admin required" } });
    expect(await call("app-disconnect", { method: "DELETE", headers: ADMIN })).toEqual({ status: 204, body: null });
  });

  it("answers user routes with the same reads and refusals", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    expect(await call("org-status", { headers: MEMBER })).toEqual({
      status: 200, body: { configured: false, installationCount: 0, suspendedCount: 0 },
    });
    expect(await call("connect", { method: "POST", headers: MEMBER })).toEqual({
      status: 409, body: { error: "no GitHub App is configured for this organization; ask an admin to set it up first" },
    });
    expect(await call("callback", { headers: MEMBER })).toEqual({ status: 400, body: { error: "missing code or state" } });
    expect(await call("callback", { headers: MEMBER }, "?code=c&state=forged.state")).toEqual({
      status: 400, body: { error: "invalid or expired state" },
    });
    expect(await call("app-setup", { headers: MEMBER }, "?code=c")).toEqual({ status: 400, body: { error: "missing code or state" } });
    expect(await call("disconnect", { method: "DELETE", headers: MEMBER })).toEqual({ status: 204, body: null });
  });

  it("refuses unauthenticated callers on every authenticated route", async () => {
    api = await bootTestApi({ plugins: [githubPlugin], auth: true });
    const ids: Array<[RouteId, string]> = [
      ["app-status", "GET"], ["app-manifest", "POST"], ["app-setup", "GET"], ["app-credential", "POST"],
      ["app-refresh", "POST"], ["app-disconnect", "DELETE"], ["connect", "POST"], ["org-status", "GET"],
      ["callback", "GET"], ["disconnect", "DELETE"],
    ];
    for (const [id, method] of ids) {
      expect({ id, status: (await call(id, { method })).status }).toEqual({ id, status: 401 });
    }
  });

  it("binds a pasted credential to the caller's organization, not one named in the body", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({
      getApp: () => ({ body: { id: 4242, slug: "existing-app", client_id: "Iv1.existing", html_url: "https://github.com/apps/existing-app" } }),
      listInstallations: () => ({ body: [] }),
    });
    const response = await call("app-credential", {
      method: "POST", headers: ADMIN,
      body: JSON.stringify({ appId: "4242", privateKey: TEST_PEM, orgId: "foreign", userId: "test-member" }),
    });
    expect(response.status).toBe(200);
    const rows = await api.providers.db.select({ ownerId: credentials.ownerId }).from(credentials)
      .where(and(eq(credentials.ownerType, "org"), eq(credentials.service, "github_app")));
    expect(rows).toEqual([{ ownerId: "local-org" }]);
  });

  it("refuses a connect state minted for another user without calling GitHub", async () => {
    Object.assign(process.env, ENV_APP);
    api = await bootTestApi({ plugins: [githubPlugin] });
    const f = useFixture();
    const started = await call("connect", { method: "POST", headers: ADMIN });
    expect(started.status).toBe(200);
    const body = started.body as PostGithubConnectResponse;
    const state = new URL(body.url).searchParams.get("state") ?? "";
    expect(await call("callback", { headers: MEMBER }, `?code=c&state=${encodeURIComponent(state)}`)).toEqual({
      status: 400, body: { error: "this authorization was not started by the signed-in user" },
    });
    expect(f.calls).toEqual([]);
    const saved = await api.providers.db.select({ ownerId: credentials.ownerId }).from(credentials)
      .where(and(eq(credentials.ownerType, "user"), eq(credentials.service, "github")));
    expect(saved).toEqual([]);
  });

  it("refuses a forged setup state without calling GitHub", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const f = useFixture();
    const forged = `${Buffer.from(JSON.stringify({ orgId: "local-org", nonce: "n", exp: Date.now() + 60_000 })).toString("base64url")}.bad`;
    expect(await call("app-setup", { headers: ADMIN }, `?code=c&state=${encodeURIComponent(forged)}`)).toEqual({
      status: 400, body: { error: "invalid or expired state" },
    });
    expect(f.calls).toEqual([]);
  });

  describe("webhook", () => {
    async function seedInstallation(): Promise<void> {
      const now = Date.now();
      await api!.providers.db.insert(githubInstallations).values({
        id: "ghi_parity", orgId: "local-org", installationId: 999, accountLogin: "acme",
        accountType: "Organization", repositorySelection: "all", suspended: false, createdAt: now, updatedAt: now,
      });
    }

    async function deliver(body: string | Uint8Array, headers: Record<string, string>) {
      return call("webhook", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    }

    it("acknowledges with 204 when no App is configured anywhere", async () => {
      api = await bootTestApi({ plugins: [githubPlugin] });
      expect(await deliver("{}", { "x-github-event": "ping" })).toEqual({ status: 204, body: null });
    });

    it("refuses missing and wrong signatures without side effects", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      await seedInstallation();
      const f = useFixture({ listInstallations: () => ({ body: [] }) });
      const deleted = JSON.stringify({ action: "deleted", installation: { id: 999 } });
      const created = JSON.stringify({ action: "created", installation: { id: 999 } });
      const refusal = { status: 403, body: { error: "signature verification failed" } };
      expect(await deliver(deleted, { "x-github-event": "installation" })).toEqual(refusal);
      expect(await deliver(deleted, { "x-github-event": "installation", "x-hub-signature-256": sign(deleted, "wrong") })).toEqual(refusal);
      expect(await deliver(created, { "x-github-event": "installation", "x-hub-signature-256": sign(created, "wrong") })).toEqual(refusal);
      const rows = await api.providers.db.select({ id: githubInstallations.id }).from(githubInstallations);
      expect(rows).toEqual([{ id: "ghi_parity" }]);
      expect(f.calls).toEqual([]);
    });

    it("answers 400 for a signed body that is not JSON", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      expect(await deliver("not json", { "x-github-event": "ping", "x-hub-signature-256": sign("not json", ENV_APP.GITHUB_APP_WEBHOOK_SECRET) })).toEqual({
        status: 400, body: { error: "invalid JSON" },
      });
    });

    it("verifies the exact raw bytes and applies a signed delivery", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      await seedInstallation();
      // Whitespace and key order differ from JSON.stringify output on purpose.
      const raw = '{ "installation": {"id":999},  "action":"suspend" }\n';
      expect(await deliver(raw, { "x-github-event": "installation", "x-hub-signature-256": sign(raw, ENV_APP.GITHUB_APP_WEBHOOK_SECRET) })).toEqual({
        status: 204, body: null,
      });
      const [row] = await api.providers.db.select({ suspended: githubInstallations.suspended }).from(githubInstallations);
      expect(row).toEqual({ suspended: true });
    });

    it.each([true, false])("refuses a body above 1 MiB (declared length: %s)", async (declared) => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      const size = 1024 * 1024 + 1;
      const chunk = new Uint8Array(64 * 1024).fill(32);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= size) { controller.close(); return; }
          const next = chunk.subarray(0, Math.min(chunk.byteLength, size - sent));
          sent += next.byteLength;
          controller.enqueue(next);
        },
      });
      const headers: Record<string, string> = { "Content-Type": "application/json", "x-github-event": "ping" };
      if (declared) headers["content-length"] = String(size);
      // Node requires duplex for a streaming request body.
      const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: stream, duplex: "half" };
      const response = await fetch(`${api.baseUrl}${url.webhook}`, init);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "payload too large" });
    });
  });
});
