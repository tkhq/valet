/**
 * `GET /api/sessions/:id/log` and `GET /api/sessions/:id/files-changed`
 * (V1 port #8 and #4), against the real event stream, the real engine
 * store, and the real blob store.
 *
 * The point of testing these end to end rather than only through their
 * projections is the claim both routes rest on: that V2 already persists
 * what V1 read from a live sandbox. A test that stubbed the store would not
 * check that claim. Nothing here creates a sandbox.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { BusEvent, EngineEvent, QueueItem, WriteFence } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, sessionRepos } from "../schema/index.js";
import type { FilesChangedResponse, SessionLogResponse } from "../wire/types.js";

const USER = "local-user";
const OTHER_USER = "someone-else";

async function seedSession(api: TestApi, id: string, userId = USER): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id,
    userId,
    orgId: "local-org",
    workspace: `/tmp/insights-${id}`,
    status: "active",
    ownerType: "user",
    ownerId: userId,
    createdAt: now,
    updatedAt: now,
  });
}

let eventSeq = 0;

async function appendEvent(api: TestApi, sessionId: string, event: EngineEvent): Promise<void> {
  eventSeq += 1;
  const bus: BusEvent = {
    sessionId,
    ...("threadId" in event && typeof event.threadId === "string" ? { threadId: event.threadId } : {}),
    event,
    timestamp: 1_700_000_000_000 + eventSeq,
  };
  await api.providers.eventStream.append(bus, `ev-${sessionId}-${eventSeq}`);
}

function queueItem(id: string, threadId: string): QueueItem {
  const now = Date.now();
  return {
    id,
    threadId,
    content: { text: "do the thing" },
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Drives one submission through the real lifecycle to `settled`, recording
 * `patchRef` on the way — the same path `Thread.settle` takes, so the row
 * this test reads back is shaped by the production writer, not by the test.
 */
async function settleWithPatch(
  api: TestApi,
  sessionId: string,
  itemId: string,
  patchRef: QueueItem["settlePatch"],
): Promise<void> {
  const store = api.providers.engineStore;
  const threadId = "t-1";
  await store.admitSubmission(sessionId, threadId, queueItem(itemId, threadId));
  const attemptId = `att-${itemId}`;
  await store.claimSubmission({ sessionId, threadId, itemId, attemptId, ownerId: "owner-1" });
  const fence: WriteFence = { itemId, attemptId };
  await store.reserveSettlement(sessionId, threadId, itemId, { outcome: "completed" }, fence);
  await store.finalizeSettlement(sessionId, threadId, itemId, fence, patchRef);
}

