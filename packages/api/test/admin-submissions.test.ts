/**
 * Admin submissions surface — GET /api/admin/submissions and
 * POST /api/admin/submissions/:sessionId/:itemId/force-settle.
 *
 * Drives a real `createApp` (via bootTestApi). Submissions are seeded
 * directly against `providers.engineStore` (bypassing a real agent turn) so
 * these tests exercise the store contract + route wiring without an
 * Anthropic key.
 */
import { describe, it, expect } from "vitest";
import type { QueueItem } from "@valet/engine";
import { bootTestApi } from "../src/integration/_setup.js";
import type { CreateSessionResponse, WireEvent } from "../src/wire/types.js";
import type { AdminSubmission, ForceSettleResponse, ListAdminSubmissionsResponse } from "../src/wire/types.js";

const ADMIN_HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as CreateSessionResponse;
  return id;
}

/** Force-materializes the engine session + default thread, returning the thread id. */
async function ensureEngineThread(baseUrl: string, sessionId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/threads`);
  expect(res.status).toBe(200);
  const { threads } = (await res.json()) as { threads: { id: string }[] };
  return threads[0].id;
}

function makeItem(id: string, threadId: string, overrides: Partial<QueueItem> = {}): QueueItem {
  const now = Date.now();
  return {
    id,
    threadId,
    content: "hello",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: WireEvent[] = [];
  const listeners = new Set<(f: WireEvent) => void>();
  ws.onmessage = (ev) => {
    const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
    const f = JSON.parse(data) as WireEvent;
    frames.push(f);
    for (const l of listeners) l(f);
  };
  return {
    frames,
    waitFor(pred: (f: WireEvent) => boolean, timeoutMs = 4_000): Promise<WireEvent> {
      return new Promise<WireEvent>((resolve, reject) => {
        for (const f of frames) if (pred(f)) return resolve(f);
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`waitFor timed out; frame types seen: ${JSON.stringify(frames.map((f) => f.type))}`));
        }, timeoutMs);
        const check = (f: WireEvent) => {
          if (pred(f)) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(f);
          }
        };
        listeners.add(check);
      });
    },
    close() {
      ws.close();
    },
  };
}

describe("admin submissions surface", () => {
  it("x-valet-test-user-id header is ignored when VALET_TEST_AUTH_HEADER is unset", async () => {
    const api = await bootTestApi();
    const prevFlag = process.env.VALET_TEST_AUTH_HEADER;
    delete process.env.VALET_TEST_AUTH_HEADER;
    try {
      // With the header ignored, this request falls back to the default
      // local (admin) identity, so an admin-only route should succeed
      // rather than 403 as it would for the impersonated non-admin user.
      const res = await fetch(`${api.baseUrl}/api/admin/submissions`, { headers: MEMBER_HEADERS });
      expect(res.status).toBe(200);
    } finally {
      if (prevFlag === undefined) delete process.env.VALET_TEST_AUTH_HEADER;
      else process.env.VALET_TEST_AUTH_HEADER = prevFlag;
      await api.cleanup();
    }
  });

  it("non-admin user gets 403 on both routes", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await ensureEngineThread(api.baseUrl, sessionId);
      await api.providers.engineStore.admitSubmission(sessionId, threadId, makeItem("q1", threadId));

      const listRes = await fetch(`${api.baseUrl}/api/admin/submissions`, { headers: MEMBER_HEADERS });
      expect(listRes.status).toBe(403);

      const settleRes = await fetch(
        `${api.baseUrl}/api/admin/submissions/${sessionId}/q1/force-settle`,
        { method: "POST", headers: MEMBER_HEADERS, body: JSON.stringify({ outcome: "failed" }) },
      );
      expect(settleRes.status).toBe(403);
    } finally {
      await api.cleanup();
    }
  });

  it("admin lists a wedged (lease-expired) submission with leaseExpired: true", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await ensureEngineThread(api.baseUrl, sessionId);
      const { engineStore } = api.providers;
      await engineStore.admitSubmission(sessionId, threadId, makeItem("q-wedged", threadId));
      await engineStore.claimSubmission({
        sessionId,
        threadId,
        itemId: "q-wedged",
        attemptId: "att-1",
        ownerId: "owner-1",
        leaseDurationMs: -1_000, // already-expired lease
      });

      const res = await fetch(`${api.baseUrl}/api/admin/submissions`, { headers: ADMIN_HEADERS });
      expect(res.status).toBe(200);
      const { submissions } = (await res.json()) as ListAdminSubmissionsResponse;
      const wedged = submissions.find((s) => s.id === "q-wedged");
      expect(wedged).toBeDefined();
      expect(wedged?.sessionId).toBe(sessionId);
      expect(wedged?.status).toBe("running");
      expect(wedged?.leaseExpired).toBe(true);
      expect((wedged as AdminSubmission & { content?: unknown }).content).toBeUndefined();
    } finally {
      await api.cleanup();
    }
  });

  it("force-settle returns 200 + settled item, and a submission.settled frame reaches a connected WS client; repeat force-settle -> 409", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await ensureEngineThread(api.baseUrl, sessionId);
      const { engineStore } = api.providers;
      await engineStore.admitSubmission(sessionId, threadId, makeItem("q-force", threadId));
      await engineStore.claimSubmission({
        sessionId,
        threadId,
        itemId: "q-force",
        attemptId: "att-1",
        ownerId: "owner-1",
      });

      const c = connect(`${api.wsUrl}/api/sessions/${sessionId}/ws?fromOffset=0`);
      await c.waitFor((f) => f.type === "init");

      const res = await fetch(
        `${api.baseUrl}/api/admin/submissions/${sessionId}/q-force/force-settle`,
        {
          method: "POST",
          headers: ADMIN_HEADERS,
          body: JSON.stringify({ outcome: "failed", error: "operator killed it" }),
        },
      );
      expect(res.status).toBe(200);
      const { submission } = (await res.json()) as ForceSettleResponse;
      expect(submission.status).toBe("settled");
      expect(submission.outcome).toBe("failed");
      expect(submission.error).toBe("operator killed it");

      const settledFrame = await c.waitFor((f) => f.type === "submission.settled");
      expect((settledFrame as { queueItemId: string }).queueItemId).toBe("q-force");
      expect((settledFrame as { outcome: string }).outcome).toBe("failed");
      c.close();

      const repeat = await fetch(
        `${api.baseUrl}/api/admin/submissions/${sessionId}/q-force/force-settle`,
        {
          method: "POST",
          headers: ADMIN_HEADERS,
          body: JSON.stringify({ outcome: "aborted" }),
        },
      );
      expect(repeat.status).toBe(409);
      const err = (await repeat.json()) as { error: string; code: string };
      expect(err.code).toBe("conflict");
    } finally {
      await api.cleanup();
    }
  });

  it("force-settle rejects a non-string error field with 400", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const threadId = await ensureEngineThread(api.baseUrl, sessionId);
      await api.providers.engineStore.admitSubmission(sessionId, threadId, makeItem("q-bad", threadId));

      const res = await fetch(
        `${api.baseUrl}/api/admin/submissions/${sessionId}/q-bad/force-settle`,
        {
          method: "POST",
          headers: ADMIN_HEADERS,
          body: JSON.stringify({ outcome: "failed", error: { not: "a string" } }),
        },
      );
      expect(res.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  });

  it("force-settle of a live gate-blocked submission withdraws its pending gate + emits decision_gate_withdrawn", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      // ensureEngineThread materializes the engine session into the host cache
      // (isLive === true), so the force-settle route drives the live-session
      // gate-withdrawal branch.
      const threadId = await ensureEngineThread(api.baseUrl, sessionId);
      const { engineStore } = api.providers;
      await engineStore.admitSubmission(sessionId, threadId, makeItem("q-gate", threadId));
      await engineStore.claimSubmission({
        sessionId,
        threadId,
        itemId: "q-gate",
        attemptId: "att-1",
        ownerId: "owner-1",
      });

      // Seed a PENDING decision gate referencing the claimed submission — the
      // dangling row a live blocked turn would otherwise leave behind.
      const now = Date.now();
      const gateId = `gate:${sessionId}:${threadId}:q-gate:approve:0`;
      const pendingGate = {
        id: gateId,
        sessionId,
        threadId,
        queueItemId: "q-gate",
        resumeKey: "approve",
        ordinal: 0,
        type: "approval" as const,
        title: "Proceed?",
        actions: [{ id: "approve", label: "Approve" }],
        status: "pending" as const,
        expiresAt: now + 72 * 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      };
      await engineStore.saveDecisionGate(sessionId, threadId, pendingGate);
      // Also seed the DAG's `decision_gate` entry — the row that must be
      // re-stamped when the gate is withdrawn, or it stays stuck "pending".
      await engineStore.appendEntries(sessionId, threadId, [
        {
          id: "e-gate",
          sessionId,
          threadId,
          parentId: null,
          type: "decision_gate",
          gate: pendingGate,
          queueItemId: "q-gate",
          createdAt: now,
        },
      ]);

      const c = connect(`${api.wsUrl}/api/sessions/${sessionId}/ws?fromOffset=0`);
      await c.waitFor((f) => f.type === "init");

      const res = await fetch(
        `${api.baseUrl}/api/admin/submissions/${sessionId}/q-gate/force-settle`,
        {
          method: "POST",
          headers: ADMIN_HEADERS,
          body: JSON.stringify({ outcome: "aborted" }),
        },
      );
      expect(res.status).toBe(200);

      const withdrawnFrame = await c.waitFor((f) => f.type === "decision_gate_withdrawn");
      expect((withdrawnFrame as { gateId: string }).gateId).toBe(gateId);
      c.close();

      // The durable gate row is now terminal, not left PENDING for the sweep.
      const gate = await engineStore.getDecisionGate(sessionId, gateId);
      expect(gate?.status).toBe("withdrawn");

      // The DAG's decision_gate entry must be re-stamped too, or the
      // persisted transcript stays stuck on the pre-withdrawal "pending"
      // gate status forever (persistence-shape divergence).
      const entries = await engineStore.getEntries(sessionId, threadId);
      const gateEntry = entries.find(
        (e): e is typeof e & { type: "decision_gate" } => e.type === "decision_gate" && e.id === "e-gate",
      );
      expect(gateEntry?.gate.status).toBe("withdrawn");
      expect(gateEntry?.withdrawnReason).toBe("cancel");
    } finally {
      await api.cleanup();
    }
  });
});
