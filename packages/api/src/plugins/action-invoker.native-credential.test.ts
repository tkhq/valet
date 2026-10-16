/**
 * Native integration credential policy, Part E: workflow tool nodes
 * (docs/specs/2026-10-15-native-integration-credential-policy-design.md).
 *
 * A tool node's `credential` field may name `app` or `user` for any native
 * service. `auto` follows the Part B order, so a node reads the person's
 * credential first and the app token last. A non-native service still
 * refuses an explicit selection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, StoredCredential, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { teamMembers, teams } from "../schema/index.js";
import { shareCredential } from "../services/credential-shares.js";
import * as credentialMetrics from "../observability/credential-metrics.js";
import { PgCredentialStore } from "./credential-store.js";
import { buildActionInvoker, type ActionInvocationContext } from "./action-invoker.js";

const orgId = "wf-native-org";
const userId = "u-001";
const sharer = "u-002";
const teamId = "platform";

const appRow: StoredCredential = {
  type: "oauth2",
  accessToken: "lin-app-token",
  metadata: { webhookSecret: "hook-secret-value", workspaceId: "ws-value", grant: "client_credentials", connectionId: "conn-value" },
};

/** Reads the way `mcpActionPlugin` does with `appCredentialService`: the
 * service's own credential, then the app credential when that is null. */
function probeAction(service: string, appService?: string): PluginAction {
  return {
    id: `${service}.probe`,
    name: "probe",
    description: "probe",
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: async (_args, ctx) => {
      const own = await ctx.credentials.get();
      const cred = own ?? (appService ? await ctx.credentials.get(appService) : null);
      return { success: true, data: { token: cred?.accessToken ?? null, metadata: cred?.metadata ?? null } };
    },
  };
}

function nativePlugin(): ValetPlugin {
  const actionPlugin: ActionPlugin = { service: "linear", actions: [probeAction("linear", "linear:app")] };
  return {
    name: "linear",
    version: "0.0.1",
    native: true,
    appCredentialService: "linear:app",
    actions: [actionPlugin],
    credentials: [{ type: "oauth2", configKeys: ["accessToken"] }],
  };
}

function slackLikePlugin(): ValetPlugin {
  const actionPlugin: ActionPlugin = { service: "slack", actions: [probeAction("slack")] };
  return {
    name: "slack",
    version: "0.0.1",
    native: true,
    appCredentialService: "slack",
    actions: [actionPlugin],
    credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
  };
}

function nonNativePlugin(): ValetPlugin {
  const actionPlugin: ActionPlugin = { service: "acme-docs", actions: [probeAction("acme-docs")] };
  return { name: "acme-docs", version: "0.0.1", actions: [actionPlugin], credentials: [{ type: "oauth2", configKeys: ["accessToken"] }] };
}

async function harness(): Promise<{ appDb: AppDb; credentials: PgCredentialStore }> {
  const { appDb, pgdb } = await freshTestPgDb();
  await appDb.insert(teams).values({ id: teamId, orgId, name: "Platform", createdAt: 1 });
  await appDb.insert(teamMembers).values([{ teamId, userId, role: "member" }, { teamId, userId: sharer, role: "member" }]);
  const credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
  await credentials.save({ type: "org", id: orgId }, "linear", appRow);
  return { appDb, credentials };
}

function invokerFor(appDb: AppDb, credentials: PgCredentialStore) {
  const plugins = [nativePlugin(), slackLikePlugin(), nonNativePlugin()];
  const actionPluginByService = new Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>();
  for (const plugin of plugins) {
    for (const actionPlugin of plugin.actions ?? []) actionPluginByService.set(actionPlugin.service, { plugin, actionPlugin });
  }
  return buildActionInvoker({ db: appDb, credentials, actionPluginByService, plugins });
}

const userCtx: ActionInvocationContext = { userId, orgId, owner: { type: "user", id: userId } };
const teamCtx: ActionInvocationContext = { userId, orgId, owner: { type: "team", id: teamId }, workflowExecutionId: "run-1" };
const orgCtx: ActionInvocationContext = { userId: `org:${orgId}`, orgId, owner: { type: "org", id: orgId } };

