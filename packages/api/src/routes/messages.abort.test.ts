/**
 * `POST /api/sessions/:id/threads/:threadId/abort` (engine-spec route
 * table). Delegates to `Thread.interrupt()`, which aborts only the active
 * submission and preserves queued submissions.
 *
 * Two tiers:
 *   - Unit-level, no key required: a 404 for an unknown thread, a no-op
 *     `{ ok: true }` on an idle thread, and preservation of a queued item
 *     when no turn is active.
 *   - Key-gated (`ANTHROPIC_API_KEY`): drives one real turn and races the
 *     abort route against it after the item is running, asserting the
 *     submission settles `aborted` end-to-end through a live claim.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, CreateThreadResponse, SendPromptResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as CreateSessionResponse;
  return id;
}

function abortTurn(baseUrl: string, sessionId: string, threadId: string, targetItemId: string) {
  return fetch(`${baseUrl}/api/sessions/${sessionId}/threads/${threadId}/abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetItemId }),
  });
}

describe("POST /threads/:threadId/abort", () => {
  it("404s for an unknown threadId", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const res = await abortTurn(api.baseUrl, sessionId, "nope", "item-1");
    expect(res.status).toBe(404);
  });

  it("requires the queue item captured by the Stop gesture", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await engineSession.ensureDefaultThread();

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads/${thread.id}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "targetItemId is required. Send the active queue item as targetItemId." });
  });

  it("is a no-op on an idle thread", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await engineSession.ensureDefaultThread();

    const res = await abortTurn(api.baseUrl, sessionId, thread.id, "item-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("preserves a queued submission when no submission is running", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await engineSession.ensureDefaultThread();
    await thread.pause();
    const receipt = await thread.submitPrompt("say hello", {});

    const abortRes = await abortTurn(api.baseUrl, sessionId, thread.id, receipt.queueItemId);
    expect(abortRes.status).toBe(200);
    expect(await abortRes.json()).toEqual({ ok: true });

    const item = await api.providers.engineStore.getQueueItem(sessionId, receipt.queueItemId);
    expect(item?.status).toBe("queued");
    expect(item?.abortRequestedAt).toBeUndefined();
    await thread.abort();
  });

  // Aborting an idle sibling thread must not touch this thread's queued (again,
  // released-to-queued for want of credentials) submission — see above.
  it("does not abort a different thread's queued submission", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const threadA = await engineSession.ensureDefaultThread();

    const createThreadRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(createThreadRes.status).toBe(201);
    const threadBSummary = (await createThreadRes.json()) as CreateThreadResponse;
    const threadB = engineSession.threadById(threadBSummary.id);
    expect(threadB).not.toBeNull();

    // Pause A first: without this, the session's 5s sweep can drive A's
    // keyless item through its bounded credential-release cycles DURING the
    // abort HTTP round-trip and settle it `failed` before the read below —
    // a racy false negative. Paused, A's item durably stays `queued`, which
    // keeps the strong not-settled assertion sound.
    await threadA.pause();
    const receiptA = await threadA.submitPrompt("say hello on A", {});

    // Abort thread B — a different, idle thread — should not touch A's
    // still-queued submission.
    const abortRes = await abortTurn(api.baseUrl, sessionId, threadB!.id, receiptA.queueItemId);
    expect(abortRes.status).toBe(200);

    const item = await api.providers.engineStore.getQueueItem(sessionId, receiptA.queueItemId);
    expect(item?.status).not.toBe("settled");
    // The cross-thread pin proper: B's abort must not even STAMP A's item
    // (a stamped-but-unsettled item would still abort on its next cycle).
    expect(item?.abortRequestedAt).toBeUndefined();

    // Clean up: abort A directly so the test doesn't leave a dangling
    // claim loop racing the store teardown.
    await threadA.abort();
  });
});

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfKey("POST /threads/:threadId/abort (real turn)", () => {
  it(
    "settles a live turn aborted when raced against a real prompt",
    async () => {
      api = await bootTestApi();
      const sessionId = await createSession(api.baseUrl);

      const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp",
      });
      const thread = await engineSession.ensureDefaultThread();

      const promptRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Count slowly from 1 to 200, one number per line.",
          threadId: thread.id,
        }),
      });
      expect(promptRes.status).toBe(202);
      const { messageId } = (await promptRes.json()) as SendPromptResponse;
      // A plain prompt always queues; null is the slash-command shape.
      if (messageId === null) throw new Error("prompt unexpectedly ran as a command");
      await waitFor(async () =>
        (await api!.providers.engineStore.getQueueItem(sessionId, messageId))?.status === "running"
      );

      const abortRes = await abortTurn(api.baseUrl, sessionId, thread.id, messageId);
      expect(abortRes.status).toBe(200);
      expect(await abortRes.json()).toEqual({ ok: true });

      const result = await thread.awaitResult(messageId, { timeoutMs: 30_000 });
      expect(result.outcome).toBe("aborted");
    },
    45_000,
  );
});
