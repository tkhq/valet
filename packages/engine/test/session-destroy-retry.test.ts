import { describe, it, expect } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
} from "../src/index.js";

describe("Session.destroy retryability", () => {
  it("a failed destroy stays retryable: the second call completes the teardown", async () => {
    const store = new InMemorySessionStore();
    const engine = new Engine({
      providers: {
        store,
        stream: new InMemoryEventStream(),
        sandboxProvider: new VirtualSandboxProvider(),
      },
    });
    const faux = registerFauxProvider({ provider: "destroy-retry" });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const realDelete = store.deleteSession.bind(store);
    let failures = 1;
    store.deleteSession = async (id: string) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("transient store failure");
      }
      await realDelete(id);
    };

    await expect(session.destroy()).rejects.toThrow("transient store failure");

    // Regression pin: a latched `destroyed` flag turned this retry into a
    // silent no-op — the engine row then outlived the delete, and the
    // reconcile sweep's orphan rule (which trusts that row) could never
    // reclaim the sandbox. The delete routes call destroy twice on
    // purpose; the second call must do real work after a failure.
    await session.destroy();
    expect(await store.getSession(session.id)).toBeNull();
  });
});