const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 keep
-old
+new
+extra
`;

describe("GET /api/sessions/:id/log", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("reads the lifecycle and tool events the engine already persisted", async () => {
    api = await bootTestApi();
    await seedSession(api, "log-1");
    await appendEvent(api, "log-1", { type: "sandbox_status", state: "ready", epoch: 1 });
    await appendEvent(api, "log-1", { type: "thread_start", threadId: "t-1" });
    await appendEvent(api, "log-1", { type: "tool_start", threadId: "t-1", tool: "read", args: { path: "a.ts" } });
    await appendEvent(api, "log-1", { type: "turn_end", threadId: "t-1", reason: "end_turn" });

    const res = await fetch(`${api.baseUrl}/api/sessions/log-1/log`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionLogResponse;
    expect(body.entries.map((e) => e.type)).toEqual([
      "sandbox_status",
      "thread_start",
      "tool_start",
      "turn_end",
    ]);
    expect(body.entries.map((e) => e.kind)).toEqual(["lifecycle", "lifecycle", "tool", "turn"]);
    expect(body.retentionDays).toBe(7);
  });

  it("leaves the streaming plane out of the log", async () => {
    api = await bootTestApi();
    await seedSession(api, "log-2");
    await appendEvent(api, "log-2", { type: "thread_start", threadId: "t-1" });
    for (const text of ["he", "ll", "o"]) {
      await appendEvent(api, "log-2", { type: "text_delta", threadId: "t-1", text });
    }

    const res = await fetch(`${api.baseUrl}/api/sessions/log-2/log`);
    const body = (await res.json()) as SessionLogResponse;
    expect(body.entries.map((e) => e.type)).toEqual(["thread_start"]);
  });

  it("serves the NEWEST page when no cursor is given", async () => {
    api = await bootTestApi();
    await seedSession(api, "log-3");
    for (let i = 0; i < 5; i += 1) {
      await appendEvent(api, "log-3", { type: "thread_start", threadId: `t-${i}` });
    }

    const page = (await (await fetch(`${api.baseUrl}/api/sessions/log-3/log?limit=2`)).json()) as SessionLogResponse;
    expect(page.entries).toHaveLength(2);
    // The last two threads started, not the first two. A panel that polls
    // this endpoint with no cursor must follow the session, not sit on its
    // opening minutes.
    const all = (await (await fetch(`${api.baseUrl}/api/sessions/log-3/log?limit=50`)).json()) as SessionLogResponse;
    expect(all.entries).toHaveLength(5);
    expect(page.entries.map((e) => e.offset)).toEqual(all.entries.slice(-2).map((e) => e.offset));
    expect(page.hasOlder).toBe(true);
    expect(all.hasOlder).toBe(false);
  });

  it("pages forward from an offset without repeating a row", async () => {
    api = await bootTestApi();
    await seedSession(api, "log-3b");
    for (let i = 0; i < 5; i += 1) {
      await appendEvent(api, "log-3b", { type: "thread_start", threadId: `t-${i}` });
    }

    const all = (await (await fetch(`${api.baseUrl}/api/sessions/log-3b/log?limit=50`)).json()) as SessionLogResponse;
    expect(all.entries).toHaveLength(5);

    // Forward paging from the OLDEST row, which is what a follower does.
    const first = (await (
      await fetch(`${api.baseUrl}/api/sessions/log-3b/log?limit=2&fromOffset=${all.entries[0]!.offset}`)
    ).json()) as SessionLogResponse;
    expect(first.entries).toHaveLength(2);

    const second = (await (
      await fetch(`${api.baseUrl}/api/sessions/log-3b/log?limit=2&fromOffset=${first.nextOffset}`)
    ).json()) as SessionLogResponse;
    expect(second.entries).toHaveLength(2);
    // No offset appears in both pages.
    const overlap = second.entries.filter((e) => first.entries.some((f) => f.offset === e.offset));
    expect(overlap).toEqual([]);
    expect(second.hasOlder).toBe(true);
  });

  it("shows the newest events, not the oldest, past the page limit", async () => {
    // The regression this pins: the panel asks for one page with no cursor
    // on a 10-second poll. Reading forward from seq 0 served the OLDEST
    // page, so a session past the limit froze on its first minutes and every
    // poll re-fetched the identical page. A local corpus measured 896 events
    // on four sessions, so crossing the limit is ordinary.
    api = await bootTestApi();
    await seedSession(api, "log-big");
    for (let i = 1; i <= 700; i += 1) {
      await appendEvent(api, "log-big", { type: "tool_start", threadId: "t-1", tool: `tool-${i}`, args: {} });
    }

    const res = await fetch(`${api.baseUrl}/api/sessions/log-big/log?limit=500`);
    const body = (await res.json()) as SessionLogResponse;
    const summaries = body.entries.map((e) => e.summary);

    expect(body.entries).toHaveLength(500);
    expect(summaries).toContain("Tool tool-700");
    expect(summaries).toContain("Tool tool-201");
    expect(summaries).not.toContain("Tool tool-200");
    expect(summaries).not.toContain("Tool tool-1");
    // The reader must be told the page is a window on a longer history,
    // otherwise a capped log reads as a complete one and the retention
    // footnote takes the blame for the gap.
    expect(body.hasOlder).toBe(true);
  });

  it("ignores a limit that is not a positive integer rather than failing", async () => {
    api = await bootTestApi();
    await seedSession(api, "log-4");
    await appendEvent(api, "log-4", { type: "thread_start", threadId: "t-1" });

    for (const bad of ["0", "-3", "abc", ""]) {
      const res = await fetch(`${api.baseUrl}/api/sessions/log-4/log?limit=${bad}`);
      expect(res.status).toBe(200);
    }
  });

  it("returns an empty log for a session that has emitted nothing", async () => {
    api = await bootTestApi();
    await seedSession(api, "log-5");
    const body = (await (await fetch(`${api.baseUrl}/api/sessions/log-5/log`)).json()) as SessionLogResponse;
    expect(body.entries).toEqual([]);
  });

  it("answers 404 for a session the caller may not view", async () => {
    api = await bootTestApi();
    await seedSession(api, "log-6", OTHER_USER);
    const res = await fetch(`${api.baseUrl}/api/sessions/log-6/log`);
    expect(res.status).toBe(404);
  });

  it("answers 404 for a session that does not exist", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/sessions/nope/log`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:id/files-changed", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("lists the files from the diff the engine stored at settle time", async () => {
    api = await bootTestApi();
    await seedSession(api, "fc-1");
    const key = "patches/fc-1/q-1.diff";
    await api.providers.blobs.put(key, new TextEncoder().encode(DIFF), { contentType: "text/x-diff" });
    await settleWithPatch(api, "fc-1", "q-1", { status: "captured", blobKey: key, bytes: DIFF.length });

    const res = await fetch(`${api.baseUrl}/api/sessions/fc-1/files-changed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FilesChangedResponse;
    expect(body.files).toEqual([
      { path: "src/app.ts", additions: 2, deletions: 1, status: "modified", binary: false },
    ]);
    expect(body.additions).toBe(2);
    expect(body.deletions).toBe(1);
    expect(body.unavailable).toBeUndefined();
  });

  it("uses the newest captured patch, because each one is a whole-workspace diff", async () => {
    api = await bootTestApi();
    await seedSession(api, "fc-2");
    const older = "patches/fc-2/q-1.diff";
    const newer = "patches/fc-2/q-2.diff";
    await api.providers.blobs.put(older, new TextEncoder().encode(DIFF));
    await api.providers.blobs.put(
      newer,
      new TextEncoder().encode(`diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-a
+b
`),
    );
    await settleWithPatch(api, "fc-2", "q-1", { status: "captured", blobKey: older, bytes: 1 });
    await settleWithPatch(api, "fc-2", "q-2", { status: "captured", blobKey: newer, bytes: 1 });

    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-2/files-changed`)
    ).json()) as FilesChangedResponse;
    expect(body.files.map((f) => f.path)).toEqual(["README.md"]);
  });

  it("says the session has no repository when the engine skipped for want of a start ref", async () => {
    // This is the common case on an assistant session, and it is the one a
    // silent empty table would misreport as "changed nothing".
    api = await bootTestApi();
    await seedSession(api, "fc-3");
    await settleWithPatch(api, "fc-3", "q-1", { status: "skipped", reason: "no_start_ref" });

    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-3/files-changed`)
    ).json()) as FilesChangedResponse;
    expect(body.files).toEqual([]);
    expect(body.unavailable).toBe("no_repository");
    expect(body.unavailableMessage).toContain("repository");
  });

  it("does not deny the repository when a repo-bound session has no start ref", async () => {
    // The start-ref is captured best-effort inside the clone step and is
    // never retried, so a session WITH a repository can carry
    // `no_start_ref` for its whole life — as can every session created
    // before start-ref capture landed. Telling that reader "this session
    // has no repository" contradicts its own configuration.
    api = await bootTestApi();
    await seedSession(api, "fc-3b");
    await api.providers.db.insert(sessionRepos).values({
      sessionId: "fc-3b",
      host: "github",
      fullName: "acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
      auth: "auto",
      position: 0,
    });
    await settleWithPatch(api, "fc-3b", "q-1", { status: "skipped", reason: "no_start_ref" });

    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-3b/files-changed`)
    ).json()) as FilesChangedResponse;
    expect(body.unavailable).toBe("repository_unreadable");
    expect(body.unavailableMessage).not.toContain("has no repository");
    // Names the corrective action.
    expect(body.unavailableMessage).toContain("Replace the sandbox");
  });

  it("marks the list stale when a later turn settled without capturing", async () => {
    // Turn 1 captured, turn 2 failed. The served list is turn 1's and is
    // right for turn 1, but it is NOT the session's current state. A
    // long-running session is the likeliest to hit this, because its
    // sandbox is the likeliest to go away mid-life.
    api = await bootTestApi();
    await seedSession(api, "fc-stale");
    const key = "patches/fc-stale/q-1.diff";
    await api.providers.blobs.put(key, new TextEncoder().encode(DIFF));
    await settleWithPatch(api, "fc-stale", "q-1", { status: "captured", blobKey: key, bytes: DIFF.length });
    await settleWithPatch(api, "fc-stale", "q-2", { status: "failed", reason: "git_diff failed" });

    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-stale/files-changed`)
    ).json()) as FilesChangedResponse;
    // The list still serves turn 1's files — dropping them would be worse.
    expect(body.files.map((f) => f.path)).toEqual(["src/app.ts"]);
    expect(body.stale).toBe(true);
    expect(body.staleMessage).toContain("Replace the sandbox");
    expect(typeof body.capturedAt).toBe("number");
  });

  it("does not mark the list stale when the newest turn is the captured one", async () => {
    api = await bootTestApi();
    await seedSession(api, "fc-fresh");
    const key = "patches/fc-fresh/q-1.diff";
    await api.providers.blobs.put(key, new TextEncoder().encode(DIFF));
    await settleWithPatch(api, "fc-fresh", "q-1", { status: "captured", blobKey: key, bytes: DIFF.length });

    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-fresh/files-changed`)
    ).json()) as FilesChangedResponse;
    expect(body.stale).toBeUndefined();
    expect(body.staleMessage).toBeUndefined();
    expect(typeof body.capturedAt).toBe("number");
  });

  it("treats a sandbox that was not ready as a list that fills in later", async () => {
    api = await bootTestApi();
    await seedSession(api, "fc-4");
    await settleWithPatch(api, "fc-4", "q-1", { status: "skipped", reason: "sandbox_released" });

    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-4/files-changed`)
    ).json()) as FilesChangedResponse;
    expect(body.unavailable).toBe("no_patches_yet");
  });

  it("reports a capture failure as a failure, not as an empty diff", async () => {
    api = await bootTestApi();
    await seedSession(api, "fc-5");
    await settleWithPatch(api, "fc-5", "q-1", { status: "failed", reason: "git_diff: fatal" });

    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-5/files-changed`)
    ).json()) as FilesChangedResponse;
    expect(body.unavailable).toBe("capture_failed");
  });

  it("reports storage trouble when the queue item names a blob that is gone", async () => {
    api = await bootTestApi();
    await seedSession(api, "fc-6");
    await settleWithPatch(api, "fc-6", "q-1", {
      status: "captured",
      blobKey: "patches/fc-6/missing.diff",
      bytes: 1,
    });

    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-6/files-changed`)
    ).json()) as FilesChangedResponse;
    expect(body.files).toEqual([]);
    expect(body.unavailable).toBe("storage_unavailable");
  });

  it("says the list is not filled in yet for a session with no settled work", async () => {
    api = await bootTestApi();
    await seedSession(api, "fc-7");
    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-7/files-changed`)
    ).json()) as FilesChangedResponse;
    expect(body.unavailable).toBe("no_patches_yet");
  });

  it("carries the truncation flag from the stored record", async () => {
    api = await bootTestApi();
    await seedSession(api, "fc-8");
    const key = "patches/fc-8/q-1.diff";
    await api.providers.blobs.put(key, new TextEncoder().encode(DIFF));
    await settleWithPatch(api, "fc-8", "q-1", {
      status: "captured",
      blobKey: key,
      bytes: DIFF.length,
      truncated: true,
    });

    const body = (await (
      await fetch(`${api.baseUrl}/api/sessions/fc-8/files-changed`)
    ).json()) as FilesChangedResponse;
    expect(body.truncated).toBe(true);
  });

  it("answers 404 for a session the caller may not view", async () => {
    api = await bootTestApi();
    await seedSession(api, "fc-9", OTHER_USER);
    const res = await fetch(`${api.baseUrl}/api/sessions/fc-9/files-changed`);
    expect(res.status).toBe(404);
  });

  it("never creates a sandbox to answer", async () => {
    // Both routes are read models over stored state. A route that woke a
    // sandbox would make opening a panel expensive and would fail for a
    // session whose sandbox is gone.
    let created = 0;
    const refuse = (): never => {
      created += 1;
      throw new Error("the insights routes must not provision a sandbox");
    };
    api = await bootTestApi({
      sandboxProvider: {
        backend: "refusing",
        capabilities: () => ({
          snapshot: "none",
          persistentWorkspace: false,
          tunnels: false,
          warmPool: false,
          hibernation: false,
          customImage: false,
        }),
        create: async () => refuse(),
        restore: async () => refuse(),
        destroy: async () => undefined,
        status: async (id: string) => ({ id, state: "released" as const }),
      },
    });
    await seedSession(api, "fc-10");
    await settleWithPatch(api, "fc-10", "q-1", { status: "skipped", reason: "no_start_ref" });

    expect((await fetch(`${api.baseUrl}/api/sessions/fc-10/files-changed`)).status).toBe(200);
    expect((await fetch(`${api.baseUrl}/api/sessions/fc-10/log`)).status).toBe(200);
    expect(created).toBe(0);
  });
});
