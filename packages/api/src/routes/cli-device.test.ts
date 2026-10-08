/**
 * Device sign-in for `valet login` against a real API with real auth, the
 * agent-access page, and the authority a CLI token has. The "browser" is
 * the signed-in session cookie driving the routes the `/cli/device` page
 * calls.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { like } from "drizzle-orm";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceLogin } from "../cli/device-login.js";
import { AuthError } from "../cli/exit.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createPolicy } from "../policies/admin.js";
import { clearDeviceStartLimits, clientKey } from "./cli-device.js";
import { actionInvocations, oauthAccessToken, oauthApplication, workflowActionGrants } from "../schema/index.js";

let api: TestApi | undefined;
let faux: FauxProviderRegistration | undefined;
afterEach(async () => {
  clearDeviceStartLimits();
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

/** A high-risk action, which needs approval by risk default. */
function widgetsPlugin(): ValetPlugin {
  const deploy: PluginAction = {
    id: "deploy", name: "deploy", description: "Deploy widgets.", riskLevel: "high",
    parameters: Type.Object({ target: Type.Optional(Type.String()) }),
    execute: async () => ({ success: true, data: {} }),
  };
  return { name: "widgets", version: "0.0.1", actions: [{ service: "widgets", actions: [deploy] }] };
}

function deployWorkflow(target: string) {
  return {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "ship", type: "tool", service: "widgets", action: "deploy", params: { target } },
      { id: "stop", type: "stop" },
    ],
    edges: [{ from: "trigger", to: "ship" }, { from: "ship", to: "stop" }],
  };
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

const json = (cookie: string, base: string) => ({ cookie, "Content-Type": "application/json", Origin: new URL(base).origin });

/** What the person does on `/cli/device`: read the request, then allow or deny it. */
async function decideInBrowser(base: string, cookie: string, userCode: string, accept: boolean) {
  const info = await fetch(`${base}/api/cli/device?user_code=${encodeURIComponent(userCode.toLowerCase())}`, { headers: { cookie } });
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({ account: "cli@nowhere.test", device: "test-box", user_code: userCode });
  const decided = await fetch(`${base}/api/cli/device`, { method: "POST", headers: json(cookie, base), body: JSON.stringify({ user_code: userCode, accept }) });
  expect(decided.status).toBe(200);
}

