/**
 * The M5 compaction hook: stamps `compacted_at` on the claiming cell, emits
 * the staleness metric ONLY past the checkpoint stride, and no-ops for
 * sessions no running cell claims. Alert, don't auto-repair — the tests pin
 * that the hook never touches cell status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { codeReviewPresetPlan } from "@valet/plugin-security";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { securityCells, type SecurityCellRow } from "../schema/index.js";
import {
  createSecurityEngagementService,
  STATE_DOC_STALE_MS,
} from "../services/security-engagements.js";
import { recordSecurityCompactionStale } from "../observability/security-metrics.js";
import { securityCompactionHook } from "./security-compaction.js";

// The service (same module graph) also imports the created/settled
// recorders, so the mock must supply all three.
vi.mock("../observability/security-metrics.js", () => ({
  recordSecurityCellsCreated: vi.fn(),
  recordSecurityCellSettled: vi.fn(),
  recordSecurityCompactionStale: vi.fn(),
}));

const SHA = "0123456789abcdef0123456789abcdef01234567";

const DOC = [
  "protocol_version: 1",
  "status: working",
  "checklist:",
  "  pending: 4",
  "  done: 1",
  "queue:",
  "  pending: 2",
  "  done: 0",
  "",
].join("\n");

describe("securityCompactionHook", () => {
  let db: AppDb;
  let clock: number;
  let cell: SecurityCellRow;
  let engagementId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ appDb: db } = await freshTestPgDb());
    clock = 1_000_000;
    const svc = createSecurityEngagementService({ db, now: () => clock });
    const created = await svc.createEngagement({
      sessionId: "s_runner",
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
    });
    engagementId = created.id;
    const { cells } = await svc.startEngagement(engagementId, { resolvedSha: SHA });
    cell = cells[0];
    await svc.dispatchCell(engagementId, {
      cellId: cell.id,
      spawn: async () => ({ childSessionId: "child_hook" }),
    });
    await svc.writeFile(engagementId, {
      actorCellId: cell.id,
      path: `/cells/${cell.dir}/state.yml`,
      content: DOC,
    });
  });

  async function cellRow(): Promise<SecurityCellRow> {
    const rows = await db.select().from(securityCells).where(eq(securityCells.id, cell.id)).limit(1);
    return rows[0];
  }

  it("stamps compactedAt; the staleness metric fires only past the stride", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = securityCompactionHook(db, () => clock);

    // Fresh state doc: stamped, no alert.
    clock += 60_000;
    await hook({ sessionId: "child_hook", threadId: "t1", mode: "proactive", summary: "s" });
    let row = await cellRow();
    expect(row.compactedAt).toBe(clock);
    expect(recordSecurityCompactionStale).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    // Past the stride: stamped again, metric + warning naming the cell.
    clock += STATE_DOC_STALE_MS + 1;
    await hook({ sessionId: "child_hook", threadId: "t1", mode: "reactive", summary: "s" });
    row = await cellRow();
    expect(row.compactedAt).toBe(clock);
    expect(recordSecurityCompactionStale).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain(cell.dir);
    expect(message).toContain(cell.id);
    expect(message).toContain("stale");

    // Alert only: status, attempts, and settlement are untouched.
    expect(row.status).toBe("running");
    expect(row.attempts).toBe(1);
    expect(row.settledAt).toBeNull();
    warn.mockRestore();
  });

  it("no-ops for a session no running cell claims", async () => {
    const hook = securityCompactionHook(db, () => clock);
    clock += STATE_DOC_STALE_MS * 2;
    await expect(
      hook({ sessionId: "s_unclaimed", threadId: "t1", mode: "manual", summary: "s" }),
    ).resolves.toBeUndefined();
    const row = await cellRow();
    expect(row.compactedAt).toBeNull();
    expect(recordSecurityCompactionStale).not.toHaveBeenCalled();
  });
});
