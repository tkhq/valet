/**
 * Attention router wiring (Phase 4 decision 19 "wired producers"): drives
 * the shared EventStream with synthetic `submission_stuck` and
 * `decision_gate` BusEvents (no real LLM turn needed — the wiring only
 * cares about the event shape and the durable session rows) and asserts
 * the resulting `notifications` rows.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assistantSessionId, type BusEvent, type SessionData } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { wireAttentionRouter } from "./attention-wiring.js";
import { notifications } from "../schema/index.js";

let api: TestApi | undefined;
let unsub: (() => void) | undefined;

afterEach(async () => {
  unsub?.();
  unsub = undefined;
  await api?.cleanup();
  api = undefined;
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: timed out");
}

function baseSession(overrides: Partial<SessionData> & { id: string }): SessionData {
  const now = Date.now();
  return {
    userId: "local-user",
    orgId: "local-org",
    workspace: "/tmp/does-not-matter",
    purpose: "interactive",
    status: "running",
    owner: { type: "user", id: "local-user" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A pending-gate BusEvent on `sessionId`, shaped as the engine emits it. */
function gateEvent(sessionId: string, gateId: string, title: string): BusEvent {
  const now = Date.now();
  return {
    sessionId,
    threadId: "th-1",
    timestamp: now,
    event: {
      type: "decision_gate",
      threadId: "th-1",
      gate: {
        id: gateId,
        sessionId,
        threadId: "th-1",
        queueItemId: "qi-1",
        resumeKey: "resume-1",
        ordinal: 1,
        type: "approval",
        title,
        actions: [{ id: "approve", label: "Approve" }],
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

describe("wireAttentionRouter", () => {
  it("submission_stuck produces an escalation notification for the session's owner", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const sessionId = `sess-${randomUUID()}`;
    await engineStore.saveSession(baseSession({ id: sessionId }));

    const event: BusEvent = {
      sessionId,
      threadId: "th-1",
      queueItemId: "qi-1",
      timestamp: Date.now(),
      event: {
        type: "submission_stuck",
        sessionId,
        threadId: "th-1",
        queueItemId: "qi-1",
        attemptCount: 3,
        ageMs: 900_000,
      },
    };
    await eventStream.append(event, `test-stuck-${randomUUID()}`);

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "escalation"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "escalation"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.sessionId).toBe(sessionId);
    expect(rows[0]?.href).toBe(`/sessions/${encodeURIComponent(sessionId)}`);

    // Re-emitting the same stuck alarm (same queueItemId) must not double-insert.
    await eventStream.append(event, `test-stuck-again-${randomUUID()}`);
    await new Promise((r) => setTimeout(r, 100));
    const rowsAfter = await db.select().from(notifications).where(eq(notifications.kind, "escalation"));
    expect(rowsAfter).toHaveLength(1);
  });

  it("decision_gate on a child session routes an approval to the parent's owner with a child href", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const parentSessionId = `parent-${randomUUID()}`;
    const childSessionId = `child-${randomUUID()}`;
    // Use a user-owner parent so audience resolution needs no membership fixture.
    await engineStore.saveSession(
      baseSession({ id: parentSessionId, owner: { type: "user", id: "local-user" }, purpose: "orchestrator" }),
    );
    await engineStore.saveSession(
      baseSession({
        id: childSessionId,
        owner: { type: "user", id: "local-user" },
        purpose: "child",
        parentSessionId,
        parentThreadId: "th-parent",
      }),
    );

    const gateId = `gate-${randomUUID()}`;
    const event: BusEvent = {
      sessionId: childSessionId,
      threadId: "th-child",
      timestamp: Date.now(),
      event: {
        type: "decision_gate",
        threadId: "th-child",
        gate: {
          id: gateId,
          sessionId: childSessionId,
          threadId: "th-child",
          queueItemId: "qi-child",
          resumeKey: "resume-1",
          ordinal: 1,
          type: "approval",
          title: "Approve deploy?",
          body: "The child wants to deploy.",
          actions: [{ id: "approve", label: "Approve" }],
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    };
    await eventStream.append(event, `test-gate-${randomUUID()}`);

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.title).toBe("Approve deploy?");
    expect(rows[0]?.sessionId).toBe(childSessionId);
    expect(rows[0]?.href).toBe(`/sessions/${encodeURIComponent(childSessionId)}`);
  });

  it("decision_gate on a standalone session routes an approval to that session's own owner", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const sessionId = `sess-${randomUUID()}`;
    await engineStore.saveSession(baseSession({ id: sessionId, purpose: "interactive" }));

    const gateId = `gate-${randomUUID()}`;
    await eventStream.append(
      gateEvent(sessionId, gateId, "Approve something?"),
      `test-gate-standalone-${randomUUID()}`,
    );

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.title).toBe("Approve something?");
    expect(rows[0]?.sessionId).toBe(sessionId);
    expect(rows[0]?.href).toBe(`/sessions/${encodeURIComponent(sessionId)}`);
  });

  it("decision_gate on an assistant session routes an approval to that session's own owner", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    // Assistant ids carry a colon, so this also covers the href encoding.
    const sessionId = assistantSessionId("asst_attention");
    await engineStore.saveSession(baseSession({ id: sessionId, purpose: "orchestrator" }));

    const gateId = `gate-${randomUUID()}`;
    await eventStream.append(
      gateEvent(sessionId, gateId, "Approve the assistant's plan?"),
      `test-gate-orchestrator-${randomUUID()}`,
    );

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.sessionId).toBe(sessionId);
    expect(rows[0]?.href).toBe(`/sessions/${encodeURIComponent(sessionId)}`);
    expect(rows[0]?.href).toContain("%3A");
  });

  it("decision_gate on a child whose parent row is gone falls back to the child's own owner", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const childSessionId = `child-${randomUUID()}`;
    await engineStore.saveSession(
      baseSession({
        id: childSessionId,
        purpose: "child",
        parentSessionId: `parent-${randomUUID()}`,
        parentThreadId: "th-parent",
      }),
    );

    const gateId = `gate-${randomUUID()}`;
    await eventStream.append(
      gateEvent(childSessionId, gateId, "Approve deploy?"),
      `test-gate-orphan-${randomUUID()}`,
    );

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.sessionId).toBe(childSessionId);
  });
});
