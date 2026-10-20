import { describe, expect, it } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type ThreadData } from "../src/index.js";

/** Holds the first save that carries a tool focus until the test releases it. */
class GatedStore extends InMemorySessionStore {
  private release: (() => void) | undefined;
  held: Promise<void> | undefined;
  private reached: (() => void) | undefined;
  readonly focusSaveReached = new Promise<void>((resolve) => { this.reached = resolve; });

  override async saveThread(sessionId: string, thread: ThreadData): Promise<void> {
    if (!this.held && thread.metadata?.toolScope !== undefined) {
      this.held = new Promise<void>((resolve) => { this.release = resolve; });
      this.reached?.();
      await this.held;
    }
    return super.saveThread(sessionId, thread);
  }

  open(): void { this.release?.(); }
}

describe("thread metadata writes", () => {
  it("keeps a recorded Slack channel when a tool focus write interleaves", async () => {
    const faux = registerFauxProvider({ provider: "metadata-interleave" });
    try {
      const store = new GatedStore();
      const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: "user", id: "alice" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [] });
      const thread = await session.createThread("delivery");

      const focus = thread.setToolFocus({ actions: ["slack.search"] });
      await store.focusSaveReached;
      const record = thread.addToMetadataList("slackChannels", "T1/CPRIV");
      store.open();
      await Promise.all([focus, record]);

      expect(thread.toThreadData().metadata?.slackChannels).toEqual(["T1/CPRIV"]);
      expect(thread.toThreadData().metadata?.toolScope).toEqual({ actions: ["slack.search"] });
      const saved = await store.getThread(session.id, thread.id);
      expect(saved?.metadata?.slackChannels).toEqual(["T1/CPRIV"]);
      expect(saved?.metadata?.toolScope).toEqual({ actions: ["slack.search"] });

      // A later write must not drop the channel either.
      await thread.setToolFocus(undefined);
      expect((await store.getThread(session.id, thread.id))?.metadata?.slackChannels).toEqual(["T1/CPRIV"]);
    } finally { faux.unregister(); }
  });

  it("sets a metadata flag through the patch path without dropping other values", async () => {
    const faux = registerFauxProvider({ provider: "metadata-flag" });
    try {
      const store = new InMemorySessionStore();
      const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: "user", id: "alice" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [] });
      const thread = await session.createThread("sub:rule-1:delivery-1");
      await Promise.all([thread.addToMetadataList("slackChannels", "T1/C1"), thread.setMetadataFlag("conversational")]);
      await thread.setMetadataFlag("conversational");
      expect((await store.getThread(session.id, thread.id))?.metadata).toMatchObject({ slackChannels: ["T1/C1"], conversational: true });
    } finally { faux.unregister(); }
  });
});
