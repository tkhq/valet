/**
 * `valet proxy setup` key flow against a real API with real auth: the CLI
 * starts a `proxy-key` device request with its CLI token, the same person
 * approves it in the browser, and the poll returns a proxy-scoped key once.
 * The key carries Claude Code traffic through the gateway under that person,
 * works nowhere else on the API, and the CLI token revokes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintCliToken } from "../auth/cli-tokens.js";
import { apikey, llmProxyRequests, orgMembers, users } from "../schema/index.js";
import { createLlmProvider } from "../services/llm-providers.js";
import { setProxySettings } from "../services/org.js";
import { clearDeviceStartLimits } from "./cli-device.js";
import type { CliDeviceCodeResponse, CliDeviceInfo, CliProxyKeyResponse, CreateInviteResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  clearDeviceStartLimits();
  await api?.cleanup();
  api = undefined;
});

function sessionCookie(res: Response): string {
  const cookie = res.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
  if (!cookie) throw new Error("Expected a session cookie");
  return cookie;
}

async function signUp(base: string, email: string, inviteCode?: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: email, email, password: "correct-horse-battery", ...(inviteCode ? { inviteCode } : {}) }),
  });
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

async function invite(base: string, adminCookie: string): Promise<string> {
  const res = await fetch(`${base}/api/org/invites`, {
    method: "POST", headers: { "content-type": "application/json", cookie: adminCookie }, body: JSON.stringify({ role: "member" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as CreateInviteResponse).code;
}

async function userId(target: TestApi, email: string): Promise<string> {
  const [row] = await target.providers.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!row) throw new Error(`Expected user ${email}`);
  return row.id;
}

function start(base: string, body: Record<string, unknown>, cliToken?: string) {
  return fetch(`${base}/api/cli/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cliToken ? { "x-api-key": cliToken } : {}) },
    body: JSON.stringify(body),
  });
}

function poll(base: string, deviceCode: string) {
  return fetch(`${base}/api/cli/device/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: deviceCode }),
  });
}

function browser(base: string, cookie: string) {
  return {
    info: (userCode: string) => fetch(`${base}/api/cli/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie } }),
    decide: (userCode: string, accept: boolean) => fetch(`${base}/api/cli/device`, {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: new URL(base).origin },
      body: JSON.stringify({ user_code: userCode, accept }),
    }),
  };
}

describe("proxy key device flow", () => {
  it("gives the CLI's own account a proxy-only key that carries Claude Code traffic and revokes with the CLI token", async () => {
    api = await bootTestApi({ auth: true });
    const { baseUrl, providers } = api;
    const ownerCookie = await signUp(baseUrl, "owner@example.test");
    const otherCookie = await signUp(baseUrl, "other@example.test", await invite(baseUrl, ownerCookie));
    const ownerId = await userId(api, "owner@example.test");
    const cli = await mintCliToken(providers.db, ownerId, "test-box");

    // The CLI token alone cannot mint an API key through better-auth.
    const direct = await fetch(`${baseUrl}/api/auth/api-key/create`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": cli.access_token }, body: JSON.stringify({ name: "sneaky" }),
    });
    expect(direct.ok).toBe(false);

    expect((await start(baseUrl, { device: "test-box", purpose: "proxy-key", key_name: "claude-code@test-box" })).status).toBe(401);
    expect((await start(baseUrl, { device: "test-box", purpose: "proxy-key" }, cli.access_token)).status).toBe(400);
    expect((await start(baseUrl, { device: "test-box", purpose: "admin" }, cli.access_token)).status).toBe(400);
    const started = await start(baseUrl, { device: "test-box", purpose: "proxy-key", key_name: "claude-code@test-box" }, cli.access_token);
    expect(started.status).toBe(200);
    const code = (await started.json()) as CliDeviceCodeResponse;
    // The CLI checks this echo, so an older instance cannot turn the request into a sign-in.
    expect(code.purpose).toBe("proxy-key");

    // Another person cannot see or approve it.
    expect((await browser(baseUrl, otherCookie).info(code.user_code)).status).toBe(404);
    expect((await browser(baseUrl, otherCookie).decide(code.user_code, true)).status).toBe(404);
    expect(((await (await poll(baseUrl, code.device_code)).json()) as { error: string }).error).toBe("authorization_pending");

    const owner = browser(baseUrl, ownerCookie);
    const info = (await (await owner.info(code.user_code)).json()) as CliDeviceInfo;
    expect(info).toMatchObject({ purpose: "proxy-key", key_name: "claude-code@test-box", device: "test-box", account: "owner@example.test" });
    expect(info.limits.join(" ")).toContain("Disconnecting the CLI does not revoke it");
    expect((await owner.decide(code.user_code, true)).status).toBe(200);

    const done = await poll(baseUrl, code.device_code);
    expect(done.status).toBe(200);
    const { proxy_key: key } = (await done.json()) as CliProxyKeyResponse;
    expect(key.key.startsWith("vlt_")).toBe(true);
    expect(key.name).toBe("claude-code@test-box");
    // The key is handed out once.
    expect(((await (await poll(baseUrl, code.device_code)).json()) as { error: string }).error).toBe("expired_token");
    const [row] = await providers.db.select().from(apikey).where(eq(apikey.id, key.id));
    expect(row).toMatchObject({ referenceId: ownerId, teamId: null });
    expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({ scope: "proxy" });

    // The key works nowhere on the Valet API.
    expect((await fetch(`${baseUrl}/api/me`, { headers: { "x-api-key": key.key } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/threads`, { headers: { "x-api-key": key.key } })).status).toBe(401);

    const [membership] = await providers.db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, ownerId));
    if (!membership) throw new Error("Expected an org membership");
    const orgId = membership.orgId;
    const provider = await createLlmProvider(providers.db, { orgId, kind: "anthropic", name: "Org proxy" });
    await providers.engineCredentials.save({ type: "org", id: orgId }, `llm:${provider.id}`, { type: "api_key", apiKey: "org-anthropic-key" });
    await setProxySettings(providers.db, orgId, { enabled: true, mode: "centralized" });

    const nativeFetch = globalThis.fetch;
    const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      id: "msg_cli", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 40, output_tokens: 7 },
    }), { headers: { "content-type": "application/json" } }));
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith("https://api.anthropic.com/") ? upstream(input, init) : nativeFetch(input, init);
    });
    const message = () => fetch(`${baseUrl}/proxy/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        // Claude Code sends the apiKeyHelper value as both headers.
        "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.0.0",
        "x-api-key": key.key, authorization: `Bearer ${key.key}`,
      },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    const proxied = await message();
    expect(proxied.status).toBe(200);
    expect(((await proxied.json()) as { content: Array<{ text: string }> }).content[0]?.text).toBe("ok");
    expect(new Headers(upstream.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBe("org-anthropic-key");
    await expect.poll(async () => providers.db.select().from(llmProxyRequests).where(eq(llmProxyRequests.apiKeyId, key.id))).toEqual([
      expect.objectContaining({ orgId, userId: ownerId, teamId: null, harness: "claude-code", inputTokens: 40, outputTokens: 7 }),
    ]);

    const revoke = (id: string, token: string) => fetch(`${baseUrl}/api/proxy/keys/${id}`, { method: "DELETE", headers: { "x-api-key": token } });
    const status = (id: string, token: string) => fetch(`${baseUrl}/api/proxy/keys/${id}`, { headers: { "x-api-key": token } });
    const otherCli = await mintCliToken(providers.db, await userId(api, "other@example.test"), "other-box");
    // The CLI token reads its key's status; another account's CLI sees nothing.
    const live = await status(key.id, cli.access_token);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ id: key.id, name: "claude-code@test-box" });
    expect((await status(key.id, otherCli.access_token)).status).toBe(404);
    // Another account's CLI cannot revoke it.
    expect((await revoke(key.id, otherCli.access_token)).status).toBe(404);
    expect((await revoke(key.id, cli.access_token)).status).toBe(204);
    const gone = await message();
    expect(gone.status).toBe(401);
    expect(((await gone.json()) as { error: { message: string } }).error.message).toContain("valet proxy setup");
    expect((await status(key.id, cli.access_token)).status).toBe(404);
    expect((await revoke(key.id, cli.access_token)).status).toBe(404);
  });

  it("refuses to revoke a key that is not proxy-scoped, and keeps login requests as they were", async () => {
    api = await bootTestApi({ auth: true });
    const { baseUrl, providers } = api;
    const cookie = await signUp(baseUrl, "owner@example.test");
    const ownerId = await userId(api, "owner@example.test");
    const cli = await mintCliToken(providers.db, ownerId, "test-box");
    const created = await fetch(`${baseUrl}/api/auth/api-key/create`, {
      method: "POST", headers: { "content-type": "application/json", cookie, origin: new URL(baseUrl).origin }, body: JSON.stringify({ name: "ci" }),
    });
    expect(created.status).toBe(200);
    const plain = (await created.json()) as { id: string };
    expect((await fetch(`${baseUrl}/api/proxy/keys/${plain.id}`, { method: "DELETE", headers: { "x-api-key": cli.access_token } })).status).toBe(404);
    expect(await providers.db.select({ id: apikey.id }).from(apikey).where(eq(apikey.id, plain.id))).toHaveLength(1);

    // A login request: any signed-in person may decide it, and it yields a CLI token.
    const started = (await (await start(baseUrl, { device: "box" })).json()) as CliDeviceCodeResponse;
    expect(started.purpose).toBe("login");
    // A plain key is not a proxy key: the status route does not confirm it.
    expect((await fetch(`${baseUrl}/api/proxy/keys/${plain.id}`, { headers: { "x-api-key": cli.access_token } })).status).toBe(404);
    const info =(await (await browser(baseUrl, cookie).info(started.user_code)).json()) as CliDeviceInfo;
    expect(info.purpose).toBe("login");
    expect((await browser(baseUrl, cookie).decide(started.user_code, true)).status).toBe(200);
    const tokens = (await (await poll(baseUrl, started.device_code)).json()) as { access_token: string };
    expect(tokens.access_token.startsWith("vltc_")).toBe(true);
  });
});
