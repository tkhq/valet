/**
 * The shared conversation binding lookup (spec 2026-10-16: delivery threads
 * and claims, Terminology and Part B step 1), over real PGlite rows.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { ChannelOrigin } from "@valet/engine";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, assistants, assistantExecutions, sessionThreads, threadPullRequests } from "../schema/index.js";
import { upsertFollowedThread } from "./followed-threads.js";
import { conversationBinding, isConversationalEvent } from "./conversation-binding.js";

const ORG = "org-1";
const OWNER = { type: "user" as const, id: "u-1" };
const ORIGIN: ChannelOrigin = { channelType: "slack", threadKey: "slack:C1:1.1", reply: "auto" };
const URL = "https://github.com/acme/api/pull/14";

let tdb: TestPgDb;

beforeEach(async () => {
  tdb = await freshTestPgDb();
});

/** A live execution session of the owner's assistant, with one thread. */
async function seedThread(sessionId: string, threadId: string) {
  const db = tdb.appDb;
  await db.insert(agentSessions).values({ id: "root", orgId: ORG, userId: "u-1", ownerType: "user", ownerId: "u-1", workspace: "/workspace", createdAt: 1, updatedAt: 1 }).onConflictDoNothing();
  await db.insert(assistants).values({ id: "asst", orgId: ORG, ownerType: "user", ownerId: "u-1", sessionId: "root", createdAt: 1 }).onConflictDoNothing();
  await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
    VALUES ('gov', 'root', 'gov', 'idle', 'steer', 1, 1) ON CONFLICT (id) DO NOTHING`);
  await db.insert(agentSessions).values({ id: sessionId, orgId: ORG, userId: "u-1", ownerType: "user", ownerId: "u-1", workspace: "/workspace", createdAt: 1, updatedAt: 1 });
  await db.insert(assistantExecutions).values({ sessionId, assistantId: "asst", conversationKey: `conv-${sessionId}`, governingThreadId: "gov", createdAt: 1 });
  await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
    VALUES (${threadId}, ${sessionId}, ${threadId}, 'idle', 'steer', 1, 1)`);
}

async function follow(target?: { sessionId: string; threadId: string }) {
  await upsertFollowedThread(tdb.appDb, {
    orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.1",
    ownerType: "user", ownerId: "u-1", createdBy: "u-1", ...(target ? { target } : {}),
  });
}

const reply = { key: "slack.message", payload: { channel: "C1", ts: "1.2", thread_ts: "1.1", text: "hi" } };
const prComment = {
  key: "github.issue_comment.created",
  payload: { issue: { pull_request: { html_url: URL } }, comment: { id: 7, body: "Looks good", user: { login: "ann", type: "User" } } },
};

describe("conversationBinding", () => {
  it("returns the follow's thread for a reply in a followed Slack thread", async () => {
    await seedThread("s-1", "t-1");
    await follow({ sessionId: "s-1", threadId: "t-1" });
    expect(await conversationBinding(tdb.appDb, ORG, OWNER, reply, ORIGIN)).toEqual({ sessionId: "s-1", threadId: "t-1", via: "follow" });
  });

  it("returns no binding for another owner's follow", async () => {
    await seedThread("s-1", "t-1");
    await follow({ sessionId: "s-1", threadId: "t-1" });
    expect(await conversationBinding(tdb.appDb, ORG, { type: "team", id: "sre" }, reply, ORIGIN)).toBeNull();
  });

  it("returns a legacy follow for a row bound before follows stored their thread", async () => {
    await follow();
    expect(await conversationBinding(tdb.appDb, ORG, OWNER, reply, ORIGIN)).toEqual({ via: "legacy_follow", key: "slack:C1:1.1" });
  });

  it("returns no binding when the followed thread is archived", async () => {
    await seedThread("s-1", "t-1");
    await tdb.appDb.insert(sessionThreads).values({ id: "t-1", sessionId: "s-1", createdAt: 1, archivedAt: Date.now() });
    await follow({ sessionId: "s-1", threadId: "t-1" });
    expect(await conversationBinding(tdb.appDb, ORG, OWNER, reply, ORIGIN)).toBeNull();
  });

  it("returns the thread that opened the pull request for a human comment on it", async () => {
    await seedThread("s-1", "t-pr");
    await tdb.appDb.insert(threadPullRequests).values({
      sessionId: "s-1", threadId: "t-pr", url: URL, repo: "acme/api", number: 14, state: "open", createdAt: 1, updatedAt: 1, checkedAt: 1,
    });
    expect(await conversationBinding(tdb.appDb, ORG, OWNER, prComment, null)).toEqual({ sessionId: "s-1", threadId: "t-pr", via: "pull_request" });
    // An org owner has no pull request binding.
    expect(await conversationBinding(tdb.appDb, ORG, { type: "org", id: ORG }, prComment, null)).toBeNull();
  });

  it("returns no binding for an ambient event", async () => {
    expect(await conversationBinding(tdb.appDb, ORG, OWNER, { key: "github.check_run.completed", payload: {} }, null)).toBeNull();
  });
});

describe("isConversationalEvent", () => {
  it("is true for a binding, a mention, or a direct message, and false otherwise", () => {
    const binding = { sessionId: "s", threadId: "t", via: "follow" as const };
    expect(isConversationalEvent(reply, ORIGIN, binding)).toBe(true);
    expect(isConversationalEvent({ key: "slack.app_mention", payload: {} }, ORIGIN, null)).toBe(true);
    expect(isConversationalEvent({ key: "slack.message", payload: { channel_type: "im" } }, ORIGIN, null)).toBe(true);
    expect(isConversationalEvent({ key: "slack.message", payload: { channel_type: "im" } }, null, null)).toBe(false);
    expect(isConversationalEvent(reply, ORIGIN, null)).toBe(false);
  });
});
