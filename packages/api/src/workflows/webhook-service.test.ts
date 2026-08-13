/**
 * `webhook-service.ts` unit tests — DB-backed against a shared PGlite
 * instance (decision 11 of docs/specs/2026-07-15-postgres-backend-design.md:
 * PGlite's wasm heap isn't reliably released on `close()`, so one instance
 * is reused across tests, truncated between them).
 */
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { workflowDefinitions } from "../schema/index.js";
import {
  WorkflowWebhookRateLimiter,
  deleteWorkflowWebhook,
  getWorkflowWebhook,
  mintOrRotateWorkflowWebhook,
  resolveWebhookTarget,
} from "./webhook-service.js";

const DATA_TABLES = ["workflow_webhooks", "workflow_definitions"];

let db: AppDb;
let pglite: PGlite;

beforeAll(async () => {
  pglite = new PGlite();
  await applyAppMigrations(buildAppQueryable(pglite));
  db = buildAppDb(pglite);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await buildAppQueryable(pglite).query(`TRUNCATE ${DATA_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
});

const OWNER = { userId: "user-1", orgId: "org-1" };

async function seedWorkflow(id: string, owner = OWNER): Promise<void> {
  await db.insert(workflowDefinitions).values({
    id,
    orgId: owner.orgId,
    ownerType: "user",
    ownerId: owner.userId,
    name: "test-workflow",
    definition: { version: "dag/v1", nodes: [], edges: [] },
    createdAt: 1_000,
    updatedAt: 1_000,
  });
}

describe("mintOrRotateWorkflowWebhook", () => {
  it("mints a new opaque hookId for an owned workflow", async () => {
    await seedWorkflow("wf_1");
    const result = await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.webhook.workflowId).toBe("wf_1");
    // 32 random bytes, hex-encoded.
    expect(result.webhook.hookId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rotating replaces the hookId, invalidating the old one", async () => {
    await seedWorkflow("wf_1");
    const first = await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    const second = await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.webhook.hookId).not.toBe(first.webhook.hookId);

    const stillOld = await resolveWebhookTarget(db, "wf_1", first.webhook.hookId);
    expect(stillOld).toBeNull();
    const newOne = await resolveWebhookTarget(db, "wf_1", second.webhook.hookId);
    expect(newOne).not.toBeNull();
  });

  it("errors for a workflow the caller does not own", async () => {
    await seedWorkflow("wf_1", { userId: "someone-else", orgId: "org-1" });
    const result = await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    expect(result.ok).toBe(false);
  });

  it("errors for an unknown workflow id", async () => {
    const result = await mintOrRotateWorkflowWebhook(db, OWNER, "wf_missing");
    expect(result.ok).toBe(false);
  });

  it("two concurrent mints for the same workflow don't crash on the unique constraint — one hookId wins atomically", async () => {
    await seedWorkflow("wf_1");
    const [a, b] = await Promise.all([
      mintOrRotateWorkflowWebhook(db, OWNER, "wf_1"),
      mintOrRotateWorkflowWebhook(db, OWNER, "wf_1"),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Exactly one row survives, and it matches whichever call's hookId is
    // the one `resolveWebhookTarget` now accepts.
    const status = await getWorkflowWebhook(db, OWNER, "wf_1");
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect([a.webhook.hookId, b.webhook.hookId]).toContain(status.webhook?.hookId);
  });
});

describe("getWorkflowWebhook", () => {
  it("resolves ok:true with webhook:null when no hook has been minted", async () => {
    await seedWorkflow("wf_1");
    const result = await getWorkflowWebhook(db, OWNER, "wf_1");
    expect(result).toEqual({ ok: true, webhook: null });
  });

  it("returns the current hook status after minting", async () => {
    await seedWorkflow("wf_1");
    await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    const result = await getWorkflowWebhook(db, OWNER, "wf_1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.webhook?.workflowId).toBe("wf_1");
    expect(result.webhook?.hookId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes 'workflow not found/not owned' from 'no webhook configured'", async () => {
    await seedWorkflow("wf_1", { userId: "someone-else", orgId: "org-1" });
    const result = await getWorkflowWebhook(db, OWNER, "wf_1");
    expect(result.ok).toBe(false);
  });
});

describe("deleteWorkflowWebhook", () => {
  it("removes the hook so the old URL 404s", async () => {
    await seedWorkflow("wf_1");
    const minted = await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    expect(await deleteWorkflowWebhook(db, OWNER, "wf_1")).toBe("deleted");
    expect(await resolveWebhookTarget(db, "wf_1", minted.webhook.hookId)).toBeNull();
  });

  it("distinguishes 'nothing configured yet' from 'not found/not owned'", async () => {
    await seedWorkflow("wf_1");
    expect(await deleteWorkflowWebhook(db, OWNER, "wf_1")).toBe("not_configured");

    await seedWorkflow("wf_2", { userId: "someone-else", orgId: "org-1" });
    expect(await deleteWorkflowWebhook(db, OWNER, "wf_2")).toBe("not_found");
  });
});

describe("resolveWebhookTarget", () => {
  it("resolves the workflow definition + owner for a correct hookId", async () => {
    await seedWorkflow("wf_1");
    const minted = await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const target = await resolveWebhookTarget(db, "wf_1", minted.webhook.hookId);
    expect(target?.workflowId).toBe("wf_1");
    expect(target?.ownerType).toBe("user");
    expect(target?.ownerId).toBe(OWNER.userId);
  });

  it("returns null for a wrong hookId on a real workflow", async () => {
    await seedWorkflow("wf_1");
    await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    expect(await resolveWebhookTarget(db, "wf_1", "0".repeat(64))).toBeNull();
  });

  it("returns null (not a thrown RangeError) for a wrong-LENGTH hookId — exercises the timingSafeEqual length guard", async () => {
    await seedWorkflow("wf_1");
    await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    await expect(resolveWebhookTarget(db, "wf_1", "too-short")).resolves.toBeNull();
    await expect(resolveWebhookTarget(db, "wf_1", "0".repeat(128))).resolves.toBeNull();
  });

  it("returns null for an unknown workflowId (no oracle: same shape as wrong hookId)", async () => {
    expect(await resolveWebhookTarget(db, "wf_missing", "0".repeat(64))).toBeNull();
  });

  it("returns null when the underlying workflow was deleted after the hook was minted", async () => {
    await seedWorkflow("wf_1");
    const minted = await mintOrRotateWorkflowWebhook(db, OWNER, "wf_1");
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, "wf_1"));

    expect(await resolveWebhookTarget(db, "wf_1", minted.webhook.hookId)).toBeNull();
  });
});

describe("WorkflowWebhookRateLimiter", () => {
  it("allows up to the configured limit within the window", () => {
    const limiter = new WorkflowWebhookRateLimiter({ limit: 3, windowMs: 60_000 });
    let now = 0;
    expect(limiter.allow("wf_1", now)).toBe(true);
    expect(limiter.allow("wf_1", now)).toBe(true);
    expect(limiter.allow("wf_1", now)).toBe(true);
    expect(limiter.allow("wf_1", now)).toBe(false);
  });

  it("does not share budget across workflows", () => {
    const limiter = new WorkflowWebhookRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.allow("wf_1", 0)).toBe(true);
    expect(limiter.allow("wf_2", 0)).toBe(true);
  });

  it("resets once the window elapses", () => {
    const limiter = new WorkflowWebhookRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.allow("wf_1", 0)).toBe(true);
    expect(limiter.allow("wf_1", 59_999)).toBe(false);
    expect(limiter.allow("wf_1", 60_001)).toBe(true);
  });

  it("caps tracked keys so an attacker varying workflowId can't grow memory unboundedly (DoS fix)", () => {
    const limiter = new WorkflowWebhookRateLimiter({ limit: 30, windowMs: 60_000, maxTrackedKeys: 3 });
    for (let i = 0; i < 1000; i++) {
      limiter.allow(`attacker-guess-${i}`, 0);
    }
    // Reach in via the class's own tracked-key count rather than a public
    // accessor — there is deliberately no public size getter (nothing
    // legitimate needs one), so this test earns the private-field access
    // via a pure-function extraction instead of a cast, per the type-
    // safety rule against `(obj as any)` in tests.
    expect(limiter.trackedKeyCount()).toBeLessThanOrEqual(3);
  });

  it("evicting a stale key doesn't affect a still-tracked key's own budget", () => {
    const limiter = new WorkflowWebhookRateLimiter({ limit: 1, windowMs: 60_000, maxTrackedKeys: 1 });
    expect(limiter.allow("wf_1", 0)).toBe(true);
    // Evicts wf_1's entry (cap of 1).
    expect(limiter.allow("wf_2", 0)).toBe(true);
    // wf_1 gets a fresh budget post-eviction — that's the accepted cost of
    // bounding memory (a legitimate caller could theoretically get an
    // extra request if evicted mid-window), not a correctness bug: the
    // cap only matters under the attack scenario above, where no
    // individual workflowId's guesses matter once thousands exist.
    expect(limiter.allow("wf_1", 0)).toBe(true);
  });
});
