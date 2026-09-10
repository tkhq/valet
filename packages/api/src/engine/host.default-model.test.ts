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
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { users, teams } from "../schema/index.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

describe("EngineHost default model", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("orchestrator session picks up the user's default_model", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;

    await db.update(users).set({ defaultModel: "claude-opus-4-5" }).where(eq(users.id, "local-user"));

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    expect(session.options.model.id).toBe("claude-opus-4-5");
  });

  it("falls back to the tier \"s\" token when no default_model is set", async () => {
    api = await bootTestApi();
    const { engineHost } = api.providers;

    const session = await defaultAssistantSessionFor(api.providers,
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    // Org model preferences are gone; the final fallback is the tier "s"
    // token, which resolves through the default tier map to Anthropic
    // Haiku. No org key is configured, so resolution attaches the model
    // via the no-credentials path, which carries the namespaced id.
    expect(session.options.modelSpec).toBe("s");
    expect(session.options.model.id).toBe("anthropic/claude-haiku-4-5");
  });

  it("child session: explicit modelId wins over the owner's default", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;

    await db.update(users).set({ defaultModel: "claude-opus-4-5" }).where(eq(users.id, "local-user"));

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

  it("child session: no explicit modelId defaults to 's' tier, not the owner's default (TKAI-285)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    api = await bootTestApi();
    const { db, engineHost } = api.providers;

    await db.update(users).set({ defaultModel: "claude-opus-4-5" }).where(eq(users.id, "local-user"));

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

    // The 's' tier resolves to claude-haiku-4-5 via the default tier map.
    expect(child.options.model.id).toBe("claude-haiku-4-5");
    vi.unstubAllEnvs();
  });

  it("restore-no-clobber: an explicit setModel override survives eviction + a changed user default", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    await session.setModel("claude-sonnet-4-5");
    expect(session.options.model.id).toBe("claude-sonnet-4-5");

    engineHost.evictAll();

    await db.update(users).set({ defaultModel: "claude-opus-4-5" }).where(eq(users.id, "local-user"));

    const restored = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    expect(restored.options.model.id).toBe("claude-sonnet-4-5");
  });

  it("resolves fresh thread defaults without the persisted session settings", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const session = await defaultAssistantSessionFor(
      api.providers,
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    await session.setModel("claude-opus-4-5");
    await session.setReasoning("high");
    await db
      .update(users)
      .set({ defaultModel: "m", defaultReasoning: "low" })
      .where(eq(users.id, "local-user"));

    const settings = await engineHost.resolveFreshThreadSettings(session.id, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });

    expect(settings).toEqual({ model: "m", reasoning: "low" });
  });

  it("retries fresh thread creation after persistence fails without exposing an unpersisted thread", async () => {
    api = await bootTestApi();
    const { engineHost, engineStore } = api.providers;
    const session = await defaultAssistantSessionFor(api.providers,
      { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
    const meta = { userId: "local-user", orgId: "local-org", workspace: "/tmp" };
    const save = vi.spyOn(engineStore, "saveThread").mockRejectedValueOnce(new Error("test write failure"));
    await expect(engineHost.ensureFreshThread(session, "slack:retry", meta)).rejects.toThrow("test write failure");
    expect(await session.threadByKey("slack:retry")).toBeNull();
    const thread = await engineHost.ensureFreshThread(session, "slack:retry", meta);
    expect(save).toHaveBeenCalledTimes(2);
    expect(await engineStore.getThread(session.id, thread.id)).toMatchObject({ model: "s", reasoning: "off" });
  });

  it("shares pending thread persistence across concurrent callers", async () => {
    api = await bootTestApi();
    const { engineHost, engineStore } = api.providers;
    const session = await defaultAssistantSessionFor(api.providers,
      { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
    const meta = { userId: "local-user", orgId: "local-org", workspace: "/tmp" };
    let release = () => {};
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const originalSave = engineStore.saveThread.bind(engineStore);
    const save = vi.spyOn(engineStore, "saveThread").mockImplementation(async (...args) => {
      await barrier;
      return originalSave(...args);
    });
    const first = engineHost.ensureFreshThread(session, "slack:concurrent", meta);
    const second = engineHost.ensureFreshThread(session, "slack:concurrent", meta);
    try {
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(await session.threadByKey("slack:concurrent")).toBeNull();
    } finally {
      release();
    }
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps live and restored thread pins when current default resolution fails", async () => {
    api = await bootTestApi();
    const { engineHost } = api.providers;
    const providers = api.providers;
    const wake = () => defaultAssistantSessionFor(providers,
      { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
    const session = await wake();
    await session.setReasoning("high");
    const meta = { userId: "local-user", orgId: "local-org", workspace: "/tmp" };
    const thread = await engineHost.ensureFreshThread(session, "slack:existing", meta);
    await thread.setModel("claude-sonnet-4-5");
    const resolver = vi.spyOn(engineHost, "resolveFreshThreadSettings").mockRejectedValue(new Error("default unavailable"));
    expect(await engineHost.ensureFreshThread(session, "slack:existing", meta)).toBe(thread);
    engineHost.evictAll();
    const restored = await wake();
    const existing = await engineHost.ensureFreshThread(restored, "slack:existing", meta);
    expect(existing.modelId()).toBe("claude-sonnet-4-5");
    expect(existing.toThreadData().reasoning).toBe("off");
    expect(existing.reasoning()).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("uses changed team defaults instead of the delivering member's defaults", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    await db.insert(teams).values({
      id: "model-team", orgId: "local-org", name: "Model team", createdAt: Date.now(),
      defaultModel: "claude-opus-4-5", defaultReasoning: "high",
    });
    const session = await defaultAssistantSessionFor(api.providers,
      { type: "team", id: "model-team" }, { actorUserId: "local-user", orgId: "local-org" });
    await db.update(users).set({ defaultModel: "l", defaultReasoning: "high" }).where(eq(users.id, "local-user"));
    await db.update(teams).set({ defaultModel: "m", defaultReasoning: "low" }).where(eq(teams.id, "model-team"));
    const thread = await engineHost.ensureFreshThread(session, "slack:team", {
      userId: "local-user", orgId: "local-org", workspace: "/tmp",
    });
    expect(thread.modelId()).toBe("m");
    expect(thread.reasoning()).toBe("low");
    expect(session.options.modelSpec).toBe("claude-opus-4-5");
  });

});