/** Run the CLI's device sign-in; the person decides during the first poll wait. */
function signIn(base: string, cookie: string, accept = true) {
  const lines: string[] = [];
  let decided = false;
  const opened: string[] = [];
  const run = deviceLogin({
    url: base, device: "test-box",
    log: (line) => lines.push(line),
    openUrl: async (url) => {
      opened.push(url);
      return true;
    },
    sleep: async () => {
      if (decided) return;
      decided = true;
      const code = lines.map((l) => l.trim()).find((l) => /^[A-Z]{4}-[A-Z]{4}$/.test(l));
      if (!code) throw new Error("no user code shown");
      await decideInBrowser(base, cookie, code, accept);
    },
  });
  return { run, lines, opened };
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

describe("valet login device sign-in", () => {
  it("signs the CLI in with a token, not an API key, and lets the person see and disconnect it", async () => {
    const { base, cookie } = await setup();
    const { run, lines, opened } = signIn(base, cookie);
    const tokens = await run;
    // The page URL never carries the code: a forwarded link cannot approve a CLI.
    expect(opened).toEqual([`${base}/cli/device`]);
    expect(tokens.access_token.startsWith("vltc_")).toBe(true);
    expect(lines.join("\n")).not.toContain(tokens.access_token);

    const me = await fetch(`${base}/api/me`, { headers: { "x-api-key": tokens.access_token } });
    expect(((await me.json()) as { email: string }).email).toBe("cli@nowhere.test");
    // No API key was created.
    const keys = await fetch(`${base}/api/auth/api-key/list`, { headers: { cookie } });
    expect(JSON.stringify(await keys.json())).not.toContain("valet CLI");

    const apps = (await (await fetch(`${base}/api/me/agent-access`, { headers: { cookie } })).json()) as { cli_devices: Array<{ id: string; device: string }> };
    expect(apps.cli_devices).toEqual([expect.objectContaining({ device: "test-box" })]);

    // A refresh replaces both tokens. Once the new pair is used, the old refresh token is dead.
    const refresh = (token: string) => fetch(`${base}/api/cli/token/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: token }) });
    const fresh = (await (await refresh(tokens.refresh_token)).json()) as { access_token: string };
    expect((await fetch(`${base}/api/me`, { headers: { "x-api-key": fresh.access_token } })).status).toBe(200);
    expect((await refresh(tokens.refresh_token)).status).toBe(401);

    // Disconnecting in Settings signs the CLI out at once.
    const gone = await fetch(`${base}/api/me/agent-access/cli/${apps.cli_devices[0]?.id}`, { method: "DELETE", headers: json(cookie, base) });
    expect(gone.status).toBe(200);
    expect((await fetch(`${base}/api/me`, { headers: { "x-api-key": fresh.access_token } })).status).toBe(401);
  });

  it("signs out on revoke, rejects with AuthError when denied, and gives up when the code expires", async () => {
    const { base, cookie } = await setup();
    const tokens = await signIn(base, cookie).run;
    await fetch(`${base}/api/cli/token/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokens.refresh_token }) });
    expect((await fetch(`${base}/api/me`, { headers: { "x-api-key": tokens.access_token } })).status).toBe(401);

    await expect(signIn(base, cookie, false).run).rejects.toThrow(/denied/);

    let clock = Date.now();
    await expect(deviceLogin({
      url: base, device: "test-box", log: () => undefined, openUrl: async () => false,
      now: () => clock, sleep: async () => { clock += 11 * 60_000; },
    })).rejects.toBeInstanceOf(AuthError);
  });

  it("asks a fast poller to slow down, and refuses API keys, foreign origins, signed-out visitors, and unknown codes", async () => {
    const { base, cookie } = await setup();
    const started = (await (await fetch(`${base}/api/cli/device/code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: "x" }) })).json()) as { device_code: string; user_code: string };
    const poll = () => fetch(`${base}/api/cli/device/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_code: started.device_code }) });
    expect(((await (await poll()).json()) as { error: string }).error).toBe("authorization_pending");
    expect(((await (await poll()).json()) as { error: string }).error).toBe("slow_down");

    const keyRes = await fetch(`${base}/api/auth/api-key/create`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "k" }) });
    const { key } = (await keyRes.json()) as { key: string };
    const q = `user_code=${started.user_code}`;
    expect((await fetch(`${base}/api/cli/device?${q}`, { headers: { "x-api-key": key } })).status).toBe(403);
    expect((await fetch(`${base}/api/cli/device?${q}`)).status).toBe(401);
    expect((await fetch(`${base}/api/cli/device?user_code=BBBB-BBBB`, { headers: { cookie } })).status).toBe(404);
    const foreign = await fetch(`${base}/api/cli/device`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ user_code: started.user_code, accept: true }),
    });
    expect(foreign.status).toBe(403);
    // A code is decided once.
    const decide = () => fetch(`${base}/api/cli/device`, { method: "POST", headers: json(cookie, base), body: JSON.stringify({ user_code: started.user_code, accept: true }) });
    expect((await decide()).status).toBe(200);
    expect((await decide()).status).toBe(404);
  });

  it("lists and disconnects an MCP app; an agent credential cannot disconnect anything", async () => {
    const { testApi, base, cookie } = await setup();
    const tokens = await signIn(base, cookie).run;
    const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { id: string };
    const now = new Date();
    await testApi.providers.db.insert(oauthApplication).values({ id: "app-1", name: "Claude Code", clientId: "client-1", type: "public", createdAt: now, updatedAt: now });
    await testApi.providers.db.insert(oauthAccessToken).values({
      id: "tok-1", accessToken: "mcp-token", refreshToken: "mcp-refresh", clientId: "client-1", userId: me.id, scopes: "openid",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000), refreshTokenExpiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now,
    });
    const apps = (await (await fetch(`${base}/api/me/agent-access`, { headers: { cookie } })).json()) as { mcp_apps: Array<{ client_id: string; name: string }> };
    expect(apps.mcp_apps).toEqual([expect.objectContaining({ client_id: "client-1", name: "Claude Code" })]);

    const asAgent = await fetch(`${base}/api/me/agent-access/mcp/client-1`, { method: "DELETE", headers: { "x-api-key": tokens.access_token } });
    expect(asAgent.status).toBe(403);
    expect((await fetch(`${base}/api/me/agent-access/mcp/client-1`, { method: "DELETE", headers: json(cookie, base) })).status).toBe(200);
    expect(await testApi.providers.db.select().from(oauthAccessToken)).toEqual([]);
  });

  it("does not let a CLI token approve a gate or change policy; a Settings key still can", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    const { testApi, base, cookie } = await setup({ plugins: [riskyPlugin()] });
    const cliToken = (await signIn(base, cookie).run).access_token;
    const created = await fetch(`${base}/api/auth/api-key/create`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "settings key" }),
    });
    const { key: personKey } = (await created.json()) as { key: string };
    const me = (await (await fetch(`${base}/api/me`, { headers: { "x-api-key": cliToken } })).json()) as { orgId: string };
    await createPolicy(testApi.providers.db, { orgId: me.orgId, type: "org", id: me.orgId }, { actionId: "demo.risky", mode: "require_approval", managedBy: "test", now: Date.now() });

    // The agent's CLI starts work that raises an approval gate.
    faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "demo.risky", params: {}, summary: "Run the risky action" }, { id: "tc-risky" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const thread = (await (await fetch(`${base}/api/threads`, {
      method: "POST", headers: { "x-api-key": cliToken, "Content-Type": "application/json" }, body: "{}",
    })).json()) as { id: string };
    await fetch(`${base}/api/threads/${thread.id}/messages`, {
      method: "POST", headers: { "x-api-key": cliToken, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Run demo.risky." }),
    });
    const gate = await waitForGate(base, cliToken, thread.id);
    const resolve = (key: string) => fetch(`${base}/api/threads/${thread.id}/decisions/${gate.id}/resolve`, {
      method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ actionId: gate.actions[0]?.id }),
    });
    const refused = await resolve(cliToken);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("A person must approve this request");
    expect((await resolve(personKey)).status).toBe(200);

    // Policy, approval, and admin routes refuse the CLI token before the route runs.
    const writes: Array<[string, string]> = [
      ["POST", "/api/org/policies"],
      ["PUT", "/api/me/policy-overrides"],
      ["DELETE", "/api/me/grants"],
      ["DELETE", "/api/me/agent-access/cli/x"],
      ["POST", "/api/workflows/runs/run-1/approvals/node-1"],
      ["POST", "/api/workflows/wf-1/permissions/allow"],
      ["POST", "/api/teams/team-1/policies"],
      ["PUT", "/api/teams/team-1/policy-overrides"],
      ["POST", "/api/teams/team-1/members"],
      ["POST", "/api/teams/team-1/api-keys"],
      ["PATCH", "/api/teams/team-1"],
      ["PATCH", "/api/org/settings"],
      ["PATCH", "/api/org/members/someone"],
      ["POST", "/api/credentials/github/delegate"],
      // Found in review: browser grants, chat identity links, workflow edits.
      ["PATCH", "/api/sessions/s-1/browser/settings"],
      ["POST", "/api/me/identity-links/slack/start"],
      ["POST", "/api/me/identity-links/slack/deliver"],
      ["PUT", "/api/workflows/wf-1"],
      ["POST", "/api/workflows"],
      ["PATCH", "/api/me"],
    ];
    for (const [method, path] of writes) {
      const asAgent = await fetch(`${base}${path}`, { method, headers: { "x-api-key": cliToken, "Content-Type": "application/json" }, body: "{}" });
      expect(asAgent.status, `${method} ${path}`).toBe(403);
      expect(await asAgent.text()).toContain("Agent credentials");
      const asPerson = await fetch(`${base}${path}`, { method, headers: { "x-api-key": personKey, "Content-Type": "application/json" }, body: "{}" });
      expect(await asPerson.text(), `${method} ${path}`).not.toContain("Agent credentials");
    }
    // A brokered call records which kind of credential made it.
    const call = await fetch(`${base}/api/actions/demo.risky/invoke`, {
      method: "POST", headers: { "x-api-key": cliToken, "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }),
    });
    expect(((await call.json()) as { status: string }).status).toBe("approval_required");
    const audit = await testApi.providers.db.select().from(actionInvocations).where(like(actionInvocations.invocationId, "pol:ext:%"));
    expect(audit.map((row) => row.caller)).toEqual(["cli"]);

    // A policy preview changes nothing, so an agent may run it.
    const preview = await fetch(`${base}/api/org/policies/preview`, { method: "POST", headers: { "x-api-key": cliToken, "Content-Type": "application/json" }, body: "{}" });
    expect(await preview.text()).not.toContain("Agent credentials");
  });

  it("refuses a CLI token's workflow edit, keeps the person's grant, and revokes grants on an agent edit through the service", async () => {
    const { testApi, base, cookie } = await setup({ plugins: [widgetsPlugin()] });
    const cliToken = (await signIn(base, cookie).run).access_token;
    const created = await fetch(`${base}/api/workflows`, { method: "POST", headers: json(cookie, base), body: JSON.stringify({ name: "Deploy", definition: deployWorkflow("staging") }) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await fetch(`${base}/api/workflows/${id}/permissions/allow`, { method: "POST", headers: json(cookie, base), body: "{}" })).status).toBe(200);
    const grants = () => testApi.providers.db.select().from(workflowActionGrants);
    expect((await grants()).map((g) => g.actionId)).toEqual(["widgets.deploy"]);

    // The reviewer's repro: the agent points the approved step at production.
    const agentEdit = await fetch(`${base}/api/workflows/${id}`, {
      method: "PUT", headers: { "x-api-key": cliToken, "Content-Type": "application/json" }, body: JSON.stringify({ definition: deployWorkflow("production") }),
    });
    expect(agentEdit.status).toBe(403);
    expect((await grants()).map((g) => g.actionId)).toEqual(["widgets.deploy"]);

    // A person who can grant keeps the approval when they edit.
    const personEdit = await fetch(`${base}/api/workflows/${id}`, { method: "PUT", headers: json(cookie, base), body: JSON.stringify({ definition: deployWorkflow("canary") }) });
    expect(personEdit.status).toBe(200);
    expect((await grants()).map((g) => g.actionId)).toEqual(["widgets.deploy"]);

    // Valet's assistant is an agent too: its step change revokes the grant.
    const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { id: string; orgId: string };
    const { updateWorkflowDefinition } = await import("../workflows/service.js");
    await updateWorkflowDefinition(
      { db: testApi.providers.db, workflowStore: testApi.providers.workflowStore, workflowRunHost: testApi.providers.workflowRunHost, actionPluginByService: testApi.providers.actionPluginByService, credentials: testApi.providers.engineCredentials, engineStore: testApi.providers.engineStore },
      { userId: me.id, orgId: me.orgId, principal: { type: "user", id: me.id }, agentEditor: true },
      id,
      { definition: deployWorkflow("production") },
    );
    expect(await grants()).toEqual([]);
  });

  it("keeps the replaced pair working briefly, and recovers a lost refresh response only while the new pair is unused", async () => {
    const { base, cookie } = await setup();
    const first = await signIn(base, cookie).run;
    const refresh = async (token: string) => {
      const res = await fetch(`${base}/api/cli/token/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: token }) });
      return { status: res.status, body: (await res.json()) as { access_token: string; refresh_token: string } };
    };
    const me = (token: string) => fetch(`${base}/api/me`, { headers: { "x-api-key": token } }).then((r) => r.status);

    const second = await refresh(first.refresh_token);
    expect(second.status).toBe(200);
    // A command that read the old access token just before the refresh still works.
    expect(await me(first.access_token)).toBe(200);
    // The response was lost: replaying the old refresh token issues another pair.
    const third = await refresh(first.refresh_token);
    expect(third.status).toBe(200);
    expect(await me(third.body.access_token)).toBe(200);
    // Once the new pair is in use, the old refresh token is dead.
    expect((await refresh(first.refresh_token)).status).toBe(401);
    expect((await refresh(third.body.refresh_token)).status).toBe(200);
  });

  it("limits how many sign-ins one client starts per minute", async () => {
    const { base } = await setup();
    const start = () => fetch(`${base}/api/cli/device/code`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" }, body: "{}" });
    for (let i = 0; i < 10; i++) expect((await start()).status).toBe(200);
    const limited = await start();
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("Wait a minute");
    // Rotating the client-supplied hops does not escape the limit: behind a
    // proxy, only the last hop (the one the proxy appended) counts.
    const spoofed = await fetch(`${base}/api/cli/device/code`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "1.2.3.4, 203.0.113.9" }, body: "{}" });
    expect(spoofed.status).toBe(429);
    // Another client is not affected.
    const other = await fetch(`${base}/api/cli/device/code`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.4" }, body: "{}" });
    expect(other.status).toBe(200);
  });

  it("keys the rate limit on the peer, or on the proxy's last hop, never on a forged one", () => {
    expect(clientKey("203.0.113.5", "9.9.9.9")).toBe("203.0.113.5");
    expect(clientKey("10.0.0.7", "9.9.9.9, 198.51.100.2")).toBe("198.51.100.2");
    expect(clientKey("::ffff:127.0.0.1", "198.51.100.3")).toBe("198.51.100.3");
    expect(clientKey("127.0.0.1", undefined)).toBe("127.0.0.1");
  });
});
