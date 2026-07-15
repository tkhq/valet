/**
 * split-settings design decision 9 / Task 4: `users.default_model` feeds
 * `EngineHost`'s session builders through the `resolveModel()` seam that
 * used to be hardcoded to `claude-haiku-4-5`.
 *
 * Restore-no-clobber (spec-pinned): `Session.rehydrate`
 * (`packages/engine/src/session.ts`) takes `options.model` verbatim from
 * whatever the caller (the host) passes — it never reconciles that against
 * the persisted `SessionData.model` on its own. So on restore the host must
 * prefer the *persisted* model over a freshly-read user default, or an
 * explicit `session.setModel(...)` override would get silently reverted the
 * next time the session's cache entry is evicted and rebuilt.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { users } from "../schema/index.js";

describe("EngineHost default model", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("orchestrator session picks up the user's default_model", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;

    await db.update(users).set({ defaultModel: "claude-opus-4-1" }).where(eq(users.id, "local-user"));

    const session = await engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    expect(session.options.model.id).toBe("claude-opus-4-1");
  });

  it("falls back to claude-haiku-4-5 when no default_model is set", async () => {
    api = await bootTestApi();
    const { engineHost } = api.providers;

    const session = await engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    expect(session.options.model.id).toBe("claude-haiku-4-5");
  });

  it("child session: explicit modelId wins over the owner's default", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;

    await db.update(users).set({ defaultModel: "claude-opus-4-1" }).where(eq(users.id, "local-user"));

    const parent = await engineHost.sessionFor("parent-default-model", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");

    const child = await engineHost.childSessionFor("child-explicit-model", {
      parentSessionId: "parent-default-model",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
      modelId: "claude-sonnet-4-5",
    });

    expect(child.options.model.id).toBe("claude-sonnet-4-5");
  });

  it("child session: no explicit modelId falls back to the owner's default", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;

    await db.update(users).set({ defaultModel: "claude-opus-4-1" }).where(eq(users.id, "local-user"));

    const parent = await engineHost.sessionFor("parent-default-model-2", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");

    const child = await engineHost.childSessionFor("child-default-model", {
      parentSessionId: "parent-default-model-2",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });

    expect(child.options.model.id).toBe("claude-opus-4-1");
  });

  it("restore-no-clobber: an explicit setModel override survives eviction + a changed user default", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;

    const session = await engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    await session.setModel("claude-sonnet-4-5");
    expect(session.options.model.id).toBe("claude-sonnet-4-5");

    engineHost.evictAll();

    await db.update(users).set({ defaultModel: "claude-opus-4-1" }).where(eq(users.id, "local-user"));

    const restored = await engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    expect(restored.options.model.id).toBe("claude-sonnet-4-5");
  });
});
