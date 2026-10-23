import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemorySessionStore, type SessionStore, type Wakeup } from "@valet/engine";
import { PgSessionStore, applyEngineMigrations, pgDbFromPglite, pgDbFromPool } from "@valet/store-postgres";
import githubPlugin from "@valet/plugin-github/plugin";
import { applyAppMigrations } from "../lib/drizzle.js";
import { WakeWatcher } from "../engine/wake-watcher.js";
import { eventWaiterDeriver } from "./derive.js";
import { toDigest } from "./waiter-match.js";

const KEY = "github.pull_request.checks_completed";
const HEAD = "a".repeat(40);
const SUBJECT = "github:acme/lean-proofs#42";

async function runRace(store: SessionStore): Promise<void> {
  const checkTrigger = githubPlugin.triggers?.find((trigger) => trigger.id === "github.check_run");
  const statusTrigger = githubPlugin.triggers?.find((trigger) => trigger.id === "github.status");
  if (!checkTrigger || !statusTrigger) throw new Error("GitHub check and status triggers are required for this regression.");
  const repository = { full_name: "acme/lean-proofs", owner: { login: "acme" } };
  const check = checkTrigger.toEvent({ eventType: "check_run", deliveryId: "race-check", payload: {
    action: "completed", repository, check_run: { head_sha: HEAD, conclusion: "success", completed_at: "2026-10-21T05:00:00Z", pull_requests: [{ number: 42 }] },
  } });
  let status;
  vi.useFakeTimers();
  try {
    vi.setSystemTime("2026-10-21T05:00:00.500Z");
    status = statusTrigger.toEvent({ eventType: "status", deliveryId: "race-status", payload: { repository, sha: HEAD, state: "success", context: "legacy" } });
  } finally { vi.useRealTimers(); }
  expect(check.occurredAt).toBe("2026-10-21T05:00:00Z");
  expect(status.occurredAt).toBe("2026-10-21T05:00:00.500Z");
  const initial = toDigest(check, KEY);
  const completion = toDigest(status, KEY);
  const now = Date.parse("2026-10-21T05:00:01Z");
  const row: Wakeup = { id: "mixed-precision-race", sessionId: "race-session", threadId: "race-thread", kind: "event", status: "running", reason: "CI", logOffset: 0, logTail: "", eventCount: 0,
    createdAt: now, updatedAt: now, deadlineAt: now + 60_000, subjects: [SUBJECT], eventBuffer: [],
    eventMatch: { clauses: [{ key: KEY }], once: true, self: [], primarySubject: SUBJECT },
  };
  await store.createWakeup(row);
  expect(await store.appendEventMatch(row.id, initial, now)).toBe(true);
  let pending = true;
  const http: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/pulls/42")) return Response.json({ head: { sha: HEAD } });
    if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [{ id: 1, name: "test", app: { id: 1, slug: "github-actions" }, check_suite: { id: 10 }, status: "completed", conclusion: "success" }] });
    if (url.pathname.endsWith("/actions/runs")) return Response.json({ workflow_runs: [] });
    if (url.pathname.endsWith("/status")) {
      if (pending) {
        pending = false;
        // The final status arrives while the earlier check source is in flight.
        expect(await store.appendEventMatch(row.id, completion, now + 1)).toBe(true);
        return Response.json({ statuses: [{ state: "pending" }] });
      }
      return Response.json({ statuses: [{ state: "success" }] });
    }
    throw new Error(`Unexpected GitHub read ${url.pathname}`);
  };
  const prompt = vi.fn(async () => ({}));
  const session = { prompt, threadById: () => ({ id: row.threadId }), attachment: { current: () => null } };
  const watcher = new WakeWatcher({ engineStore: store, engineHost: { sessionFor: async () => session, liveSession: () => null }, loadSession: async () => session,
    provider: { restore: async () => { throw new Error("No sandbox is needed for event delivery."); }, setEvictionProtection: async () => ({ changed: false }), listEvictionProtected: async () => [] },
    limits: { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 }, now: () => now,
    deriveEvent: eventWaiterDeriver({ plugins: [githubPlugin], sessionOrg: async () => "race-org", contextFor: (orgId) => ({ orgId, appToken: async () => "test-token", fetch: http }) }),
  });
  await watcher.sweep(now);
  expect((await store.getWakeup(row.id))?.eventBuffer?.map((digest) => digest.dedupeKey)).toEqual([completion.dedupeKey]);
  await watcher.sweep(now + 1);
  expect(await store.getWakeup(row.id)).toMatchObject({ status: "done", cause: "fired" });
  expect(prompt).toHaveBeenCalledTimes(1);
}

describe("normalizer -> source admission -> real derive -> watcher source race", () => {
  it("retains the final completion in memory", async () => { await runRace(new InMemorySessionStore()); });
  it("retains the final completion in PGlite", async () => {
    const db = pgDbFromPglite(new PGlite());
    try { await applyEngineMigrations(db); await runRace(new PgSessionStore(db)); } finally { await db.close(); }
  });
  it.skipIf(!process.env.TEST_DATABASE_URL)("applies API migrations and retains the final completion on real PostgreSQL", async () => {
    const db = pgDbFromPool(new Pool({ connectionString: process.env.TEST_DATABASE_URL }));
    try {
      await applyAppMigrations(db);
      await db.query("DELETE FROM engine_wakeups WHERE id = 'mixed-precision-race'");
      await runRace(new PgSessionStore(db));
    } finally { await db.close(); }
  });
});
