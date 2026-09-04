/**
 * The reasoning pin must reach the provider call, not just the store.
 *
 * This is the persistence round trip's other half: a level that survives a
 * reload but never lands in `StreamOptions.reasoning` buys nothing. The
 * faux provider's response factory sees the exact options the engine hands
 * to pi-ai, so these assertions read the real value.
 */
import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
} from "../src/index.js";

function makeEngine(): Engine {
  return new Engine({
    providers: {
      store: new InMemorySessionStore(),
      stream: new InMemoryEventStream(),
      sandboxProvider: new VirtualSandboxProvider(),
    },
  });
}

/** Wait until `calls` LLM calls have been captured. Counting the captured
 *  calls (rather than watching for an `idle` status) keeps a second turn
 *  from matching the first turn's event, which is still in the array. */
async function waitForCalls(
  seen: Array<SimpleStreamOptions | undefined>,
  calls: number,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (seen.length >= calls) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for ${calls} stream call(s); saw ${seen.length}`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("engine: reasoning reaches the stream call", () => {
  it("sends the thread pin, which outranks the session default", async () => {
    const seen: Array<SimpleStreamOptions | undefined> = [];
    const faux = registerFauxProvider({
      provider: "reason1",
      models: [{ id: "reason-model", reasoning: true }],
    });
    faux.setResponses([
      (_context, options) => {
        seen.push(options);
        return fauxAssistantMessage("ok");
      },
      (_context, options) => {
        seen.push(options);
        return fauxAssistantMessage("ok again");
      },
    ]);

    const session = await makeEngine().createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      sampling: { reasoning: "low" },
    });

    // No thread pin: the session default goes out.
    const first = await session.prompt("one");
    await waitForCalls(seen, 1);
    expect(seen[0]?.reasoning).toBe("low");

    // A thread pin outranks it on the next turn.
    const thread = session.threadById(first.threadId)!;
    await thread.setReasoning("high");
    await session.prompt("two");
    await waitForCalls(seen, 2);
    expect(seen[1]?.reasoning).toBe("high");

    faux.unregister();
  });

  it("clamps the pin to the model instead of rewriting it", async () => {
    const seen: Array<SimpleStreamOptions | undefined> = [];
    const faux = registerFauxProvider({
      provider: "reason2",
      // A reasoning model with no "xhigh"/"max" mapping: pi-ai clamps a
      // "max" request down to "high".
      models: [{ id: "capped-model", reasoning: true }],
    });
    faux.setResponses([
      (_context, options) => {
        seen.push(options);
        return fauxAssistantMessage("ok");
      },
    ]);

    const session = await makeEngine().createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread("web:default");
    await thread.setReasoning("max");

    await session.prompt("one");
    await waitForCalls(seen, 1);
    expect(seen[0]?.reasoning).toBe("high");
    // The pin itself is untouched — it applies in full on a capable model.
    expect(thread.reasoning()).toBe("max");

    faux.unregister();
  });

  it("sends nothing when the model has no reasoning support", async () => {
    const seen: Array<SimpleStreamOptions | undefined> = [];
    const faux = registerFauxProvider({ provider: "reason3", models: [{ id: "plain-model" }] });
    faux.setResponses([
      (_context, options) => {
        seen.push(options);
        return fauxAssistantMessage("ok");
      },
    ]);

    const session = await makeEngine().createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      sampling: { reasoning: "high" },
    });

    await session.prompt("one");
    await waitForCalls(seen, 1);
    expect(seen[0]?.reasoning).toBeUndefined();

    faux.unregister();
  });
});
