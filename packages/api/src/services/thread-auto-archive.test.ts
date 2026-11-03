/** The idle thread auto-archive sweep, over real PGlite rows. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, assistants, assistantExecutions, pluginStore, sessionThreads } from "../schema/index.js";
import { HOME_THREAD_KEY } from "../home/context.js";
import { recordThreadUserActivity } from "./thread-activity.js";
import { reopenIdleArchivedThread } from "../events/delivery-thread.js";
import { archiveIdleThreads, DEFAULT_THREAD_ARCHIVE_DAYS, MAX_THREAD_ARCHIVE_DAYS, parseThreadArchiveDays } from "./thread-auto-archive.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const DAYS = DEFAULT_THREAD_ARCHIVE_DAYS;
const OLD = NOW - (DAYS + 1) * DAY;
const RECENT = NOW - DAY;

let tdb: TestPgDb;

beforeEach(async () => {
  tdb = await freshTestPgDb();
  await session("s-1");
});

async function session(id: string, status: "active" | "archived" = "active") {
  await tdb.appDb.insert(agentSessions).values({ id, orgId: "org-1", userId: "u-1", ownerType: "user", ownerId: "u-1", workspace: "/workspace", status, createdAt: 1, updatedAt: 1 });
}

async function thread(id: string, updatedAt: number, opts: { sessionId?: string; key?: string } = {}) {
  await tdb.appDb.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
    VALUES (${id}, ${opts.sessionId ?? "s-1"}, ${opts.key ?? id}, 'active', 'steer', 1, ${updatedAt})`);
}

async function mirror(id: string) {
  const [row] = await tdb.appDb.select().from(sessionThreads).where(eq(sessionThreads.id, id));
  return row;
}

describe("parseThreadArchiveDays", () => {
  it("defaults to 7, accepts 0 to turn it off, and rejects anything else", () => {
    expect(parseThreadArchiveDays({})).toBe(7);
    expect(parseThreadArchiveDays({ VALET_THREAD_ARCHIVE_DAYS: " " })).toBe(7);
    expect(parseThreadArchiveDays({ VALET_THREAD_ARCHIVE_DAYS: "14" })).toBe(14);
    expect(parseThreadArchiveDays({ VALET_THREAD_ARCHIVE_DAYS: "0" })).toBe(0);
    for (const bad of ["-1", "2.5", "seven"]) {
      expect(() => parseThreadArchiveDays({ VALET_THREAD_ARCHIVE_DAYS: bad })).toThrow(/VALET_THREAD_ARCHIVE_DAYS/);
    }
  });

  it("accepts up to 3650 days and refuses a larger value at boot", async () => {
    expect(parseThreadArchiveDays({ VALET_THREAD_ARCHIVE_DAYS: String(MAX_THREAD_ARCHIVE_DAYS) })).toBe(3650);
    for (const bad of ["3651", "107000000000", "99999999999999999999"]) {
      expect(() => parseThreadArchiveDays({ VALET_THREAD_ARCHIVE_DAYS: bad })).toThrow(/from 0 to 3650/);
    }
    // The longest period still runs: its cutoff fits in bigint and the pass archives an older thread.
    await thread("t-ancient", 1);
    expect(await archiveIdleThreads(tdb.appDb, MAX_THREAD_ARCHIVE_DAYS, (MAX_THREAD_ARCHIVE_DAYS + 1) * DAY)).toBe(1);
    await expect(archiveIdleThreads(tdb.appDb, 107_000_000_000)).rejects.toThrow(RangeError);
  });
});

describe("archiveIdleThreads", () => {
  it("archives only threads unused for longer than the period, as the system", async () => {
    await thread("t-old", OLD);
    await thread("t-new", RECENT);

    expect(await archiveIdleThreads(tdb.appDb, DAYS, NOW)).toBe(1);

    expect(await mirror("t-old")).toMatchObject({ archivedAt: NOW, archivedBy: "system", sessionId: "s-1", createdAt: 1 });
    expect(await mirror("t-new")).toBeUndefined();
    // A second pass finds nothing new.
    expect(await archiveIdleThreads(tdb.appDb, DAYS, NOW + DAY)).toBe(0);
  });

  it("counts recent user activity as use even when the newest entry is old", async () => {
    await thread("t-1", OLD);
    await tdb.appDb.insert(sessionThreads).values({ id: "t-1", sessionId: "s-1", createdAt: 1, lastUserActivityAt: RECENT });

    expect(await archiveIdleThreads(tdb.appDb, DAYS, NOW)).toBe(0);
  });

  it("follows the configured period, and 0 turns it off", async () => {
    await thread("t-1", NOW - 3 * DAY);
    expect(await archiveIdleThreads(tdb.appDb, 0, NOW)).toBe(0);
    expect(await archiveIdleThreads(tdb.appDb, DAYS, NOW)).toBe(0);
    expect(await archiveIdleThreads(tdb.appDb, 2, NOW)).toBe(1);
  });

  it("skips a running or queued turn, a pending approval, a live wakeup, and an unfinished child", async () => {
    for (const id of ["t-gate", "t-queue", "t-wake", "t-child", "t-child-delivering"]) await thread(id, OLD);
    await tdb.appDb.execute(sql`INSERT INTO engine_decision_gates
      (id, session_id, thread_id, queue_item_id, resume_key, ordinal, type, status, title, actions, created_at, updated_at)
      VALUES ('g-1', 's-1', 't-gate', 'q-0', 'r', 0, 'approval', 'pending', 'Approve?', '[]', 1, 1)`);
    await tdb.appDb.execute(sql`INSERT INTO engine_queue_items
      (id, session_id, thread_id, status, content, attempt_count, max_attempts, timeout_at, created_at, updated_at)
      VALUES ('q-1', 's-1', 't-queue', 'running', 'hi', 0, 3, 1, 1, 1)`);
    await tdb.appDb.execute(sql`INSERT INTO engine_wakeups (id, session_id, thread_id, kind, status, reason, created_at, updated_at)
      VALUES ('w-1', 's-1', 't-wake', 'timer', 'pending', 'check back', 1, 1)`);
    await tdb.appDb.execute(sql`INSERT INTO child_watches
      (child_session_id, queue_item_id, parent_session_id, parent_thread_id, actor_user_id, org_id, settled, delivery_active, created_at)
      VALUES ('c-1', 'q-c1', 's-1', 't-child', 'u-1', 'org-1', false, false, 1),
             ('c-2', 'q-c2', 's-1', 't-child-delivering', 'u-1', 'org-1', true, true, 1)`);

    expect(await archiveIdleThreads(tdb.appDb, DAYS, NOW)).toBe(0);
  });

  it("skips a pinned thread, the Home thread, governing threads, and archived sessions", async () => {
    await thread("t-pinned", OLD);
    await tdb.appDb.insert(pluginStore).values({ id: "p-1", plugin: "valet", scopeType: "user", scopeId: "u-2", collection: "thread-projects",
      key: JSON.stringify(["org-1", "s-1"]), doc: { value: { projects: [], pinned: ["t-pinned"], assignments: {}, grouped: true, collapsed: false } },
      createdAt: 1, updatedAt: 1 });
    await thread("t-home", OLD, { key: HOME_THREAD_KEY });
    await tdb.appDb.insert(assistants).values({ id: "asst", orgId: "org-1", ownerType: "user", ownerId: "u-1", sessionId: "s-1", createdAt: 1 });
    await thread("t-gov", OLD);
    await session("x-1");
    await tdb.appDb.insert(assistantExecutions).values({ sessionId: "x-1", assistantId: "asst", conversationKey: "c-1", governingThreadId: "t-gov", createdAt: 1 });
    await session("s-gone", "archived");
    await thread("t-gone", OLD, { sessionId: "s-gone" });

    expect(await archiveIdleThreads(tdb.appDb, DAYS, NOW)).toBe(0);
  });

  it("leaves a thread a person archived as it is", async () => {
    await thread("t-manual", OLD);
    await tdb.appDb.insert(sessionThreads).values({ id: "t-manual", sessionId: "s-1", createdAt: 1, archivedAt: 5, archivedBy: "u-1" });

    expect(await archiveIdleThreads(tdb.appDb, DAYS, NOW)).toBe(0);
    expect(await mirror("t-manual")).toMatchObject({ archivedAt: 5, archivedBy: "u-1" });
  });

  it("archives each thread once when two sweeps run at the same time", async () => {
    for (let i = 0; i < 20; i++) await thread(`t-${i}`, OLD);

    const [first, second] = await Promise.all([archiveIdleThreads(tdb.appDb, DAYS, NOW), archiveIdleThreads(tdb.appDb, DAYS, NOW + 1)]);

    expect(first + second).toBe(20);
    const rows = await tdb.appDb.select({ archivedAt: sessionThreads.archivedAt }).from(sessionThreads);
    expect(rows).toHaveLength(20);
    // Every row carries the time of the one pass that archived it.
    expect(new Set(rows.map((row) => row.archivedAt)).size).toBe(1);
  });
});

describe("unarchive on new activity", () => {
  it("a new message unarchives a thread, however it was archived", async () => {
    await thread("t-auto", OLD);
    await thread("t-manual", OLD);
    await tdb.appDb.insert(sessionThreads).values({ id: "t-manual", sessionId: "s-1", createdAt: 1, archivedAt: 5, archivedBy: "u-1" });
    await archiveIdleThreads(tdb.appDb, DAYS, NOW);

    const emit = vi.fn(async () => undefined);
    for (const id of ["t-auto", "t-manual"]) {
      await recordThreadUserActivity(tdb.appDb, { sessionId: "s-1", threadId: id, threadCreatedAt: 1, activityAt: NOW + 1, emit });
      expect(await mirror(id)).toMatchObject({ archivedAt: null, archivedBy: null, lastUserActivityAt: NOW + 1 });
    }
  });

  it("a delivery reopens a thread the sweep archived, but not one a person archived", async () => {
    await thread("t-auto", OLD);
    await thread("t-manual", OLD);
    await tdb.appDb.insert(sessionThreads).values({ id: "t-manual", sessionId: "s-1", createdAt: 1, archivedAt: 5, archivedBy: "u-1" });
    await archiveIdleThreads(tdb.appDb, DAYS, NOW);

    expect(await reopenIdleArchivedThread(tdb.appDb, "s-1", "t-auto")).toBe(1);
    expect(await reopenIdleArchivedThread(tdb.appDb, "s-1", "t-manual")).toBe(0);
    expect(await mirror("t-auto")).toMatchObject({ archivedAt: null, archivedBy: null });
    expect(await mirror("t-manual")).toMatchObject({ archivedAt: 5 });
  });
});
