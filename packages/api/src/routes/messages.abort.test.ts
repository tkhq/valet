/**
 * `POST /api/sessions/:id/threads/:threadId/abort` (engine-spec route
 * table). Delegates to `Session.abort({ threadId })`, which stamps
 * `abortRequestedAt` durably and lets the claim/reconcile settlement path
 * record the terminal outcome — see `packages/engine/src/session.ts`.
 *
 * Two tiers:
 *   - Unit-level, no key required: a 404 for an unknown thread, a no-op
 *     `{ ok: true }` on an idle thread (nothing queued/running), and that
 *     the route reaches `Thread.abort()` for the right thread by settling a
 *     still-queued submission `aborted` via the durable
 *     `Thread.awaitResult()` read (store-level assertion, no LLM call — the
 *     item never gets claimed because we call abort before yielding to the
 *     event loop that would let the claim loop run).
 *   - Key-gated (`ANTHROPIC_API_KEY`): drives one real turn and races the
 *     abort route against it, asserting the submission still settles
 *     `aborted` end-to-end through a live claim. Timing isn't pinned to a
 *     specific phase (pre-claim vs. mid-stream) — either is a legitimate
 *     exercise of the same settlement path.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, CreateThreadResponse, SendPromptResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

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

describe("POST /threads/:threadId/abort", () => {
  it("404s for an unknown threadId", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads/nope/abort`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
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

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads/${thread.id}/abort`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // Exercises the engine's queued-item abort path: with no ANTHROPIC_API_KEY the
  // host resolver yields no usable key, so the claim loop releases the turn back
  // to `queued` (never burning it `failed` on a keyless model call) and the
  // abort settles the still-queued submission `aborted`. See
  // `Thread.releaseSubmission`/`turnLackedCredentials` in packages/engine.
  it("settles a still-queued submission aborted (store-level, no LLM call)", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await engineSession.ensureDefaultThread();

    // Submit without awaiting the claim loop, then immediately abort. The
    // item is still `queued` at this point (nothing has yielded back to the
    // event loop to let the thread's claim/run cycle start), so this
    // exercises `Thread.abort()`'s settle-unclaimed-items path.
    const receiptPromise = thread.submitPrompt("say hello", {});
    const abortRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads/${thread.id}/abort`, {
      method: "POST",
    });
    expect(abortRes.status).toBe(200);
    expect(await abortRes.json()).toEqual({ ok: true });

    const receipt = await receiptPromise;
    const result = await thread.awaitResult(receipt.queueItemId, { timeoutMs: 10_000 });
    expect(result.outcome).toBe("aborted");
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

    const receiptA = await threadA.submitPrompt("say hello on A", {});

    // Abort thread B — a different, idle thread — should not touch A's
    // still-queued submission.
    const abortRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads/${threadB!.id}/abort`, {
      method: "POST",
    });
    expect(abortRes.status).toBe(200);

    const item = await api.providers.engineStore.getQueueItem(sessionId, receiptA.queueItemId);
    expect(item?.status).not.toBe("settled");

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

      const abortRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads/${thread.id}/abort`, {
        method: "POST",
      });
      expect(abortRes.status).toBe(200);
      expect(await abortRes.json()).toEqual({ ok: true });

      const result = await thread.awaitResult(messageId, { timeoutMs: 30_000 });
      expect(result.outcome).toBe("aborted");
    },
    45_000,
  );
});
