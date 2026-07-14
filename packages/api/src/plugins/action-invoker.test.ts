/**
 * Unit tests for `buildActionInvoker` (plugin-system-v2 plan Task 6) — the
 * headless dispatch primitive behind the workflow `tool` node's
 * `engine.invokeAction` seam. Exercises the invoker directly (fixture
 * `actionPluginByService` map, in-memory sqlite, a fake `CredentialStore`)
 * rather than through `buildWorkflowEngineDeps`/`bootTestApi` — the run
 * context resolution (`resolveRunContext`) those go through is covered
 * separately in `../workflows/engine-deps.test.ts`.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type {
  ActionPlugin,
  CredentialOwner,
  CredentialStore,
  PluginAction,
  StoredCredential,
  ValetPlugin,
} from "@valet/engine";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { buildActionInvoker, type ActionInvocationContext } from "./action-invoker.js";

function makeDb(): AppDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  applyAppMigrations(sqlite);
  return buildAppDb(sqlite);
}

/** Minimal in-memory `CredentialStore` — enough to exercise scoping/missing-credential behavior without pulling in `SqliteCredentialStore`'s encryption machinery. */
class FakeCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, StoredCredential>();

  private key(owner: CredentialOwner, service: string): string {
    return `${owner.type}:${owner.id}:${service}`;
  }

  seed(owner: CredentialOwner, service: string, credential: StoredCredential): void {
    this.rows.set(this.key(owner, service), credential);
  }

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    return this.rows.get(this.key(owner, service)) ?? null;
  }

  async save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    this.rows.set(this.key(owner, service), credential);
  }

  async delete(owner: CredentialOwner, service: string): Promise<void> {
    this.rows.delete(this.key(owner, service));
  }

  async list(): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    return [];
  }
}

const userOwner: ActionInvocationContext = { userId: "u1", orgId: "org1", owner: { type: "user", id: "u1" } };

interface CountingAction {
  action: PluginAction;
  calls: () => number;
  lastArgs: () => Record<string, unknown> | undefined;
}

function countingAction(opts: {
  id?: string;
  execute?: PluginAction["execute"];
} = {}): CountingAction {
  let count = 0;
  let last: Record<string, unknown> | undefined;
  const action: PluginAction = {
    id: opts.id ?? "demo.ping",
    name: "ping",
    description: "ping",
    riskLevel: "low",
    parameters: Type.Object({ msg: Type.String() }),
    execute:
      opts.execute ??
      (async (args, ctx) => {
        count += 1;
        last = args as Record<string, unknown>;
        const credential = await ctx.credentials.get();
        return { success: true, data: { echoed: (args as { msg: string }).msg, hasCredential: credential !== null } };
      }),
  };
  return { action, calls: () => count, lastArgs: () => last };
}

function actionPluginByServiceOf(
  service: string,
  actionPlugin: ActionPlugin,
): Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }> {
  const plugin: ValetPlugin = { name: service, version: "0.0.1", actions: [actionPlugin] };
  return new Map([[service, { plugin, actionPlugin }]]);
}

describe("buildActionInvoker", () => {
  it("happy path: executes the resolved action and returns {ok:true, result}", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });

  it("dedup: a duplicate invocationId returns the ORIGINAL result without re-invoking execute", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" };

    const first = await invoke(req, userOwner);
    const second = await invoke(req, userOwner);

    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(1);
  });

  it("unknown service: returns a stable {ok:false} that dedups without ever resolving an action", async () => {
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "nope", action: "ping", params: {}, invocationId: "workflow:r1:n1" };

    const first = await invoke(req, userOwner);
    const second = await invoke(req, userOwner);

    expect(first).toEqual({ ok: false, error: "unknown action: nope.ping" });
    expect(second).toEqual(first);
  });

  it("unknown action within a known service: stable {ok:false}, dedup applies", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "demo", action: "does_not_exist", params: {}, invocationId: "workflow:r1:n1" };

    const first = await invoke(req, userOwner);
    const second = await invoke(req, userOwner);

    expect(first).toEqual({ ok: false, error: "unknown action: demo.does_not_exist" });
    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(0);
  });

  it("param validation failure: missing required param never reaches execute", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: {}, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result.ok).toBe(false);
    expect(fixture.calls()).toBe(0);
  });

  it("missing credential: the action still executes and sees credentials.get() === null", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
  });

  it("a saved credential is visible to the action via credentials.get()", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", { type: "api_key", apiKey: "secret-token" });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
  });

  it("org owner maps to a CredentialOwner and scopes credential lookups by org", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "demo", { type: "api_key", apiKey: "org-token" });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      { userId: "u1", orgId: "org1", owner: { type: "org", id: "org1" } },
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
  });

  it("team-owned run: unsupported owner type returns a deterministic {ok:false} and never invokes execute", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result.ok).toBe(false);
    expect(fixture.calls()).toBe(0);
  });

  it("execute throw is caught and mapped to {ok:false, error}", async () => {
    const fixture = countingAction({
      execute: async () => {
        throw new Error("boom");
      },
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("PluginActionResult failure maps to {ok:false, error}", async () => {
    const fixture = countingAction({
      execute: async () => ({ success: false, error: "denied by upstream" }),
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: false, error: "denied by upstream" });
  });

  it("dynamic resolveActions is used when the action isn't in the static list", async () => {
    let resolveCalls = 0;
    const dynamicAction = countingAction({ id: "demo.dyn" });
    const actionPlugin: ActionPlugin = {
      service: "demo",
      actions: [],
      resolveActions: async () => {
        resolveCalls += 1;
        return [dynamicAction.action];
      },
    };
    const actionPluginByService = actionPluginByServiceOf("demo", actionPlugin);
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "dyn", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
    expect(dynamicAction.calls()).toBe(1);
    expect(resolveCalls).toBe(1);
  });

  it("concurrent duplicate invocations converge on one stored result", async () => {
    let seen = 0;
    const fixture = countingAction({
      execute: async (args) => {
        seen += 1;
        return { success: true, data: { call: seen, msg: (args as { msg: string }).msg } };
      },
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "demo", action: "ping", params: { msg: "race" }, invocationId: "workflow:r1:n1" };

    const [a, b] = await Promise.all([invoke(req, userOwner), invoke(req, userOwner)]);

    expect(a).toEqual(b);
  });
});
