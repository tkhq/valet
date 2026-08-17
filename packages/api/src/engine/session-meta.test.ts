/**
 * Unit coverage for `loadSessionMeta` — specifically the spec-decision-15
 * `target_dir` persistence and legacy fallback rules (sandbox-reconciliation
 * plan, Task 14).
 *
 * Two branches:
 *   1. Row with `target_dir` set → used verbatim.
 *   2. Row with `target_dir` NULL (legacy session predating decision 15):
 *        single repo → "." (old workspace-root layout, never relocated).
 *        multi repo  → old computeTargetDirs layout (plain repo name subdirs,
 *                       with collision disambiguation).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, sessionRepos } from "../schema/index.js";
import { loadSessionMeta } from "./session-meta.js";
import type { SessionMetaSource } from "./session-meta.js";

const ORG = "test-org";
const USER = "test-user";
const NOW = Date.now();

async function insertSession(db: AppDb, id: string): Promise<void> {
  await db.insert(agentSessions).values({
    id,
    userId: USER,
    orgId: ORG,
    workspace: `/tmp/${id}`,
    status: "active",
    ownerType: "user",
    ownerId: USER,
    profile: "headless",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function insertRepo(
  db: AppDb,
  sessionId: string,
  opts: {
    fullName: string;
    position?: number;
    targetDir?: string | null;
  },
): Promise<void> {
  await db.insert(sessionRepos).values({
    sessionId,
    host: "github",
    fullName: opts.fullName,
    cloneUrl: `https://github.com/${opts.fullName}.git`,
    ref: null,
    auth: "auto",
    position: opts.position ?? 0,
    targetDir: opts.targetDir ?? null,
  });
}

function src(id: string): SessionMetaSource {
  return { id, userId: USER, orgId: ORG, workspace: `/tmp/${id}` };
}

describe("loadSessionMeta: target_dir persistence (spec decision 15)", () => {
  let harness: TestPgDb;
  let db: AppDb;

  beforeEach(async () => {
    harness = await freshTestPgDb();
    db = harness.appDb;
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it("row with target_dir set → used verbatim", async () => {
    await insertSession(db, "s1");
    await insertRepo(db, "s1", { fullName: "acme/widgets", targetDir: "widgets" });

    const meta = await loadSessionMeta(db, src("s1"));
    expect(meta.repos).toHaveLength(1);
    expect(meta.repos![0]?.targetDir).toBe("widgets");
    expect(meta.repos![0]?.fullName).toBe("acme/widgets");
  });

  it("legacy NULL row, single repo → '.' (sessions predating decision 15 keep root layout)", async () => {
    await insertSession(db, "s2");
    await insertRepo(db, "s2", { fullName: "acme/widgets", targetDir: null });

    const meta = await loadSessionMeta(db, src("s2"));
    expect(meta.repos).toHaveLength(1);
    expect(meta.repos![0]?.targetDir).toBe(".");
  });

  it("legacy NULL row, multi repo, non-colliding → plain repo name subdirs", async () => {
    await insertSession(db, "s3");
    await insertRepo(db, "s3", { fullName: "acme/widgets", position: 0, targetDir: null });
    await insertRepo(db, "s3", { fullName: "acme/gadgets", position: 1, targetDir: null });

    const meta = await loadSessionMeta(db, src("s3"));
    expect(meta.repos).toHaveLength(2);
    expect(meta.repos![0]?.targetDir).toBe("widgets");
    expect(meta.repos![1]?.targetDir).toBe("gadgets");
  });

  it("legacy NULL row, multi repo, colliding names → disambiguation", async () => {
    await insertSession(db, "s4");
    await insertRepo(db, "s4", { fullName: "acme/widgets", position: 0, targetDir: null });
    await insertRepo(db, "s4", { fullName: "beta/widgets", position: 1, targetDir: null });

    const meta = await loadSessionMeta(db, src("s4"));
    expect(meta.repos).toHaveLength(2);
    expect(meta.repos![0]?.targetDir).toBe("acme__widgets");
    expect(meta.repos![1]?.targetDir).toBe("beta__widgets");
  });

  it("no repos → repos is undefined", async () => {
    await insertSession(db, "s5");
    const meta = await loadSessionMeta(db, src("s5"));
    expect(meta.repos).toBeUndefined();
  });

  it("mixed rows (some with target_dir, some null) → uses legacy fallback for all", async () => {
    // If ANY row has a null target_dir, treat the whole set as legacy.
    await insertSession(db, "s6");
    await insertRepo(db, "s6", { fullName: "acme/widgets", position: 0, targetDir: "widgets" });
    await insertRepo(db, "s6", { fullName: "acme/gadgets", position: 1, targetDir: null });

    const meta = await loadSessionMeta(db, src("s6"));
    // Legacy fallback: multi → plain repo name subdirs.
    expect(meta.repos).toHaveLength(2);
    expect(meta.repos![0]?.targetDir).toBe("widgets");
    expect(meta.repos![1]?.targetDir).toBe("gadgets");
  });
});
