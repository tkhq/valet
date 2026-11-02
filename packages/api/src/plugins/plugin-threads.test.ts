import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  Engine,
  InMemoryBlobStore,
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type ChildSpawner,
  type ValetPlugin,
} from "@valet/engine";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { childWatches } from "../schema/index.js";
import { awaitPluginChild, buildPluginThreads, pluginChildSessionId, pluginThreadKey, type PluginThreadsDeps } from "./plugin-threads.js";

const reviewer: ValetPlugin = {
  name: "reviewer",
  version: "0.0.1",
  roles: [{ name: "verifier", content: "Check one claim against the code." }],
};

const owner = { type: "team" as const, id: "team-1" };
const thread = { sessionId: "sess-parent", threadId: "thr-parent", key: pluginThreadKey("reviewer", "acme/site#7") };

describe("pluginChildSessionId", () => {
  it("is fixed per plugin, thread and dispatch", () => {
    const a = pluginChildSessionId("reviewer", thread.key, "verify:abc:0");
    expect(a).toMatch(/^child_plg_[0-9a-f]{32}$/);
    expect(pluginChildSessionId("reviewer", thread.key, "verify:abc:0")).toBe(a);
    expect(pluginChildSessionId("reviewer", thread.key, "verify:abc:1")).not.toBe(a);
    expect(pluginChildSessionId("other", thread.key, "verify:abc:0")).not.toBe(a);
  });
});

describe("PluginThreads.spawnChild", () => {
  async function setup() {
    const tdb = await freshTestPgDb();
    const spawner = vi.fn<ChildSpawner>(async (req) => ({ childSessionId: req.sessionId ?? "x", queueItemId: "q-1" }));
    // Only the db and the spawner are used by spawnChild.
    const deps: PluginThreadsDeps = {
      db: tdb.appDb,
      engineHost: undefined as never,
      engineStore: new InMemorySessionStore(),
      childSpawner: spawner,
    };
    const threads = buildPluginThreads(deps, { plugin: reviewer, orgId: "org-1", owner, actorUserId: "user-1" });
    return { tdb, spawner, threads };
  }

  it("spawns a silent, unattended child with the plugin's role and repo at a ref", async () => {
    const { spawner, threads } = await setup();
    const child = await threads.spawnChild(
      thread,
      { prompt: "check it", role: "verifier", repo: "acme/site", ref: "abc123" },
      { dispatchId: "verify:abc:0" },
    );
    expect(child.childSessionId).toBe(pluginChildSessionId("reviewer", thread.key, "verify:abc:0"));
    const [req, ctx] = spawner.mock.calls[0];
    expect(req).toMatchObject({ prompt: "check it", role: "verifier", repo: "acme/site", branch: "abc123", sessionId: child.childSessionId });
    expect(ctx).toMatchObject({ parentSessionId: "sess-parent", parentThreadId: "thr-parent", owner, unattendedWorkflow: true, reportToParent: false });
  });

  it("returns the existing child on a retry of the same dispatch", async () => {
    const { tdb, spawner, threads } = await setup();
    const childSessionId = pluginChildSessionId("reviewer", thread.key, "verify:abc:0");
    await tdb.appDb.insert(childWatches).values({
      childSessionId,
      queueItemId: "q-first",
      parentSessionId: thread.sessionId,
      parentThreadId: thread.threadId,
      actorUserId: "user-1",
      orgId: "org-1",
      createdAt: Date.now(),
      reportToParent: false,
    });
    const child = await threads.spawnChild(thread, { prompt: "check it" }, { dispatchId: "verify:abc:0" });
    expect(child).toEqual({ childSessionId, queueItemId: "q-first" });
    expect(spawner).not.toHaveBeenCalled();
  });

  it("refuses an undeclared role, a ref without a repo, and another plugin's thread", async () => {
    const { threads } = await setup();
    await expect(threads.spawnChild(thread, { prompt: "p", role: "admin" }, { dispatchId: "d" })).rejects.toThrow("Role admin is not declared");
    await expect(threads.spawnChild(thread, { prompt: "p", ref: "main" }, { dispatchId: "d" })).rejects.toThrow("needs a repo");
    const foreign = { ...thread, key: pluginThreadKey("other", "k") };
    await expect(threads.spawnChild(foreign, { prompt: "p" }, { dispatchId: "d" })).rejects.toThrow("does not belong to plugin reviewer");
  });
});

describe("awaitPluginChild", () => {
  it("reads a settled child's final message and validates it against the result schema", async () => {
    const faux = registerFauxProvider({ provider: "plugin-threads-test" });
    faux.setResponses([fauxAssistantMessage('Done.\n```json\n{"verdict": "confirmed", "line": 12}\n```')]);
    const store = new InMemorySessionStore();
    const engine = new Engine({
      providers: {
        store,
        stream: new InMemoryEventStream(),
        blobs: new InMemoryBlobStore(),
        credentials: new InMemoryCredentialStore(),
        sandboxProvider: new VirtualSandboxProvider(),
      },
    });
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
    const receipt = await session.prompt("verify the claim");
    await session.thread().awaitResult(receipt.queueItemId);

    const schema = Type.Object({ verdict: Type.String(), line: Type.Integer() });
    const result = await awaitPluginChild({ engineStore: store, pollMs: 5 }, { childSessionId: session.id, queueItemId: receipt.queueItemId }, { resultSchema: schema });
    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ verdict: "confirmed", line: 12 });

    const bad = await awaitPluginChild({ engineStore: store, pollMs: 5 }, { childSessionId: session.id, queueItemId: receipt.queueItemId },
      { resultSchema: Type.Object({ missing: Type.String() }) });
    expect(bad.output).toBeUndefined();
    expect(bad.error).toContain("did not match schema");
    await session.destroy();
    faux.unregister();
  });
});