// The invoker settles one invocation id once, so every call gets its own.
let invocations = 0;
function node(service: string, credential?: "auto" | "app" | "user") {
  invocations += 1;
  return { service, action: "probe", params: {}, invocationId: `workflow:r1:n${invocations}`, ...(credential ? { credential } : {}) };
}

const bareApp = { ok: true, result: { token: "lin-app-token", metadata: null } };

describe("workflow tool nodes and native app identities (Part E)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a node pinned to app acts as the app, even when the person has a connection", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "personal-linear" });
    const invoke = invokerFor(appDb, credentials);

    expect(await invoke(node("linear", "app"), userCtx)).toEqual(bareApp);
    expect(await invoke(node("linear", "app"), teamCtx)).toEqual(bareApp);
    expect(await invoke(node("linear", "app"), orgCtx)).toEqual(bareApp);
  });

  it("a node pinned to app refuses with the fix when the app is not connected", async () => {
    const { appDb, credentials } = await harness();
    await credentials.delete({ type: "org", id: orgId }, "linear");
    const invoke = invokerFor(appDb, credentials);

    const result = await invoke(node("linear", "app"), teamCtx);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("Settings → Organization") });
  });

  it("a node pinned to user never reaches the app token", async () => {
    const { appDb, credentials } = await harness();
    const invoke = invokerFor(appDb, credentials);

    expect(await invoke(node("linear", "user"), userCtx)).toEqual({ ok: true, result: { token: null, metadata: null } });
    await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "personal-linear" });
    expect(await invoke(node("linear", "user"), userCtx)).toEqual({ ok: true, result: { token: "personal-linear", metadata: null } });
  });

  it("a team node pinned to user refuses when no person's credential answers", async () => {
    const { appDb, credentials } = await harness();
    const invoke = invokerFor(appDb, credentials);

    const result = await invoke(node("linear", "user"), teamCtx);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("Share one from Integrations") });
  });

  it("an org-owned node pinned to user refuses: no person to act as", async () => {
    const { appDb, credentials } = await harness();
    const invoke = invokerFor(appDb, credentials);

    const result = await invoke(node("linear", "user"), orgCtx);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('Set credential to "app"') });
  });

  it("auto: a person's credential wins, and the app token answers when none does", async () => {
    const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
    const { appDb, credentials } = await harness();
    const invoke = invokerFor(appDb, credentials);

    expect(await invoke(node("linear"), userCtx)).toEqual(bareApp);
    expect(await invoke(node("linear", "auto"), teamCtx)).toEqual(bareApp);
    expect(await invoke(node("linear"), orgCtx)).toEqual(bareApp);
    // A team run reads once to decide its refusal and once in the action,
    // and each read that ends at the app token counts.
    expect(new Set(record.mock.calls.map(([service, reason]) => `${service}:${reason}`))).toEqual(
      new Set(["linear:no_personal", "linear:no_delegated", "linear:org_owner"]),
    );

    await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "personal-linear" });
    expect(await invoke(node("linear"), userCtx)).toEqual({ ok: true, result: { token: "personal-linear", metadata: null } });
  });

  it("auto: a team run with a broken share falls to the app token and counts dead_delegated", async () => {
    const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "expired", expiresAt: 1 });
    await shareCredential(appDb, { teamId, service: "linear", userId, createdAt: 1 });
    const invoke = invokerFor(appDb, credentials);

    expect(await invoke(node("linear"), teamCtx)).toEqual(bareApp);
    expect(record.mock.calls.length).toBeGreaterThan(0);
    expect(record.mock.calls.every(([service, reason]) => service === "linear" && reason === "dead_delegated")).toBe(true);
  });

  it("a Slack node pinned to app reads the org bot row", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "org", id: orgId }, "slack", { type: "bot_token", accessToken: "xoxb-org" });
    await credentials.save({ type: "user", id: userId }, "slack", { type: "bot_token", accessToken: "xoxb-personal" });
    const invoke = invokerFor(appDb, credentials);

    expect(await invoke(node("slack", "app"), userCtx)).toMatchObject({ ok: true, result: { token: "xoxb-org" } });
  });

  it("INV-P2: a non-native service still refuses an explicit selection", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "org", id: orgId }, "acme-docs", appRow);
    const invoke = invokerFor(appDb, credentials);

    for (const credential of ["app", "user"] as const) {
      const result = await invoke(node("acme-docs", credential), userCtx);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Remove the credential field") });
    }
  });
});
