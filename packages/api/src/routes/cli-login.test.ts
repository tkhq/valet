/**
 * Browser sign-in for `valet login`: the CLI's loopback flow against a real
 * API with real auth. The "browser" here is the signed-in session cookie
 * driving the same routes the `/cli/login` page calls.
 */
import { createHash, randomBytes } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { browserLogin } from "../cli/browser-login.js";
import { AuthError } from "../cli/exit.js";
import { like } from "drizzle-orm";
import { createPolicy } from "../policies/admin.js";
import { actionInvocations } from "../schema/index.js";

let api: TestApi | undefined;
let faux: FauxProviderRegistration | undefined;
afterEach(async () => {
  faux?.unregister();
  faux = undefined;
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

function riskyPlugin(): ValetPlugin {
  const risky: PluginAction = {
    id: "demo.risky", name: "risky", description: "A gated demo action.", riskLevel: "low",
    parameters: Type.Object({}),
    execute: async () => ({ success: true, data: { ran: true } }),
  };
  return { name: "demo", version: "0.0.1", actions: [{ service: "demo", actions: [risky] }] };
}

function sessionCookie(setCookie: string | null): string {
  const match = setCookie?.match(/better-auth\.session_token=[^;]+/);
  if (!match) throw new Error("no session cookie");
  return match[0];
}

async function setup(opts: { plugins?: ValetPlugin[] } = {}) {
  const testApi = await bootTestApi({ auth: true, ...(opts.plugins ? { plugins: opts.plugins } : {}) });
  api = testApi;
  const signUp = await fetch(`${testApi.baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "CLI User", email: "cli@nowhere.test", password: "correct-horse-battery" }),
  });
  expect(signUp.status).toBe(200);
  return { testApi, base: testApi.baseUrl, cookie: sessionCookie(signUp.headers.get("set-cookie")) };
}

/** What the `/cli/login` page does: read the request, then post the person's choice. */
async function approveInBrowser(base: string, cookie: string, approveUrl: string, accept: boolean): Promise<string> {
  const q = new URL(approveUrl).searchParams;
  const info = await fetch(`${base}/api/cli/login?${new URLSearchParams({
    redirect_uri: q.get("redirect_uri") ?? "", code_challenge: q.get("code_challenge") ?? "", device: q.get("device") ?? "",
  }).toString()}`, { headers: { cookie } });
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({ account: "cli@nowhere.test", device: "test-box" });
  const decided = await fetch(`${base}/api/cli/login`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", Origin: new URL(base).origin },
    body: JSON.stringify({
      redirect_uri: q.get("redirect_uri"), code_challenge: q.get("code_challenge"), state: q.get("state"), device: q.get("device"), accept,
    }),
  });
  expect(decided.status).toBe(200);
  return ((await decided.json()) as { redirect: string }).redirect;
}

/** Run the CLI's browser sign-in with the person allowing it, and return the key. */
async function cliKey(base: string, cookie: string): Promise<string> {
  return browserLogin({
    url: base, device: "test-box", log: () => undefined,
    openUrl: async (url) => {
      await fetch(await approveInBrowser(base, cookie, url, true));
      return true;
    },
  });
}

async function waitForGate(base: string, key: string, threadId: string): Promise<{ id: string; actions: Array<{ id: string }> }> {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/threads/${threadId}/decisions`, { headers: { "x-api-key": key } });
    const { gates } = (await res.json()) as { gates: Array<{ id: string; actions: Array<{ id: string }> }> };
    if (gates[0]) return gates[0];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no gate");
}

describe("valet login browser sign-in", () => {
  it("returns a working personal API key after the person allows it", async () => {
    const { base, cookie } = await setup();
    const lines: string[] = [];
    const key = await browserLogin({
      url: base,
      device: "test-box",
      log: (line) => lines.push(line),
      openUrl: async (url) => {
        expect(new URL(url).pathname).toBe("/cli/login");
        const redirect = await approveInBrowser(base, cookie, url, true);
        // The browser follows the redirect to the CLI's loopback listener.
        const landed = await fetch(redirect);
        expect(await landed.text()).toContain("Valet CLI signed in");
        return true;
      },
    });
    // The agent prefix marks it as an agent credential (lib/request-principal.ts).
    expect(key.startsWith("vlt_agent_")).toBe(true);
    expect(lines.join("\n")).not.toContain(key);
    const me = await fetch(`${base}/api/me`, { headers: { "x-api-key": key } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe("cli@nowhere.test");
    const keys = await fetch(`${base}/api/auth/api-key/list`, { headers: { cookie } });
    expect(JSON.stringify(await keys.json())).toContain("valet CLI (test-box)");
  });

  it("rejects with AuthError when the person denies it", async () => {
    const { base, cookie } = await setup();
    await expect(browserLogin({
      url: base,
      device: "test-box",
      log: () => undefined,
      openUrl: async (url) => {
        const redirect = await approveInBrowser(base, cookie, url, false);
        expect(new URL(redirect).searchParams.get("code")).toBeNull();
        await fetch(redirect);
        return true;
      },
    })).rejects.toThrow(/denied/);
  });

  it("gives up with AuthError when nobody approves in time", async () => {
    const { base } = await setup();
    await expect(browserLogin({ url: base, log: () => undefined, openUrl: () => Promise.resolve(false), timeoutMs: 50 }))
      .rejects.toBeInstanceOf(AuthError);
  });

  it("exchanges a code once, and only with its PKCE verifier", async () => {
    const { base, cookie } = await setup();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = "http://127.0.0.1:45678/callback";
    const approveUrl = `${base}/cli/login?${new URLSearchParams({ redirect_uri: redirectUri, code_challenge: challenge, state: "s", device: "test-box" }).toString()}`;
    const code = new URL(await approveInBrowser(base, cookie, approveUrl, true)).searchParams.get("code") ?? "";
    const exchange = (v: string) => fetch(`${base}/api/cli/login/token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: v, redirect_uri: redirectUri }),
    });
    // A wrong verifier burns the code, so a stolen code cannot be retried.
    expect((await exchange("wrong-verifier")).status).toBe(400);
    expect((await exchange(verifier)).status).toBe(400);
  });

  it("refuses a non-loopback redirect, an API key caller, a foreign origin, and a signed-out visitor", async () => {
    const { base, cookie } = await setup();
    const challenge = createHash("sha256").update("v").digest("base64url");
    const q = (redirect: string) => new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, device: "x" }).toString();

    expect((await fetch(`${base}/api/cli/login?${q("https://evil.example/callback")}`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/api/cli/login?${q("http://127.0.0.1/callback")}`, { headers: { cookie } })).status).toBe(400);

    const keyRes = await fetch(`${base}/api/auth/api-key/create`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "k" }),
    });
    const { key } = (await keyRes.json()) as { key: string };
    expect((await fetch(`${base}/api/cli/login?${q("http://127.0.0.1:4000/callback")}`, { headers: { "x-api-key": key } })).status).toBe(403);

    const foreign = await fetch(`${base}/api/cli/login`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ redirect_uri: "http://127.0.0.1:4000/callback", code_challenge: challenge, state: "", device: "x", accept: true }),
    });
    expect(foreign.status).toBe(403);

    expect((await fetch(`${base}/api/cli/login?${q("http://127.0.0.1:4000/callback")}`)).status).toBe(401);
  });

  it("does not let a valet login key approve a gate or change policy; a Settings key still can", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    const { testApi, base, cookie } = await setup({ plugins: [riskyPlugin()] });
    const agentKey = await cliKey(base, cookie);
    const created = await fetch(`${base}/api/auth/api-key/create`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "settings key" }),
    });
    const { key: personKey } = (await created.json()) as { key: string };
    const me = (await (await fetch(`${base}/api/me`, { headers: { "x-api-key": agentKey } })).json()) as { orgId: string };
    await createPolicy(testApi.providers.db, { orgId: me.orgId, type: "org", id: me.orgId }, { actionId: "demo.risky", mode: "require_approval", managedBy: "test", now: Date.now() });

    // The reviewer's repro: the agent's key starts work that raises an approval gate.
    faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "demo.risky", params: {}, summary: "Run the risky action" }, { id: "tc-risky" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const thread = (await (await fetch(`${base}/api/threads`, {
      method: "POST", headers: { "x-api-key": agentKey, "Content-Type": "application/json" }, body: "{}",
    })).json()) as { id: string };
    await fetch(`${base}/api/threads/${thread.id}/messages`, {
      method: "POST", headers: { "x-api-key": agentKey, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Run demo.risky." }),
    });
    const gate = await waitForGate(base, agentKey, thread.id);
    const resolve = (key: string) => fetch(`${base}/api/threads/${thread.id}/decisions/${gate.id}/resolve`, {
      method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ actionId: gate.actions[0]?.id }),
    });
    const refused = await resolve(agentKey);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("A person must approve this request");
    expect((await resolve(personKey)).status).toBe(200);

    // Policy and approval routes refuse the agent key before the route runs.
    const writes: Array<[string, string]> = [
      ["POST", "/api/org/policies"],
      ["PUT", "/api/me/policy-overrides"],
      ["DELETE", "/api/me/grants"],
      ["POST", "/api/workflows/runs/run-1/approvals/node-1"],
    ];
    for (const [method, path] of writes) {
      const asAgent = await fetch(`${base}${path}`, { method, headers: { "x-api-key": agentKey, "Content-Type": "application/json" }, body: "{}" });
      expect(asAgent.status, `${method} ${path}`).toBe(403);
      expect(await asAgent.text()).toContain("Agent credentials");
      const asPerson = await fetch(`${base}${path}`, { method, headers: { "x-api-key": personKey, "Content-Type": "application/json" }, body: "{}" });
      expect(await asPerson.text(), `${method} ${path}`).not.toContain("Agent credentials");
    }
    // A brokered call records which kind of credential made it.
    const call = await fetch(`${base}/api/actions/demo.risky/invoke`, {
      method: "POST", headers: { "x-api-key": agentKey, "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }),
    });
    expect(((await call.json()) as { status: string }).status).toBe("approval_required");
    const audit = await testApi.providers.db.select().from(actionInvocations).where(like(actionInvocations.invocationId, "pol:ext:%"));
    expect(audit.map((row) => row.caller)).toEqual(["agentKey"]);

    // A policy preview changes nothing, so an agent may run it.
    const preview = await fetch(`${base}/api/org/policies/preview`, { method: "POST", headers: { "x-api-key": agentKey, "Content-Type": "application/json" }, body: "{}" });
    expect(await preview.text()).not.toContain("Agent credentials");
  });
});
