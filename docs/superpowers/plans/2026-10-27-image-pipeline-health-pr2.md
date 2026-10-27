# Image Pipeline Health, PR 2 (contract and source health) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions bound to an incompatible repo image fall back to a compatible image and keep working, the scheduler rebakes such images on its own, and every image source carries a persisted health state that says why it is not healthy.

**Architecture:** An integer image runtime contract is stamped on every bake row from the OCI label the image carries (read from the registry after push) and backfilled by lineage for existing rows. `compatible(bake)` is one pure predicate used by the scheduler's skip rule, the parent-readiness check, and the two session-start resolvers (`resolvePrebuildImage`, `resolveBaseImage`). When the repo bake is incompatible the resolver returns null (so `computeSpec` degrades to base, then stock, and prep skips setup commands), fires a callback that records `agent_sessions.image_fallback`, marks the source `incompatible`, counts the fallback, and requests a bake through the existing first-bake guards; the system prompt tells the agent. `image_sources` gains four health columns written at every scheduler exit, in the scheduler's catch, on push and fail, and on fallback.

**Tech Stack:** TypeScript, drizzle-orm (PGlite in tests), Hono GitHub fixture, Docker Registry HTTP API v2 (`fetch`), OpenTelemetry metrics API, vitest.

**Spec:** `docs/plans/2026-10-26-image-pipeline-health-design.md`, section 14 item 2, drawing on sections 4 (D1, D2, D3, D7), 5, 6, 7, 12, 13, 15. PR 1 (tkhq/valet #1071, branch `conner/image-pipeline-health-pr1`) is the base: it shipped the Dockerfile label, `SandboxStartupKind`, the blobs fallback, and the provisioning hardening.

## Global Constraints

- Branch `conner/image-pipeline-health-pr2` off `conner/image-pipeline-health-pr1` (stacked; retarget the PR to `dev-v2` after #1071 merges). Every commit signed (`git commit -S`); every `feat`/`fix`/`perf` commit carries a final-paragraph trailer `Changelog: <user impact>` (or `Changelog: internal`), per `scripts/ci/changelog_commit_guard.mjs`. `build`/`test`/`docs`/`chore` commits are exempt.
- Tests run as `pnpm --filter <pkg> test <file>` with NO `--` before the file (vitest drops args after `--`). Package names: `@valet/api`, `@valet/engine`, `@valet/sandbox-kubernetes`. A fresh worktree needs `pnpm install` and `pnpm typecheck` once; `@valet/sandbox-kubernetes typecheck` reads `@valet/engine`'s built `dist/`, so run `pnpm --filter @valet/engine build` after any engine source change.
- `SANDBOX_IMAGE_CONTRACT = 3` and `MIN_IMAGE_CONTRACT = 3`, exported from `packages/sandbox-kubernetes/src/manifest.ts` (spec 5.1). The label is exactly `io.valet.sandbox.contract` (spec 5.2).
- `compatible(bake) = bake.contract_source === "override" || (bake.contract_version !== null && bake.contract_version >= MIN_IMAGE_CONTRACT)` (spec 5.3). The session-start check applies only when the sandbox provider backend is `kubernetes`.
- Backfill epoch: base bakes with `created_at >= 1789763460000` (2026-09-18T20:31:00Z) get 3, else 0; repo bakes inherit the contract of the parent base's newest pushed bake created at or before the repo bake, else 0; all backfilled rows get `contract_source = 'missing'` (spec 5.4).
- `bakes` columns: `contract_version integer`, `contract_source text` (`label` | `missing` | `override`), `parent_bake_id text`, `base_image_ref text`. `image_sources` columns: `health text NOT NULL DEFAULT 'healthy'` (`healthy` | `stale` | `incompatible` | `failing` | `unbaked`), `health_reason text NOT NULL DEFAULT 'ok'` (`ok` | `resolve_failed` | `repo_unreachable` | `credentials` | `registry_full` | `bake_failed` | `contract` | `contract_unknown` | `waiting_for_base`), `health_detail text` (truncated to 2000 chars), `health_checked_at bigint`. `agent_sessions.image_fallback jsonb` = `{ reason: "contract", sourceId, bakeId, at }` (spec 6.1, 7.1, 12).
- Schema changes ship as `SCHEMA_REPAIRS` entries in `packages/api/src/lib/drizzle.ts` with catalog probes, plus matching edits to `packages/api/migrations/pg/0000_app.sql` and `packages/api/src/schema/index.ts`. No manual ALTERs (spec 12). `scripts/ci/schema_repair_guard.py` fails the PR if `0000_app.sql` changes without a repair.
- Metric cardinality stays bounded: counter `valet.sandbox.image_fallback` has only `{ reason }`; no source names or session ids as labels (spec 3, 9).
- Session start never throws on resolver or health-write failure: every new failure path logs and degrades to the stock image (existing contract of `resolvePrebuildImage` and `resolveBaseImage`).
- Startup warning paragraph text is exactly (spec 7.2): `Prebuilt dependencies for \`<repoFullName>\` are unavailable right now because the repo image is being rebuilt. The workspace is checked out; install what you need.` under the heading `## Startup warning`.
- PR description: at most 300 words, no em dashes, a filled `## Validation` section (`scripts/docs/pr_description_lint.py`).

## Deliberate refinements of the spec

Each keeps the spec's intent; each gets a one-line note in the spec when this PR merges.

1. **Spec 6.3 (parent contract in the identity hash).** Folding the parent's contract into every repo identity would change every existing identity at deploy and rebake every repo once, contradicting spec 14's "everything baked in the 2026-10-26 cascade is unaffected". Instead, a `contract_changed` rebake keeps the identity and appends `-c<MIN_IMAGE_CONTRACT>` to the image tag, so the new push lands on a fresh tag (no `IfNotPresent` cache hit) while the identity-match skip rule still works once the new bake is compatible. Base bakes get the same suffix on their contract rebake. The one case the spec's variant also covered, a parent contract change, already changes the parent's identity and therefore the child's.
2. **Spec 7.2 (startup warning on every turn).** The system prompt is assembled once per session build (`codingSystemPrompt(...) + scratchWarningPrompt(...)` at three sites in `host.ts`); there is no per-turn prompt seam other than the repo-instructions overlay, which is the wrong place. The paragraph is appended at build time whenever the eager compatibility check says the repo bake is incompatible, so it repeats on every turn of that build and disappears at the next build (restore, resume after API restart). A thread note via the existing `noteSessionWarning` tells the user once.
3. **Spec 7.1 (callback wiring).** `SourceService` is constructed after `EngineHost` in `providers/node.ts`, so the host cannot take it in its constructor. The host exposes `setImageFallbackHandler(handler)`; `node.ts` and `integration/_setup.ts` attach `prebuildService.handleImageFallback` after both exist (same post-construction pattern as the capacity gate).
4. **Spec 5.4 (two backfill statements).** `runSchemaRepair` executes one `backfill` statement and counts its rows, so the base and repo updates are two data-modifying CTEs in one statement ending in `SELECT id FROM base UNION ALL SELECT id FROM repo`.
5. **Spec 6.2 (error-class mapping).** `GitHubApiError` carries only `status`; the mapping needs the path. It gains a public readonly `path`.
6. **Spec 8.7 (kind set), PR 1 carry-over.** The org capacity-ceiling timeout in `gated-sandbox-provider.ts` throws `SandboxStartupError` and was counted as kind `other`, which would feed the planned `ValetSandboxStartupFailures` alert. `SandboxStartupKind` gains `capacity` and the gate passes it. The spec's kind list becomes seven.
7. **PR 1 carry-over.** `resolvePodName` matches the owning Sandbox by name; it now prefers the owner reference UID when the CR has one, so a dying predecessor pod cannot be attributed to a new CR of the same name.
8. **Spec 6.2 (notification on transition) and 6.4 (wire fields) are PR 3.** (The wire needs only type additions: `routes/sources.ts` already spreads the whole row into `SourceSummary` and returns bake rows as `BakeSummary`.)
9. **Spec 6.1 (`health_checked_at` meaning).** Spec 6.1 says "when the scheduler last evaluated the source"; spec 11.1 keys a notification episode on "the `health_checked_at` at which the source entered the non-healthy state". Those conflict once the column is refreshed per pass. `health_checked_at` is written only on a transition of health or reason, so it reads as "in this state since", which is what the episode key and the UI's "failing since 2h" both need. `setSourceHealth` writes the columns only; PR 3 adds the metric snapshot refresh and the admin notification hook.

## Review Focus

Inputs the spec implies but no task's tests exercise, most likely to bite first. Each line's test is added to the owning task.

1. A pushed repo bake stamped by the backfill (`contract_source = 'missing'`, `contract_version = 0`) and a bake with `contract_version = null` both read as incompatible at session start, while a bake with `contract_source = 'override'` and a null version reads as compatible. Owner: Task 6.
2. The registry answers the manifest GET with an OCI image index (multi-arch) instead of a single manifest: the label reader follows the first manifest's digest and still finds the label. Owner: Task 2.
3. On the docker backend (local dev) the gate is skipped entirely: an unlabelled docker-local bake never degrades a session, and stamping uses `docker image inspect` rather than a registry. Owner: Task 6 (gate) and Task 3 (stamping).
4. The fallback handler runs on every reconcile sweep for a fallen-back session: health is written once per transition, not every sweep, and no second bake starts while one is active. Owner: Task 7.
5. The backfill for a repo bake whose parent is `external` or whose parent base has no pushed bake at or before it yields 0, never null. Owner: Task 1.

---

### Task 1: Schema columns, repairs, and the contract backfill

**Files:**
- Modify: `packages/api/src/schema/index.ts` (around line 405 for `agentSessions.bakeId`; `imageSources` at ~1940; `bakes` at ~1976)
- Modify: `packages/api/migrations/pg/0000_app.sql` (`agent_sessions` at ~227, `image_sources` at ~1078, `bakes` at ~1103)
- Modify: `packages/api/src/lib/drizzle.ts` (`SCHEMA_REPAIRS` array, starts at line 404; append new entries at the END of the array)
- Test: `packages/api/src/schema/pg-schema.test.ts`

**Interfaces:**
- Produces: `bakes.contractVersion: number | null`, `bakes.contractSource: "label" | "missing" | "override" | null`, `bakes.parentBakeId: string | null`, `bakes.baseImageRef: string | null`; `imageSources.health`, `imageSources.healthReason`, `imageSources.healthDetail: string | null`, `imageSources.healthCheckedAt: number | null`; `agentSessions.imageFallback: ImageFallback | null`; exported types `SourceHealth`, `SourceHealthReason`, `ContractSource`, `ImageFallback` from `packages/api/src/schema/index.ts`. Every later task reads these through `BakeRow` / `ImageSourceRow`.

- [ ] **Step 1: Add the drizzle columns and types**

In `packages/api/src/schema/index.ts`, make sure `integer` is in the `drizzle-orm/pg-core` import. Above `imageSources` add:

```ts
/** Spec 6.1: persisted source health, written by the scheduler. */
export type SourceHealth = "healthy" | "stale" | "incompatible" | "failing" | "unbaked";
export type SourceHealthReason =
  | "ok" | "resolve_failed" | "repo_unreachable" | "credentials" | "registry_full"
  | "bake_failed" | "contract" | "contract_unknown" | "waiting_for_base";
/** Spec 5.2: where a bake's contract value came from. */
export type ContractSource = "label" | "missing" | "override";
/** Spec 7.1: why a session is not on its repo image. */
export interface ImageFallback {
  reason: "contract";
  sourceId: string;
  bakeId: string;
  at: number;
}
```

In `imageSources`, after `lastBoundAt`:

```ts
    // Spec 6.1. Defaults are what a row looked like before health existed;
    // the first scheduler pass after deploy overwrites them.
    health: text("health", { enum: ["healthy", "stale", "incompatible", "failing", "unbaked"] }).notNull().default("healthy"),
    healthReason: text("health_reason", {
      enum: ["ok", "resolve_failed", "repo_unreachable", "credentials", "registry_full", "bake_failed", "contract", "contract_unknown", "waiting_for_base"],
    }).notNull().default("ok"),
    healthDetail: text("health_detail"),
    healthCheckedAt: bigint("health_checked_at", { mode: "number" }),
```

In `bakes`, after `sizeBytes`:

```ts
    // Image runtime contract (spec 5). `contractVersion` is the OCI label
    // value read from the registry after push, or the backfilled lineage
    // guess; null until read. `contractSource` says which.
    contractVersion: integer("contract_version"),
    contractSource: text("contract_source", { enum: ["label", "missing", "override"] }),
    // Lineage (spec 5.2): the parent base bake this bake FROMed, and the
    // exact FROM ref. Null on rows from before this column.
    parentBakeId: text("parent_bake_id"),
    baseImageRef: text("base_image_ref"),
```

In `agentSessions`, after `bakeId`:

```ts
    // Set when session start fell back from the repo image (spec 7.1);
    // cleared by the spec provider once a compatible repo bake resolves.
    imageFallback: jsonb("image_fallback").$type<ImageFallback>(),
```

- [ ] **Step 2: Mirror the columns in `0000_app.sql`**

In `CREATE TABLE "agent_sessions"` add after `"bake_id" text,`:

```sql
	"image_fallback" jsonb,
```

In `CREATE TABLE "image_sources"` add after `"last_bound_at" bigint,`:

```sql
	"health" text NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','stale','incompatible','failing','unbaked')),
	"health_reason" text NOT NULL DEFAULT 'ok',
	"health_detail" text,
	"health_checked_at" bigint,
```

In `CREATE TABLE "bakes"` add after `"size_bytes" BIGINT,`:

```sql
	"contract_version" integer,
	"contract_source" text CHECK (contract_source IS NULL OR contract_source IN ('label','missing','override')),
	"parent_bake_id" text,
	"base_image_ref" text,
```

- [ ] **Step 3: Write the failing repair test**

Append to `packages/api/src/schema/pg-schema.test.ts`, inside the top-level `describe` (reuse that file's PGlite boot helpers; the test needs a db booted from `0000_app.sql`, so copy how `beforeAll` builds `db`):

```ts
  describe("image pipeline health repairs", () => {
    const TINI_EPOCH = 1789763460000;

    async function oldShapedDb(): Promise<{ raw: PGlite; db: PgDb }> {
      const raw = new PGlite();
      const db = pgDbFromPglite(raw);
      await applyAppMigrations(db);
      // Drop the new columns so the repairs have something to do.
      await raw.query(`ALTER TABLE bakes DROP COLUMN contract_version, DROP COLUMN contract_source, DROP COLUMN parent_bake_id, DROP COLUMN base_image_ref`);
      await raw.query(`ALTER TABLE image_sources DROP COLUMN health, DROP COLUMN health_reason, DROP COLUMN health_detail, DROP COLUMN health_checked_at`);
      await raw.query(`ALTER TABLE agent_sessions DROP COLUMN image_fallback`);
      return { raw, db };
    }

    async function seedLineage(raw: PGlite): Promise<void> {
      const src = (id: string, kind: string, parent: string | null) =>
        raw.query(`INSERT INTO image_sources (id, org_id, kind, parent_id, name, created_at, updated_at) VALUES ($1, 'org', $2, $3, $1, 1, 1)`, [id, kind, parent]);
      const bake = (id: string, source: string, createdAt: number, status = "pushed") =>
        raw.query(`INSERT INTO bakes (id, source_id, identity_hash, image_ref, status, created_at) VALUES ($1, $2, '', $1, $3, $4)`, [id, source, status, createdAt]);
      await src("ext", "external", null);
      await src("base", "base", "ext");
      await src("repo", "repo", "base");
      await src("repo-ext", "repo", "ext");
      await src("repo-orphan", "repo", "base");
      await bake("base-old", "base", TINI_EPOCH - 1000);
      await bake("base-new", "base", TINI_EPOCH + 1000);
      await bake("base-failed-new", "base", TINI_EPOCH + 5000, "failed");
      await bake("repo-before", "repo", TINI_EPOCH - 500);   // newest earlier base bake: base-old → 0
      await bake("repo-after", "repo", TINI_EPOCH + 2000);   // newest earlier base bake: base-new → 3
      await bake("repo-ext-1", "repo-ext", TINI_EPOCH + 9000); // external parent → 0
      await bake("repo-orphan-1", "repo-orphan", TINI_EPOCH - 9000); // no base bake at or before → 0
    }

    it("adds the columns and backfills contracts by lineage on an old-shaped database", async () => {
      const { raw, db } = await oldShapedDb();
      await seedLineage(raw);
      expect((await missingSchemaRepairs(db)).map((r) => r.describe)).toEqual(
        expect.arrayContaining(["bakes contract and lineage columns", "image_sources health columns", "agent_sessions.image_fallback column"]),
      );
      await applyAppMigrations(db);
      expect(await missingSchemaRepairs(db)).toEqual([]);
      const rows = await raw.query<{ id: string; contract_version: number | null; contract_source: string | null }>(
        `SELECT id, contract_version, contract_source FROM bakes ORDER BY id`,
      );
      expect(Object.fromEntries(rows.rows.map((r) => [r.id, [r.contract_version, r.contract_source]]))).toEqual({
        "base-old": [0, "missing"],
        "base-new": [3, "missing"],
        "base-failed-new": [3, "missing"],
        "repo-before": [0, "missing"],
        "repo-after": [3, "missing"],
        "repo-ext-1": [0, "missing"],
        "repo-orphan-1": [0, "missing"],
      });
      const health = await raw.query<{ health: string; health_reason: string }>(`SELECT health, health_reason FROM image_sources LIMIT 1`);
      expect(health.rows[0]).toEqual({ health: "healthy", health_reason: "ok" });
      await raw.close();
    });

    it("a fresh database has the same columns and nothing to repair", async () => {
      const raw = new PGlite();
      const db = pgDbFromPglite(raw);
      await applyAppMigrations(db);
      const pending = (await missingSchemaRepairs(db)).map((r) => r.describe);
      expect(pending).not.toContain("bakes contract and lineage columns");
      const cols = await raw.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'bakes' AND column_name IN ('contract_version','contract_source','parent_bake_id','base_image_ref')`,
      );
      expect(cols.rows.map((c) => c.column_name).sort()).toEqual(["base_image_ref", "contract_source", "contract_version", "parent_bake_id"]);
      await raw.close();
    });
  });
```

If `applyAppMigrations` in that file does not itself run the repairs, use the exported function the existing "is idempotent on re-run" test uses to apply them; read that test and reuse its call.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @valet/api test src/schema/pg-schema.test.ts -t "image pipeline health repairs"`
Expected: FAIL (the repair describes are not found; the columns do not exist on the fresh db until Step 2 is in, and the backfill is missing).

- [ ] **Step 5: Add the repairs**

In `packages/api/src/lib/drizzle.ts`, above `SCHEMA_REPAIRS`:

```ts
/** Spec 5.4: first stock image containing tini (2026-09-18T20:31:00Z,
 * commit 56edb1bd9). Base bakes created at or after it are contract 3. */
const TINI_EPOCH_MS = 1789763460000;

/** Spec 5.4 backfill as ONE statement: base bakes by age, repo bakes by the
 * parent base's newest pushed bake created at or before them, else 0. The
 * sub-select reads the pre-statement snapshot, which is fine: it derives the
 * parent's contract from created_at, not from the column being written. */
const CONTRACT_BACKFILL_SQL = `WITH base AS (
  UPDATE bakes b SET contract_version = CASE WHEN b.created_at >= ${TINI_EPOCH_MS} THEN 3 ELSE 0 END, contract_source = 'missing'
  FROM image_sources s WHERE s.id = b.source_id AND s.kind = 'base' AND b.contract_version IS NULL
  RETURNING b.id
), repo AS (
  UPDATE bakes b SET contract_version = COALESCE((
      SELECT CASE WHEN pb.created_at >= ${TINI_EPOCH_MS} THEN 3 ELSE 0 END
      FROM bakes pb JOIN image_sources ps ON ps.id = pb.source_id
      WHERE ps.kind = 'base' AND ps.id = s.parent_id AND pb.status = 'pushed' AND pb.created_at <= b.created_at
      ORDER BY pb.created_at DESC LIMIT 1), 0),
    contract_source = 'missing'
  FROM image_sources s WHERE s.id = b.source_id AND s.kind = 'repo' AND b.contract_version IS NULL
  RETURNING b.id
)
SELECT id FROM base UNION ALL SELECT id FROM repo`;
```

Append to the END of `SCHEMA_REPAIRS`:

```ts
  {
    describe: "bakes contract and lineage columns",
    probe: { kind: "column", table: "bakes", column: "contract_version" },
    sql: `DO $repair$ BEGIN
      ALTER TABLE bakes ADD COLUMN IF NOT EXISTS contract_version integer;
      ALTER TABLE bakes ADD COLUMN IF NOT EXISTS contract_source text;
      ALTER TABLE bakes ADD COLUMN IF NOT EXISTS parent_bake_id text;
      ALTER TABLE bakes ADD COLUMN IF NOT EXISTS base_image_ref text; END $repair$`,
    backfill: CONTRACT_BACKFILL_SQL,
  },
  {
    describe: "image_sources health columns",
    probe: { kind: "column", table: "image_sources", column: "health" },
    sql: `DO $repair$ BEGIN
      ALTER TABLE image_sources ADD COLUMN IF NOT EXISTS health text NOT NULL DEFAULT 'healthy';
      ALTER TABLE image_sources ADD COLUMN IF NOT EXISTS health_reason text NOT NULL DEFAULT 'ok';
      ALTER TABLE image_sources ADD COLUMN IF NOT EXISTS health_detail text;
      ALTER TABLE image_sources ADD COLUMN IF NOT EXISTS health_checked_at bigint; END $repair$`,
  },
  {
    describe: "agent_sessions.image_fallback column",
    probe: { kind: "column", table: "agent_sessions", column: "image_fallback" },
    sql: `ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS image_fallback jsonb`,
  },
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @valet/api test src/schema/pg-schema.test.ts`
Expected: PASS, including the pre-existing table-count and idempotency tests.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/schema/index.ts packages/api/migrations/pg/0000_app.sql packages/api/src/lib/drizzle.ts packages/api/src/schema/pg-schema.test.ts
git commit -S -F - <<'MSG'
feat(api): bake contract, source health, and session image_fallback columns

Adds the spec 12 columns as schema repairs with a lineage backfill: base
bakes at or after the first tini stock image are contract 3, repo bakes
inherit the parent base's newest earlier pushed bake, everything else 0.

Changelog: internal
MSG
```

---

### Task 2: Contract constants and the image contract module

**Files:**
- Modify: `packages/sandbox-kubernetes/src/manifest.ts` (near `SCRATCH_PLACEHOLDER_COMMAND`, line ~57), `packages/sandbox-kubernetes/src/index.ts`
- Create: `packages/api/src/prebuilds/image-contract.ts`
- Test: `packages/api/src/prebuilds/image-contract.test.ts` (create), `packages/sandbox-kubernetes/test/manifest.test.ts`

**Interfaces:**
- Produces: `export const SANDBOX_IMAGE_CONTRACT = 3; export const MIN_IMAGE_CONTRACT = 3;` from `@valet/sandbox-kubernetes`. From `packages/api/src/prebuilds/image-contract.ts`: `CONTRACT_LABEL = "io.valet.sandbox.contract"`; `compatible(bake: { contractVersion: number | null; contractSource: string | null } | null | undefined): boolean`; `readImageContractLabel(backend: string, imageRef: string, deps: ContractReadDeps): Promise<ContractRead>` where `ContractReadDeps = { fetchImpl: typeof fetch; spawnFn: SpawnFn; registryInsecure: boolean; registryPushHost?: string; timeoutMs?: number }` and `ContractRead = { ok: true; version: number | null } | { ok: false; error: string }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/prebuilds/image-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MIN_IMAGE_CONTRACT } from "@valet/sandbox-kubernetes";
import { compatible, readImageContractLabel, CONTRACT_LABEL } from "./image-contract.js";

const REF = "localhost:30500/src-abc/acme-widgets:deadbeef-0123456789ab";

function registry(responses: Record<string, { status?: number; body?: unknown; contentType?: string }>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    const match = Object.entries(responses).find(([suffix]) => path.endsWith(suffix));
    if (!match) return new Response("not found", { status: 404 });
    const { status = 200, body, contentType = "application/json" } = match[1];
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  spawnFn: (() => { throw new Error("spawn not expected on kubernetes"); }) as never,
  registryInsecure: true,
  registryPushHost: "registry.valet.svc:5000",
});

const MANIFEST = { schemaVersion: 2, config: { digest: "sha256:cfg", size: 10 }, layers: [] };

describe("compatible", () => {
  it.each([
    [{ contractVersion: MIN_IMAGE_CONTRACT, contractSource: "label" }, true],
    [{ contractVersion: MIN_IMAGE_CONTRACT + 1, contractSource: "label" }, true],
    [{ contractVersion: MIN_IMAGE_CONTRACT - 1, contractSource: "label" }, false],
    [{ contractVersion: 0, contractSource: "missing" }, false],
    [{ contractVersion: null, contractSource: "missing" }, false],
    [{ contractVersion: null, contractSource: null }, false],
    [{ contractVersion: null, contractSource: "override" }, true],
    [{ contractVersion: 0, contractSource: "override" }, true],
    [null, false],
    [undefined, false],
  ])("%j → %s", (bake, expected) => {
    expect(compatible(bake as never)).toBe(expected);
  });
});

describe("readImageContractLabel (kubernetes)", () => {
  it("reads the label from the config blob behind the manifest, via the push host", async () => {
    const { fetchImpl, calls } = registry({
      "/manifests/deadbeef-0123456789ab": { body: MANIFEST },
      "/blobs/sha256:cfg": { body: { config: { Labels: { [CONTRACT_LABEL]: "3" } } } },
    });
    expect(await readImageContractLabel("kubernetes", REF, deps(fetchImpl))).toEqual({ ok: true, version: 3 });
    expect(calls[0]).toBe("http://registry.valet.svc:5000/v2/src-abc/acme-widgets/manifests/deadbeef-0123456789ab");
    expect(calls[1]).toBe("http://registry.valet.svc:5000/v2/src-abc/acme-widgets/blobs/sha256:cfg");
  });

  it("follows an OCI image index to its first manifest", async () => {
    const { fetchImpl } = registry({
      "/manifests/deadbeef-0123456789ab": {
        body: { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: "sha256:m1", platform: { os: "linux", architecture: "amd64" } }] },
      },
      "/manifests/sha256:m1": { body: MANIFEST },
      "/blobs/sha256:cfg": { body: { config: { Labels: { [CONTRACT_LABEL]: "3" } } } },
    });
    expect(await readImageContractLabel("kubernetes", REF, deps(fetchImpl))).toEqual({ ok: true, version: 3 });
  });

  it("an image without the label is ok with a null version", async () => {
    const { fetchImpl } = registry({
      "/manifests/deadbeef-0123456789ab": { body: MANIFEST },
      "/blobs/sha256:cfg": { body: { config: { Labels: { other: "x" } } } },
    });
    expect(await readImageContractLabel("kubernetes", REF, deps(fetchImpl))).toEqual({ ok: true, version: null });
  });

  it("a non-integer label value reads as null", async () => {
    const { fetchImpl } = registry({
      "/manifests/deadbeef-0123456789ab": { body: MANIFEST },
      "/blobs/sha256:cfg": { body: { config: { Labels: { [CONTRACT_LABEL]: "three" } } } },
    });
    expect(await readImageContractLabel("kubernetes", REF, deps(fetchImpl))).toEqual({ ok: true, version: null });
  });

  it("a missing manifest is a failed read, not a null label", async () => {
    const { fetchImpl } = registry({});
    const read = await readImageContractLabel("kubernetes", REF, deps(fetchImpl));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(/404/);
  });

  it("a network error is a failed read and never throws", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const read = await readImageContractLabel("kubernetes", REF, deps(fetchImpl));
    expect(read).toEqual({ ok: false, error: expect.stringContaining("ECONNREFUSED") });
  });

  it("an unknown backend is a failed read", async () => {
    const { fetchImpl } = registry({});
    expect((await readImageContractLabel("local", REF, deps(fetchImpl))).ok).toBe(false);
  });
});
```

In `packages/sandbox-kubernetes/test/manifest.test.ts` add:

```ts
describe("image runtime contract constants", () => {
  it("pins the current and minimum contract", async () => {
    const { SANDBOX_IMAGE_CONTRACT, MIN_IMAGE_CONTRACT } = await import("../src/index.js");
    expect(SANDBOX_IMAGE_CONTRACT).toBe(3);
    expect(MIN_IMAGE_CONTRACT).toBe(3);
    expect(MIN_IMAGE_CONTRACT).toBeLessThanOrEqual(SANDBOX_IMAGE_CONTRACT);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/prebuilds/image-contract.test.ts` and `pnpm --filter @valet/sandbox-kubernetes test test/manifest.test.ts -t "contract constants"`
Expected: FAIL, module not found / export missing.

- [ ] **Step 3: Add the constants**

In `packages/sandbox-kubernetes/src/manifest.ts`, next to `SCRATCH_PLACEHOLDER_COMMAND`:

```ts
/**
 * Image runtime contract (image-pipeline-health design, section 5). Names the
 * set of things this pod spec assumes exist inside a sandbox image. Value 3
 * is the image built from docker/Dockerfile.sandbox-k8s today: /usr/bin/tini,
 * /start-headless.sh, /start-full.sh, /usr/local/bin/valet-browser-client,
 * and HOME_LAYOUT_VERSION 2. The Dockerfile stamps the same number as
 * `LABEL io.valet.sandbox.contract`.
 *
 * Maintainer rule: a change that makes this module or the start scripts
 * depend on something new in the image bumps SANDBOX_IMAGE_CONTRACT and the
 * Dockerfile label together. If old images cannot run the new pod spec at
 * all, it also bumps MIN_IMAGE_CONTRACT, which invalidates every bake below
 * it at once (sessions fall back until the cascade finishes).
 */
export const SANDBOX_IMAGE_CONTRACT = 3;
/** The lowest contract the current pod spec can run. */
export const MIN_IMAGE_CONTRACT = 3;
```

Export both from `packages/sandbox-kubernetes/src/index.ts` next to the other manifest exports.

- [ ] **Step 4: Create the api module**

`packages/api/src/prebuilds/image-contract.ts`:

```ts
/**
 * Image runtime contract (image-pipeline-health design, section 5).
 *
 * `compatible` is the ONE predicate the scheduler's skip rule, the parent
 * readiness check, and the session-start resolvers share. `readImageContractLabel`
 * reads the `io.valet.sandbox.contract` OCI label from a pushed image: on the
 * kubernetes backend through the registry (manifest, then config blob, like
 * `bake-size.ts`), on the docker backend through `docker image inspect`.
 * Never throws; a failed read is `{ ok: false, error }` so the caller can mark
 * the source `contract_unknown` and retry on the next pass.
 */
import { MIN_IMAGE_CONTRACT } from "@valet/sandbox-kubernetes";
import type { SpawnFn } from "./docker-builder.js";
import { parseRegistryImageRef, MANIFEST_ACCEPT } from "./registry.js";
import { pushRefFor } from "./k8s-builder.js";

export const CONTRACT_LABEL = "io.valet.sandbox.contract";

export interface ContractFields {
  contractVersion: number | null;
  contractSource: string | null;
}

/** Spec 5.3. A missing row, a null contract on a non-override bake, or a
 * value below the minimum reads as incompatible. */
export function compatible(bake: ContractFields | null | undefined): boolean {
  if (!bake) return false;
  if (bake.contractSource === "override") return true;
  return bake.contractVersion !== null && bake.contractVersion >= MIN_IMAGE_CONTRACT;
}

export interface ContractReadDeps {
  fetchImpl: typeof fetch;
  spawnFn: SpawnFn;
  registryInsecure: boolean;
  registryPushHost?: string;
  /** Per-request budget; the post-push read is off the session path, so a
   * generous default is fine. */
  timeoutMs?: number;
}

export type ContractRead = { ok: true; version: number | null } | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 10_000;

function parseContract(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

function labelsOf(config: unknown): Record<string, unknown> | null {
  if (typeof config !== "object" || config === null) return null;
  const inner = (config as { config?: unknown }).config;
  if (typeof inner !== "object" || inner === null) return null;
  const labels = (inner as { Labels?: unknown }).Labels;
  return typeof labels === "object" && labels !== null ? (labels as Record<string, unknown>) : null;
}

async function readFromRegistry(imageRef: string, deps: ContractReadDeps): Promise<ContractRead> {
  const parsed = parseRegistryImageRef(pushRefFor(imageRef, deps.registryPushHost));
  if (!parsed) return { ok: false, error: `unparseable image ref ${imageRef}` };
  const { host, name, tag } = parsed;
  const scheme = deps.registryInsecure ? "http" : "https";
  const base = `${scheme}://${host}/v2/${name}`;
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const getJson = async (url: string, accept: string): Promise<unknown> => {
    const res = await deps.fetchImpl(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return res.json();
  };
  try {
    let manifest = (await getJson(`${base}/manifests/${tag}`, MANIFEST_ACCEPT)) as Record<string, unknown>;
    // An OCI index (multi-arch) points at per-platform manifests; take the
    // first linux one, else the first entry. BuildKit pushes a plain
    // manifest by default, so this branch is rare here.
    if (Array.isArray(manifest["manifests"])) {
      const entries = manifest["manifests"] as Array<{ digest?: string; platform?: { os?: string } }>;
      const pick = entries.find((e) => e.platform?.os === "linux") ?? entries[0];
      if (!pick?.digest) return { ok: false, error: "image index has no manifests" };
      manifest = (await getJson(`${base}/manifests/${pick.digest}`, MANIFEST_ACCEPT)) as Record<string, unknown>;
    }
    const configDigest = (manifest["config"] as { digest?: unknown } | undefined)?.digest;
    if (typeof configDigest !== "string") return { ok: false, error: "manifest has no config digest" };
    const config = await getJson(`${base}/blobs/${configDigest}`, "application/json, */*");
    const labels = labelsOf(config);
    return { ok: true, version: parseContract(labels?.[CONTRACT_LABEL]) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readFromDocker(imageRef: string, deps: ContractReadDeps): Promise<ContractRead> {
  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = deps.spawnFn("docker", ["image", "inspect", "--format", `{{index .Config.Labels "${CONTRACT_LABEL}"}}`, imageRef], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code !== 0) { resolve({ ok: false, error: `docker image inspect exited ${code}` }); return; }
      resolve({ ok: true, version: parseContract(Buffer.concat(chunks).toString("utf8").trim()) });
    });
  });
}

export async function readImageContractLabel(backend: string, imageRef: string, deps: ContractReadDeps): Promise<ContractRead> {
  try {
    if (backend === "kubernetes") return await readFromRegistry(imageRef, deps);
    if (backend === "docker") return await readFromDocker(imageRef, deps);
    return { ok: false, error: `no contract reader for backend ${backend}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

Check `SpawnFn`'s shape in `docker-builder.ts` (the child's `stdout` and event names) and adjust the docker reader to it; `bake-size.ts`'s `measureDockerSize` is the model.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @valet/api test src/prebuilds/image-contract.test.ts`, `pnpm --filter @valet/sandbox-kubernetes test test/manifest.test.ts`, then `pnpm --filter @valet/sandbox-kubernetes typecheck` and `pnpm --filter @valet/api typecheck`.
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-kubernetes/src/manifest.ts packages/sandbox-kubernetes/src/index.ts packages/sandbox-kubernetes/test/manifest.test.ts packages/api/src/prebuilds/image-contract.ts packages/api/src/prebuilds/image-contract.test.ts
git commit -S -F - <<'MSG'
feat(api): image runtime contract constants, predicate, and label reader

Changelog: internal
MSG
```

---

### Task 3: Lineage and contract stamping on bake rows

**Files:**
- Modify: `packages/api/src/bakes/source-service.ts` (`SourceServiceDeps` ~line 43-62 and constructor ~99-115; `startBaseBake` ~1142; `startRepoBake` ~1338; `syncActiveBuilds` pushed branch ~1585-1610)
- Test: `packages/api/src/bakes/source-service.test.ts`

**Interfaces:**
- Consumes: `readImageContractLabel(backend, imageRef, deps)`, `ContractRead` from Task 2; `BakeRow.contractVersion / contractSource / parentBakeId / baseImageRef` from Task 1.
- Produces: `SourceServiceDeps.contractReader?: (backend: string, imageRef: string) => Promise<ContractRead>` (test seam; defaults to `readImageContractLabel` wired with the service's `registryFetch`, `spawn`, `registryInsecure`, `registryPushHost`); private `stampContract(row: BakeRow, source: ImageSourceRow): Promise<ContractRead>`; every new bake row has `parentBakeId` and `baseImageRef` set.

- [ ] **Step 1: Write the failing tests**

In `source-service.test.ts`, add a `describe("contract stamping and lineage")` block next to the existing `syncActiveBuilds` tests. Use the file's `makeService`, `seedBaseSource`, `seedRepoSource`, `seedBake`, `FakeImageBuilder` and the GitHub fixture exactly as the neighbouring scheduler tests do:

```ts
  describe("contract stamping and lineage", () => {
    it("records parent_bake_id and base_image_ref on a repo bake chained on a base bake", async () => {
      const baseId = await seedBaseSource(db, []);
      const svc0 = makeService();
      const baseIdentity = svc0.identityHash({ id: baseId, kind: "base", setupCommands: [] } as never, null);
      await seedBake(db, baseId, { id: "base-1", identityHash: baseIdentity, imageRef: "valet-prebuild/base:abc", contractVersion: 3, contractSource: "label" });
      const repoId = await seedRepoSource(db, { parentId: baseId });
      const svc = makeService();
      const row = await svc.startBake(repoId, "manual");
      expect(row.parentBakeId).toBe("base-1");
      expect(row.baseImageRef).toBe("valet-prebuild/base:abc");
      const stored = (await db.select().from(bakes).where(eq(bakes.id, row.id)))[0];
      expect(stored.parentBakeId).toBe("base-1");
      expect(stored.baseImageRef).toBe("valet-prebuild/base:abc");
    });

    it("records base_image_ref = stock and a null parent on an unparented base bake", async () => {
      const baseId = await seedBaseSource(db, ["apt-get install -y jq"]);
      const svc = makeService({ env: { VALET_FULL_BASE_IMAGE: "ghcr.io/tkhq/valet-sandbox:pin" } });
      const row = await svc.startBake(baseId, "manual");
      expect(row.parentBakeId).toBeNull();
      expect(row.baseImageRef).toBe("ghcr.io/tkhq/valet-sandbox:pin");
    });

    it("stamps contract_version and contract_source=label when the pushed image carries the label", async () => {
      const reads: string[] = [];
      const svc = makeService({ contractReader: async (_backend, ref) => { reads.push(ref); return { ok: true, version: 3 }; } });
      const src = await seedRepoSource(db);
      const row = await svc.startBake(src, "manual");
      builder.setState(builder.buildIds[0], { state: "pushed" });
      await svc.syncActiveBuilds();
      const stored = (await db.select().from(bakes).where(eq(bakes.id, row.id)))[0];
      expect(stored.status).toBe("pushed");
      expect(stored.contractVersion).toBe(3);
      expect(stored.contractSource).toBe("label");
      expect(reads).toEqual([row.imageRef]);
    });

    it("stamps contract_source=missing with a null version when the image has no label", async () => {
      const svc = makeService({ contractReader: async () => ({ ok: true, version: null }) });
      const src = await seedRepoSource(db);
      const row = await svc.startBake(src, "manual");
      builder.setState(builder.buildIds[0], { state: "pushed" });
      await svc.syncActiveBuilds();
      const stored = (await db.select().from(bakes).where(eq(bakes.id, row.id)))[0];
      expect(stored.contractVersion).toBeNull();
      expect(stored.contractSource).toBe("missing");
    });

    it("stamps contract_source=override for a bake whose recipe pins its own image, keeping the read value", async () => {
      prebuildYaml = "image: ghcr.io/acme/custom:1\n";
      const svc = makeService({ contractReader: async () => ({ ok: true, version: null }) });
      const src = await seedRepoSource(db);
      const row = await svc.startBake(src, "manual");
      builder.setState(builder.buildIds[0], { state: "pushed" });
      await svc.syncActiveBuilds();
      const stored = (await db.select().from(bakes).where(eq(bakes.id, row.id)))[0];
      expect(stored.contractSource).toBe("override");
      expect(stored.contractVersion).toBeNull();
    });

    it("leaves both contract columns null when the label read fails, and the push transition still lands", async () => {
      const svc = makeService({ contractReader: async () => ({ ok: false, error: "registry 503" }) });
      const src = await seedRepoSource(db);
      const row = await svc.startBake(src, "manual");
      builder.setState(builder.buildIds[0], { state: "pushed" });
      await svc.syncActiveBuilds();
      const stored = (await db.select().from(bakes).where(eq(bakes.id, row.id)))[0];
      expect(stored.status).toBe("pushed");
      expect(stored.contractVersion).toBeNull();
      expect(stored.contractSource).toBeNull();
    });
  });
```

If `prebuildYaml` is scoped inside another `describe`, hoist it or set the fixture the way the existing override-image tests in this file do; the point is a recipe snapshot with `image` set.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/bakes/source-service.test.ts -t "contract stamping"`
Expected: FAIL (`contractReader` unknown; `parentBakeId` undefined; contract columns stay null).

- [ ] **Step 3: Implement**

`SourceServiceDeps` gains:

```ts
  /** Reads the image contract label after a push (spec 5.2). Defaults to
   * `readImageContractLabel` against this service's registry settings;
   * tests inject a fake. */
  contractReader?: (backend: string, imageRef: string) => Promise<ContractRead>;
```

Constructor:

```ts
    this.contractReader = deps.contractReader ?? ((backend, imageRef) => readImageContractLabel(backend, imageRef, {
      fetchImpl: this.registryFetch,
      spawnFn: spawn,
      registryInsecure: this.registryInsecure,
      registryPushHost: this.registryPushHost,
    }));
```

(`spawn` is already imported for `measureBakeSize`; add the field `private readonly contractReader: (backend: string, imageRef: string) => Promise<ContractRead>;` and the import `import { readImageContractLabel, type ContractRead } from "../prebuilds/image-contract.js";`.)

`startBaseBake`: replace the two lines computing `parentIdent` and `baseImage` so lineage is captured once:

```ts
    const parentBase = await this.resolveParentBase(source);
    const parentIdent = parentBase.status === "external" ? parentBase.ref : parentBase.status === "ready" ? parentBase.bake.identityHash : null;
    const baseImage = await this.resolveBaseImage(source, undefined);
    const parentBakeId = parentBase.status === "ready" ? parentBase.bake.id : null;
```

and add to the row literal: `parentBakeId, baseImageRef: baseImage, contractVersion: null, contractSource: null,`.

`startRepoBake`: after `const baseImage = await this.resolveBaseImage(source, resolved.image);` add

```ts
    const parentBase = await this.resolveParentBase(source);
    const parentBakeId = parentBase.status === "ready" ? parentBase.bake.id : null;
```

keep the existing `parentIdent` line, and add `parentBakeId, baseImageRef: baseImage, contractVersion: null, contractSource: null,` to the row literal.

New private method, placed right after `runPostBakeRetention`:

```ts
  /**
   * Spec 5.2: after a push, read the contract label and store it on the
   * row. Override bakes (recipe.image set) are `override` whatever the read
   * says (D7). A failed read leaves both columns null so the next pass can
   * retry; the caller decides what that means for source health.
   */
  private async stampContract(row: BakeRow, source: ImageSourceRow): Promise<ContractRead> {
    const override = typeof (row.recipe as { image?: unknown } | null)?.image === "string";
    const read = await this.contractReader(row.builderBackend ?? this.builder?.backend ?? "none", row.imageRef);
    if (!read.ok) {
      console.warn(`prebuild poll: contract label read failed for ${row.imageRef} (${source.name}): ${read.error}`);
      if (!override) return read;
    }
    const version = read.ok ? read.version : null;
    await this.db
      .update(bakes)
      .set({ contractVersion: version, contractSource: override ? "override" : version === null ? "missing" : "label" })
      .where(eq(bakes.id, row.id));
    return read;
  }
```

In `syncActiveBuilds`'s pushed branch, right after the size measurement block and before `recordPrebuildTransition(dimensions, "succeeded")`:

```ts
        await this.stampContract(row, source);
```

(Task 4 changes this line to use the returned read for health.)

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test src/bakes/source-service.test.ts` and `pnpm --filter @valet/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/bakes/source-service.ts packages/api/src/bakes/source-service.test.ts
git commit -S -F - <<'MSG'
feat(bakes): stamp bake rows with their image contract and lineage

After a push the scheduler reads the io.valet.sandbox.contract label from
the registry (or docker image inspect on the docker backend) and stores it
on the bake, together with the parent base bake and the FROM ref.

Changelog: internal
MSG
```

---

### Task 4: Source health, written at every scheduler exit

**Files:**
- Modify: `packages/api/src/bakes/source-service.ts` (`GitHubApiError` ~293; `runSchedulerPass` ~1811; `maybeScheduleBase` ~1832; `maybeScheduleRepo` ~1853; `syncActiveBuilds` pushed/failed branches)
- Modify: `packages/api/src/observability/prebuild-lifecycle.ts` (module-level scheduler timestamp)
- Test: `packages/api/src/bakes/source-service.test.ts`

**Interfaces:**
- Consumes: `compatible(bake)` (Task 2), `stampContract` (Task 3), health columns (Task 1).
- Produces: `async setSourceHealth(sourceId: string, health: SourceHealth, reason: SourceHealthReason, detail?: string | null): Promise<boolean>` (public, on `SourceService`; writes only when `health` or `reason` changes, in which case `healthCheckedAt` becomes the transition time; a changed `detail` alone updates `healthDetail` without touching `healthCheckedAt`; returns true when health or reason changed). `healthCheckedAt` therefore means "when the source entered its current health/reason", which PR 3 uses as the notification episode key (plan refinement 9); `GitHubApiError.path: string`; `export function recordSchedulerPass(at: number): void` and `export function lastSchedulerPassAt(): number | undefined` in `prebuild-lifecycle.ts`; exported pure helper `healthReasonForError(err: unknown): SourceHealthReason` from `source-service.ts`. Task 7 calls `setSourceHealth`.

- [ ] **Step 1: Write the failing tests**

In `source-service.test.ts`, add `describe("source health")`:

```ts
  describe("source health", () => {
    async function healthOf(id: string) {
      const row = (await db.select().from(imageSources).where(eq(imageSources.id, id)))[0];
      return { health: row.health, reason: row.healthReason, detail: row.healthDetail, checkedAt: row.healthCheckedAt };
    }

    it("a scheduler hit writes healthy/ok", async () => {
      const src = await seedRepoSource(db);
      const svc = makeService();
      const parentIdent = null;
      const identity = svc.identityHash((await db.select().from(imageSources).where(eq(imageSources.id, src)))[0], parentIdent, RESOLVED_NPM_RECIPE);
      await seedBake(db, src, { commitSha: fixture.headSha, identityHash: identity, contractVersion: 3, contractSource: "label" });
      await svc.runSchedulerPass();
      expect(await healthOf(src)).toMatchObject({ health: "healthy", reason: "ok" });
    });

    it("a repo with no pushed bake is unbaked after the pass starts its first bake", async () => {
      const src = await seedRepoSource(db);
      await makeService().runSchedulerPass();
      expect(await healthOf(src)).toMatchObject({ health: "unbaked", reason: "ok" });
    });

    it("a repo whose head moved is stale when its current bake is compatible", async () => {
      const src = await seedRepoSource(db);
      await seedBake(db, src, { commitSha: "old-sha", contractVersion: 3, contractSource: "label" });
      await makeService().runSchedulerPass();
      expect(await healthOf(src)).toMatchObject({ health: "stale", reason: "ok" });
    });

    it("a repo deferring behind an unready base is stale/waiting_for_base", async () => {
      const baseId = await seedBaseSource(db, ["echo base"]);
      const src = await seedRepoSource(db, { parentId: baseId });
      await makeService().runSchedulerPass();
      expect(await healthOf(src)).toMatchObject({ health: "stale", reason: "waiting_for_base" });
    });

    it("a thrown GitHub 404 on the repo path is failing/repo_unreachable, with the error text as detail", async () => {
      const src = await seedRepoSource(db, { repoFullName: "acme/gone", name: "acme/gone" });
      // fixture: make the repo lookup 404 (see how existing tests simulate a missing repo)
      repoMissing = true;
      await makeService().runSchedulerPass();
      const h = await healthOf(src);
      expect(h).toMatchObject({ health: "failing", reason: "repo_unreachable" });
      expect(h.detail).toMatch(/404/);
    });

    it("a pushed bake with a compatible label makes the source healthy; a failed label read makes it stale/contract_unknown", async () => {
      const src = await seedRepoSource(db);
      const svcOk = makeService({ contractReader: async () => ({ ok: true, version: 3 }) });
      await svcOk.startBake(src, "manual");
      builder.setState(builder.buildIds[0], { state: "pushed" });
      await svcOk.syncActiveBuilds();
      expect(await healthOf(src)).toMatchObject({ health: "healthy", reason: "ok" });

      const svcBad = makeService({ contractReader: async () => ({ ok: false, error: "registry 503" }) });
      await svcBad.startBake(src, "manual");
      builder.setState(builder.buildIds[1], { state: "pushed" });
      await svcBad.syncActiveBuilds();
      expect(await healthOf(src)).toMatchObject({ health: "stale", reason: "contract_unknown", detail: "registry 503" });
    });

    it("a failed bake is stale/bake_failed when a compatible bake exists, else failing/bake_failed", async () => {
      const src = await seedRepoSource(db);
      const svc = makeService();
      await svc.startBake(src, "manual");
      builder.setState(builder.buildIds[0], { state: "failed", error: "npm ci exploded" });
      await svc.syncActiveBuilds();
      expect(await healthOf(src)).toMatchObject({ health: "failing", reason: "bake_failed", detail: "npm ci exploded" });

      await seedBake(db, src, { id: "good", contractVersion: 3, contractSource: "label" });
      await svc.startBake(src, "manual");
      builder.setState(builder.buildIds[1], { state: "failed", error: "npm ci exploded again" });
      await svc.syncActiveBuilds();
      expect(await healthOf(src)).toMatchObject({ health: "stale", reason: "bake_failed" });
    });

    it("setSourceHealth truncates detail, stamps health_checked_at only on a transition, and reports the transition", async () => {
      const src = await seedRepoSource(db);
      let t = NOW;
      const svc = makeService({ now: () => t });
      expect(await svc.setSourceHealth(src, "failing", "bake_failed", "x".repeat(5000))).toBe(true);
      expect(await healthOf(src)).toMatchObject({ health: "failing", checkedAt: NOW });
      expect((await healthOf(src)).detail).toHaveLength(2000);
      t = NOW + 60_000;
      expect(await svc.setSourceHealth(src, "failing", "bake_failed", "new detail")).toBe(false);
      expect(await healthOf(src)).toMatchObject({ detail: "new detail", checkedAt: NOW });
      expect(await svc.setSourceHealth(src, "failing", "bake_failed", "new detail")).toBe(false);
      t = NOW + 120_000;
      expect(await svc.setSourceHealth(src, "healthy", "ok", null)).toBe(true);
      expect(await healthOf(src)).toMatchObject({ health: "healthy", reason: "ok", detail: null, checkedAt: NOW + 120_000 });
    });

    it("healthReasonForError maps error classes", () => {
      expect(healthReasonForError(new GitHubApiError(404, "/repos/acme/gone"))).toBe("repo_unreachable");
      expect(healthReasonForError(new GitHubApiError(404, "/repos/acme/widgets/contents/pnpm-lock.yaml"))).toBe("resolve_failed");
      expect(healthReasonForError(new GitHubApiError(500, "/repos/acme/widgets"))).toBe("resolve_failed");
      expect(healthReasonForError(new AnonymousImageBakesDisabledError("acme/widgets"))).toBe("credentials");
      expect(healthReasonForError(new RegistryCapacityError("full"))).toBe("registry_full");
      expect(healthReasonForError(new Error("boom"))).toBe("bake_failed");
    });

    it("runSchedulerPass records its completion time", async () => {
      await makeService().runSchedulerPass();
      expect(lastSchedulerPassAt()).toBe(NOW);
    });
  });
```

Adapt `repoMissing` to whatever switch the fixture already offers for a 404 repo (look at `contentsFor` and the fixture's `getRepo` handler); if none exists, add a `getRepo` handler flag the way Task 1 of PR 1 added `getBlob`. Import `healthReasonForError`, `GitHubApiError`, `AnonymousImageBakesDisabledError` from `./source-service.js`, `RegistryCapacityError` from `./registry-health.js`, `lastSchedulerPassAt` from `../observability/prebuild-lifecycle.js`. Check `AnonymousImageBakesDisabledError`'s constructor arguments at source-service.ts:103 and match them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/bakes/source-service.test.ts -t "source health"`
Expected: FAIL (health stays `healthy/ok`; helpers missing).

- [ ] **Step 3: Implement**

`GitHubApiError`:

```ts
export class GitHubApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, detail?: string) {
    super(`GitHub API ${path} ${status === 0 ? "request failed" : `responded ${status}`}${detail ? `: ${detail}` : ""}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.path = path;
  }
}
```

Exported helper, below the error classes:

```ts
/** Spec 6.2: the health reason for a scheduler-pass failure, by error class.
 * A 404 on the repository path itself (no `/contents/`, `/commits/`, or
 * `/git/` segment) is the repo being unreachable; any other GitHub error is a
 * resolve failure. */
export function healthReasonForError(err: unknown): SourceHealthReason {
  if (err instanceof GitHubApiError) {
    const onRepoRoot = !/\/(contents|commits|git|branches)\//.test(err.path + "/");
    return err.status === 404 && onRepoRoot ? "repo_unreachable" : "resolve_failed";
  }
  if (err instanceof AnonymousImageBakesDisabledError) return "credentials";
  if (err instanceof RegistryCapacityError) return "registry_full";
  return "bake_failed";
}

const HEALTH_DETAIL_MAX = 2000;
```

Public method on `SourceService`, next to `currentBake`:

```ts
  /** Spec 6.2 with plan refinement 9. Writes the health columns on a
   * transition of health or reason; `health_checked_at` is the time the
   * current (health, reason) was entered, so PR 3 can key a notification
   * episode on it and the UI can say "failing since". A changed detail
   * alone updates `health_detail` only. Returns true on a transition. */
  async setSourceHealth(sourceId: string, health: SourceHealth, reason: SourceHealthReason, detail?: string | null): Promise<boolean> {
    const trimmed = detail == null ? null : detail.slice(0, HEALTH_DETAIL_MAX);
    const [row] = await this.db.select({ health: imageSources.health, reason: imageSources.healthReason, detail: imageSources.healthDetail })
      .from(imageSources).where(eq(imageSources.id, sourceId)).limit(1);
    if (!row) return false;
    const transition = row.health !== health || row.reason !== reason;
    if (!transition && row.detail === trimmed) return false;
    await this.db.update(imageSources)
      .set(transition
        ? { health, healthReason: reason, healthDetail: trimmed, healthCheckedAt: this.now() }
        : { healthDetail: trimmed })
      .where(eq(imageSources.id, sourceId));
    return transition;
  }
```

`runSchedulerPass`:

```ts
  async runSchedulerPass(): Promise<void> {
    if (!this.builder) return;
    const all = await this.db.select().from(imageSources);
    const bases = all.filter((s) => s.kind === "base");
    const repos = all.filter((s) => s.kind === "repo");

    for (const source of [...bases, ...repos]) {
      try {
        if (source.kind === "base") await this.maybeScheduleBase(source);
        else if (source.kind === "repo") await this.maybeScheduleRepo(source);
      } catch (err) {
        console.error(`prebuild scheduler: source ${source.id} (${source.repoFullName ?? source.name}) failed:`, err);
        await this.setSourceHealth(source.id, "failing", healthReasonForError(err), err instanceof Error ? err.message : String(err))
          .catch((healthErr) => console.error(`prebuild scheduler: health write for ${source.id} failed:`, healthErr));
      }
    }
    recordSchedulerPass(this.now());
  }
```

Health at each `maybeScheduleBase` exit (the three `return`s and the start): `hit` → `healthy/ok`; `coalesced` and `parent_changed`/`miss` → `stale/ok` when `current && compatible(current)`, `incompatible/contract` when `current && !compatible(current)`, else `unbaked/ok`. Add after each `recordPrebuildDecision(...)` call:

```ts
      await this.setSourceHealth(source.id, "healthy", "ok", null);           // hit
      await this.setSourceHealth(source.id, ...this.pendingHealth(current));   // coalesced, parent_changed, miss
```

with the private helper

```ts
  /** Health for a source that needs (or is waiting on) a new bake. */
  private pendingHealth(current: BakeRow | null): [SourceHealth, SourceHealthReason, string | null] {
    if (!current) return ["unbaked", "ok", null];
    if (!compatible(current)) return ["incompatible", "contract", `current bake ${current.id} contract ${current.contractVersion ?? "missing"} < ${MIN_IMAGE_CONTRACT}`];
    return ["stale", "ok", null];
  }
```

`maybeScheduleRepo`: defer → `setSourceHealth(source.id, "stale", "waiting_for_base", null)` before its `return` (use `stale` even with no current bake; the spec names this case explicitly); decay → leave health alone (the source is being disabled); `hit` → `healthy/ok`; `coalesced`, `miss`, `commit_changed`, `recipe_changed` → `pendingHealth(current)`; the `RepoBaseLayerBakingError` defer → `stale/waiting_for_base` with `err.message`.

`syncActiveBuilds` pushed branch: replace the Task 3 line with

```ts
        const contract = await this.stampContract(row, source);
        const stamped = (await this.db.select().from(bakes).where(eq(bakes.id, row.id)))[0];
        if (!contract.ok) await this.setSourceHealth(row.sourceId, "stale", "contract_unknown", contract.error);
        else if (stamped && compatible(stamped)) await this.setSourceHealth(row.sourceId, "healthy", "ok", null);
        else await this.setSourceHealth(row.sourceId, "incompatible", "contract", `bake ${row.id} contract ${stamped?.contractVersion ?? "missing"} < ${MIN_IMAGE_CONTRACT}`);
```

Failed branch, after the `logPrebuildEvent(...bake_failed...)` call:

```ts
        const survivor = await this.currentBake(row.sourceId);
        await this.setSourceHealth(row.sourceId, survivor && compatible(survivor) ? "stale" : "failing", "bake_failed", status.error ?? null);
```

Imports: `compatible` from `../prebuilds/image-contract.js`, `MIN_IMAGE_CONTRACT` from `@valet/sandbox-kubernetes`, `SourceHealth`/`SourceHealthReason` types from `../schema/index.js`, `recordSchedulerPass` from `../observability/prebuild-lifecycle.js`.

`prebuild-lifecycle.ts`, after `updatePrebuildQueueSnapshot`:

```ts
let schedulerPassAt: number | undefined;
/** Spec 6.3: when `runSchedulerPass` last completed, in process memory. PR 3
 * exports it as a gauge; the alert's `for` tolerates a restart. */
export function recordSchedulerPass(at: number): void { schedulerPassAt = at; }
export function lastSchedulerPassAt(): number | undefined { return schedulerPassAt; }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test src/bakes/source-service.test.ts src/observability/prebuild-lifecycle.test.ts` and `pnpm --filter @valet/api typecheck`
Expected: PASS. Existing scheduler tests that count DB writes or assert exact `console.log` lines may need the new health write accounted for; adjust only the counts, never the behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/bakes/source-service.ts packages/api/src/bakes/source-service.test.ts packages/api/src/observability/prebuild-lifecycle.ts
git commit -S -F - <<'MSG'
feat(bakes): persist image source health at every scheduler exit

Every maybeSchedule exit, the scheduler's catch, and the push and fail
transitions now write image_sources.health, health_reason, health_detail,
and health_checked_at, so an admin can see why a source is not healthy.

Changelog: Image sources now record a health state (healthy, stale, incompatible, failing, unbaked) with the reason, shown in a later release.
MSG
```

---

### Task 5: Scheduler rebakes incompatible images and defers behind incompatible bases

**Files:**
- Modify: `packages/api/src/bakes/source-service.ts` (`resolveParentBase` ~1017; `imageRefFor`/`baseImageRefFor` call sites in `startBaseBake` and `startRepoBake`; `maybeScheduleBase`; `maybeScheduleRepo`)
- Modify: `packages/api/src/observability/prebuild-lifecycle.ts:132` (`recordPrebuildDecision` union)
- Test: `packages/api/src/bakes/source-service.test.ts`

**Interfaces:**
- Consumes: `compatible`, `MIN_IMAGE_CONTRACT`, `pendingHealth` (Task 4).
- Produces: decision `contract_changed` in `recordPrebuildDecision`'s union; `startBake(sourceId, trigger, opts?: { contractRebake?: boolean })` where `contractRebake` appends `-c<MIN_IMAGE_CONTRACT>` to the new bake's image tag; `resolveParentBase` returns `{ status: "defer" }` when the parent's consistent bake is incompatible.

- [ ] **Step 1: Write the failing tests**

```ts
  describe("contract-driven rebakes", () => {
    it("rebakes a repo whose current bake matches head and identity but is incompatible, on a fresh tag", async () => {
      const src = await seedRepoSource(db);
      const svc = makeService();
      const row0 = (await db.select().from(imageSources).where(eq(imageSources.id, src)))[0];
      const identity = svc.identityHash(row0, null, RESOLVED_NPM_RECIPE);
      await seedBake(db, src, { id: "old", commitSha: fixture.headSha, identityHash: identity, imageRef: "valet-prebuild/acme-widgets:head-abcdef", contractVersion: 0, contractSource: "missing" });
      await svc.runSchedulerPass();
      expect(builder.specs).toHaveLength(1);
      expect(builder.specs[0].imageRef).toMatch(new RegExp(`-c${MIN_IMAGE_CONTRACT}$`));
      expect(builder.specs[0].imageRef).not.toBe("valet-prebuild/acme-widgets:head-abcdef");
      const queued = (await db.select().from(bakes).where(eq(bakes.sourceId, src))).find((b) => b.status !== "pushed")!;
      expect(queued.identityHash).toBe(identity);
    });

    it("does not rebake a compatible, up-to-date repo (identity skip still a hit)", async () => {
      const src = await seedRepoSource(db);
      const svc = makeService();
      const row0 = (await db.select().from(imageSources).where(eq(imageSources.id, src)))[0];
      const identity = svc.identityHash(row0, null, RESOLVED_NPM_RECIPE);
      await seedBake(db, src, { commitSha: fixture.headSha, identityHash: identity, contractVersion: 3, contractSource: "label" });
      await svc.runSchedulerPass();
      expect(builder.specs).toHaveLength(0);
    });

    it("rebakes an incompatible base and defers its repo children until the base is compatible", async () => {
      const baseId = await seedBaseSource(db, []);
      const svc = makeService();
      const baseIdentity = svc.identityHash((await db.select().from(imageSources).where(eq(imageSources.id, baseId)))[0], null);
      await seedBake(db, baseId, { id: "base-old", identityHash: baseIdentity, imageRef: "valet-prebuild/base:x", contractVersion: 0, contractSource: "missing" });
      const repoId = await seedRepoSource(db, { parentId: baseId });
      await svc.runSchedulerPass();
      // One base bake started (contract rebake), the repo deferred.
      expect(builder.specs.map((s) => s.kind)).toEqual(["base"]);
      expect(builder.specs[0].imageRef).toMatch(/-c3$/);
      const repo = (await db.select().from(imageSources).where(eq(imageSources.id, repoId)))[0];
      expect(repo.health).toBe("stale");
      expect(repo.healthReason).toBe("waiting_for_base");
    });

    it("an override-image repo bake is never rebaked for contract", async () => {
      prebuildYaml = "image: ghcr.io/acme/custom:1\n";
      const src = await seedRepoSource(db);
      const svc = makeService();
      const row0 = (await db.select().from(imageSources).where(eq(imageSources.id, src)))[0];
      const identity = svc.identityHash(row0, null, { ...RESOLVED_NPM_RECIPE, image: "ghcr.io/acme/custom:1" });
      await seedBake(db, src, { commitSha: fixture.headSha, identityHash: identity, contractVersion: null, contractSource: "override", recipe: { recipe: [], setup: [], image: "ghcr.io/acme/custom:1" } });
      await svc.runSchedulerPass();
      expect(builder.specs).toHaveLength(0);
    });
  });
```

Match the identity the scheduler will compute: read how the existing "skip … up to date" tests in this file build `identity` (which recipe snapshot and parent identity they pass) and copy that, replacing `RESOLVED_NPM_RECIPE` if the fixture resolves a different recipe.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/bakes/source-service.test.ts -t "contract-driven"`
Expected: FAIL (no rebake; no `-c3` tag; repo not deferred).

- [ ] **Step 3: Implement**

`recordPrebuildDecision` union gains `"contract_changed"`.

`resolveParentBase`, inside the `parent.kind === "base"` branch, after the identity check:

```ts
      // Spec 5.3 via 6.3: a child must not FROM an incompatible base. The
      // base scheduler rebakes it (contract_changed); children defer like
      // they do for a stale base identity.
      if (!compatible(parentBake)) return { status: "defer" };
```

`startBake` signature and the two builders take an options bag:

```ts
  async startBake(sourceId: string, trigger: "manual" | "scheduler" | "cascade" | "binding" | "seed" | "other", opts: { contractRebake?: boolean } = {}): Promise<BakeRow>
```

Thread `opts` to `startBaseBake(source, trigger, opts)` and `startRepoBake(source, trigger, opts)`, adding the same third parameter with the same default to both. In `startBaseBake` replace

```ts
    const imageRef = baseImageRefFor(builder.backend, source.id, identity, this.env.VALET_PREBUILD_REGISTRY);
```

with

```ts
    // Plan refinement 1: a contract rebake keeps the identity (same inputs)
    // but must land on a fresh tag, or nodes with IfNotPresent keep serving
    // the cached old layer.
    const taggedRef = baseImageRefFor(builder.backend, source.id, identity, this.env.VALET_PREBUILD_REGISTRY);
    const imageRef = opts.contractRebake ? `${taggedRef}-c${MIN_IMAGE_CONTRACT}` : taggedRef;
```

In `startRepoBake` replace the `const imageRef = imageRefFor(` block with

```ts
    const taggedRef = imageRefFor(builder.backend, source.id, owner, repo, head.sha, identity, this.env.VALET_PREBUILD_REGISTRY);
    const imageRef = opts.contractRebake ? `${taggedRef}-c${MIN_IMAGE_CONTRACT}` : taggedRef;
```

`maybeScheduleBase` skip rule:

```ts
    if (current && current.identityHash === identity && compatible(current)) { ...hit... }
    ...
    const contractRebake = Boolean(current && current.identityHash === identity && !compatible(current));
    recordPrebuildDecision(this.dimensions(source), contractRebake ? "contract_changed" : current ? "parent_changed" : "miss");
    await this.setSourceHealth(source.id, ...this.pendingHealth(current));
    await this.startBake(source.id, "scheduler", { contractRebake });
```

`maybeScheduleRepo` skip rule and decision:

```ts
    if (current && current.commitSha === head.sha && current.identityHash === identity && compatible(current)) { ...hit... }
    ...
    const contractRebake = Boolean(current && current.commitSha === head.sha && current.identityHash === identity && !compatible(current));
    recordPrebuildDecision(this.dimensions(source), contractRebake ? "contract_changed" : !current ? "miss" : current.commitSha !== head.sha ? "commit_changed" : "recipe_changed");
    await this.setSourceHealth(source.id, ...this.pendingHealth(current));
    try {
      await this.startBake(source.id, "scheduler", { contractRebake });
```

`cascadeBaseChildren` (line ~1741) computes child identities too; read it and apply the same `compatible(current)` term to its skip rule if it has one, so a child on an incompatible bake is included in the cascade.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test src/bakes/source-service.test.ts` and `pnpm --filter @valet/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/bakes/source-service.ts packages/api/src/bakes/source-service.test.ts packages/api/src/observability/prebuild-lifecycle.ts
git commit -S -F - <<'MSG'
fix(bakes): rebake images below the runtime contract and defer children of an incompatible base

A current bake that matches head and identity but is below
MIN_IMAGE_CONTRACT is no longer a scheduler hit: it is rebaked on a fresh
-c<contract> tag, and repo children wait until their base is compatible.

Changelog: Sandbox images built before the current runtime contract are rebuilt automatically instead of being served until their next recipe or commit change.
MSG
```

---

### Task 6: The session-start gate in both resolvers

**Files:**
- Modify: `packages/api/src/prebuilds/resolve.ts` (`resolvePrebuildImage`, line ~85)
- Modify: `packages/api/src/engine/resolve-snapshot.ts` (`resolveBaseImage` ~43; `ResolveSnapshotDeps`; `resolveSnapshot`)
- Test: `packages/api/src/prebuilds/resolve.test.ts`, `packages/api/src/engine/resolve-snapshot.test.ts`

**Interfaces:**
- Consumes: `compatible` (Task 2), bake contract columns (Task 1).
- Produces: in `resolve.ts`: `export interface IncompatibleImage { sourceId: string; bakeId: string; contract: number | null; repoFullName: string }`, `export type OnIncompatibleImage = (info: IncompatibleImage) => Promise<void> | void`, `resolvePrebuildImage(db, meta, provider, preflight?, onIncompatible?: OnIncompatibleImage)`, and `export async function repoBakeCompatibility(db: AppDb | undefined, meta: SessionMeta, provider: SandboxProvider): Promise<{ compatible: boolean; info: IncompatibleImage } | null>` (the one-read check Task 8's eager prompt uses; null when no source or no pushed bake). In `resolve-snapshot.ts`: `ResolveSnapshotDeps.onIncompatible?: OnIncompatibleImage`. The gate applies only when `provider.backend === "kubernetes"`.

- [ ] **Step 1: Write the failing resolver tests**

In `resolve.test.ts`, extend `seedPrebuild`'s `opts` with `contractVersion?: number | null; contractSource?: "label" | "missing" | "override" | null` passed through to the insert (default both `null`, which keeps every existing case meaning "unstamped"; those cases use a non-kubernetes backend, so they still resolve). Add:

```ts
describe("resolvePrebuildImage contract gate (kubernetes only)", () => {
  let harness: TestPgDb;
  let db: AppDb;
  beforeEach(async () => { harness = await freshTestPgDb(); db = harness.appDb; });
  afterEach(async () => { await harness.cleanup(); });

  const k8s = () => fakeProvider(true, "kubernetes");
  const compatibleBake = { contractVersion: 3, contractSource: "label" as const };

  it("a compatible bake resolves exactly as before", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, { id: "pb", status: "pushed", imageRef: "r:1", commitSha: "s", createdAt: NOW, ...compatibleBake });
    const calls: unknown[] = [];
    const res = await resolvePrebuildImage(db, meta(), k8s(), undefined, (i) => { calls.push(i); });
    expect(res?.imageRef).toBe("r:1");
    expect(calls).toEqual([]);
  });

  it.each([
    ["backfilled below the minimum", { contractVersion: 0, contractSource: "missing" as const }],
    ["unstamped (null version, null source)", { contractVersion: null, contractSource: null }],
    ["labelled below the minimum", { contractVersion: 2, contractSource: "label" as const }],
  ])("%s → null and the callback fires once with the bake", async (_name, contract) => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, { id: "pb-bad", status: "pushed", imageRef: "r:bad", commitSha: "s", createdAt: NOW, ...contract });
    const calls: IncompatibleImage[] = [];
    const res = await resolvePrebuildImage(db, meta(), k8s(), undefined, (i) => { calls.push(i); });
    expect(res).toBeNull();
    expect(calls).toEqual([{ sourceId: cfg, bakeId: "pb-bad", contract: contract.contractVersion, repoFullName: REPO }]);
  });

  it("an override bake with no label passes the gate", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, { id: "pb-ovr", status: "pushed", imageRef: "r:ovr", commitSha: "s", createdAt: NOW, contractVersion: null, contractSource: "override" });
    expect((await resolvePrebuildImage(db, meta(), k8s()))?.imageRef).toBe("r:ovr");
  });

  it("the gate does not apply on the docker backend", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, { id: "pb", status: "pushed", imageRef: "r:docker", commitSha: "s", createdAt: NOW, contractVersion: 0, contractSource: "missing" });
    const calls: unknown[] = [];
    expect((await resolvePrebuildImage(db, meta(), fakeProvider(true, "docker"), undefined, (i) => { calls.push(i); }))?.imageRef).toBe("r:docker");
    expect(calls).toEqual([]);
  });

  it("a throwing callback is swallowed and still yields null", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, { id: "pb-bad", status: "pushed", imageRef: "r:bad", commitSha: "s", createdAt: NOW, contractVersion: 0, contractSource: "missing" });
    expect(await resolvePrebuildImage(db, meta(), k8s(), undefined, () => { throw new Error("handler boom"); })).toBeNull();
  });

  it("repoBakeCompatibility reports the newest pushed bake's compatibility and null when there is none", async () => {
    expect(await repoBakeCompatibility(db, meta(), k8s())).toBeNull();
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, { id: "pb-bad", status: "pushed", imageRef: "r:bad", commitSha: "s", createdAt: NOW, contractVersion: 0, contractSource: "missing" });
    expect(await repoBakeCompatibility(db, meta(), k8s())).toEqual({ compatible: false, info: { sourceId: cfg, bakeId: "pb-bad", contract: 0, repoFullName: REPO } });
    await seedPrebuild(db, cfg, { id: "pb-good", status: "pushed", imageRef: "r:good", commitSha: "s", createdAt: NOW + 1, ...compatibleBake });
    expect((await repoBakeCompatibility(db, meta(), k8s()))?.compatible).toBe(true);
    expect((await repoBakeCompatibility(db, meta(), fakeProvider(true, "docker")))?.compatible).toBe(true);
  });
});
```

In `resolve-snapshot.test.ts`, extend that file's `seedBake` helper the same way and add inside the base-bake `describe`:

```ts
    it("an incompatible org base bake on kubernetes degrades to the stock image", async () => {
      const baseId = await seedBaseSource(db);
      await seedBake(db, baseId, { id: "base-old", status: "pushed", imageRef: BASE_IMAGE_REF, createdAt: NOW, contractVersion: 0, contractSource: "missing" });
      const snap = await resolveSnapshot({ db, provider: fakeProvider(true, "kubernetes"), meta: meta({ repos: [] }), apiUrl: API_URL, stockImage: STOCK_IMAGE });
      expect(snap.baseBakeRef).toBeNull();
      expect(computeSpec(snap).image).toBe(STOCK_IMAGE);
    });

    it("an incompatible repo bake with a compatible base falls back to the base image and fires onIncompatible", async () => {
      const baseId = await seedBaseSource(db);
      await seedBake(db, baseId, { id: "base-ok", status: "pushed", imageRef: BASE_IMAGE_REF, createdAt: NOW, contractVersion: 3, contractSource: "label" });
      const repoId = await seedRepoBakeSource(db);
      await seedBake(db, repoId, { id: "repo-bad", status: "pushed", imageRef: "r:bad", commitSha: "s", createdAt: NOW, contractVersion: 0, contractSource: "missing" });
      const calls: unknown[] = [];
      const snap = await resolveSnapshot({ db, provider: fakeProvider(true, "kubernetes"), meta: meta(), apiUrl: API_URL, stockImage: STOCK_IMAGE, onIncompatible: (i) => { calls.push(i); } });
      expect(snap.repoBake).toBeNull();
      expect(computeSpec(snap).image).toBe(BASE_IMAGE_REF);
      expect(calls).toHaveLength(1);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/prebuilds/resolve.test.ts src/engine/resolve-snapshot.test.ts`
Expected: FAIL (bad bakes still resolve; `repoBakeCompatibility` missing).

- [ ] **Step 3: Implement**

`resolve.ts`: add the types and helper above `resolvePrebuildImage`:

```ts
import { compatible } from "./image-contract.js";

export interface IncompatibleImage {
  sourceId: string;
  bakeId: string;
  contract: number | null;
  repoFullName: string;
}
export type OnIncompatibleImage = (info: IncompatibleImage) => Promise<void> | void;

/** Spec 5.3: the gate applies only on kubernetes; docker images are
 * daemon-local and the local/virtual providers never boot a bake. */
export function contractGateApplies(provider: SandboxProvider): boolean {
  return provider.backend === "kubernetes";
}

async function newestPushedRepoBake(db: AppDb, meta: SessionMeta): Promise<{ source: ImageSourceRow; bake: BakeRow } | null> {
  const primary = meta.repos?.[0];
  if (!primary) return null;
  const host = primary.host ?? "github";
  const [source] = await db.select().from(imageSources)
    .where(and(eq(imageSources.orgId, meta.orgId), eq(imageSources.kind, "repo"), eq(imageSources.repoHost, host), eq(imageSources.repoFullName, primary.fullName)))
    .limit(1);
  if (!source || !source.enabled) return null;
  const [bake] = await db.select().from(bakes)
    .where(and(eq(bakes.sourceId, source.id), eq(bakes.status, "pushed")))
    .orderBy(desc(bakes.createdAt)).limit(1);
  return bake ? { source, bake } : null;
}

/** One DB read answering "would the gate fall this session back?", for the
 * eager startup-warning check (spec 7.2). Never throws. */
export async function repoBakeCompatibility(
  db: AppDb | undefined,
  meta: SessionMeta,
  provider: SandboxProvider,
): Promise<{ compatible: boolean; info: IncompatibleImage } | null> {
  try {
    if (!db || !provider.capabilities().customImage) return null;
    const found = await newestPushedRepoBake(db, meta);
    if (!found) return null;
    const info = { sourceId: found.source.id, bakeId: found.bake.id, contract: found.bake.contractVersion, repoFullName: found.source.repoFullName ?? meta.repos?.[0]?.fullName ?? "" };
    return { compatible: !contractGateApplies(provider) || compatible(found.bake), info };
  } catch (err) {
    console.error(`repo bake compatibility check failed for ${meta.orgId}/${meta.repos?.[0]?.fullName ?? "?"}:`, err);
    return null;
  }
}
```

Refactor `resolvePrebuildImage` to use `newestPushedRepoBake` (same two queries as today), add the fifth parameter, and insert the gate right after `if (!prebuild) return null;`, before the pull preflight:

```ts
    // Spec 5.3 / 7.1: an incompatible repo bake must not boot. Degrade to
    // null (base, then stock) and tell the host so it can record the
    // fallback, mark the source, and request a rebake. The callback is
    // best-effort: its failure never changes the resolution.
    if (contractGateApplies(provider) && !compatible(prebuild)) {
      console.warn(`prebuild image ${prebuild.imageRef} is below the runtime contract (contract ${prebuild.contractVersion ?? "missing"}) — falling back`);
      try {
        await onIncompatible?.({ sourceId: source.id, bakeId: prebuild.id, contract: prebuild.contractVersion, repoFullName: source.repoFullName ?? primary.fullName });
      } catch (err) {
        console.error(`prebuild fallback handler failed for ${source.id}:`, err);
      }
      return null;
    }
```

Update the module header comment: add the contract gate to the predicate list.

`resolve-snapshot.ts`: `ResolveSnapshotDeps` gains `onIncompatible?: OnIncompatibleImage`; `resolveSnapshot` passes it as the fifth argument to `resolvePrebuildImage`. In `resolveBaseImage`, after `if (!bake) return null;`:

```ts
    // Spec 7.1 item 2: the org base must pass the same contract test; a
    // failing base degrades to the stock image, which is compatible by
    // construction (pinned with the API).
    if (contractGateApplies(provider) && !compatible(bake)) {
      console.warn(`base bake image ${bake.imageRef} is below the runtime contract (contract ${bake.contractVersion ?? "missing"}) — falling back to stock image`);
      return null;
    }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test src/prebuilds/resolve.test.ts src/engine/resolve-snapshot.test.ts src/engine/sandbox-spec.test.ts` and `pnpm --filter @valet/api typecheck`
Expected: PASS; every pre-existing case in both files still passes unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/prebuilds/resolve.ts packages/api/src/prebuilds/resolve.test.ts packages/api/src/engine/resolve-snapshot.ts packages/api/src/engine/resolve-snapshot.test.ts
git commit -S -F - <<'MSG'
fix(api): sessions fall back from images below the runtime contract

resolvePrebuildImage and resolveBaseImage apply compatible() on the
kubernetes backend: an incompatible repo bake yields null (the spec
degrades to the org base, then stock) and reports the bake to the host;
an incompatible base yields the stock image.

Changelog: A session bound to a sandbox image that predates the current runtime contract now starts on the stock image instead of failing to start.
MSG
```

---

### Task 7: Fallback bookkeeping: image_fallback, the counter, and the source-service handler

**Files:**
- Create: `packages/api/src/observability/image-fallback-metrics.ts`
- Modify: `packages/api/src/engine/host.ts` (`EngineHostOpts` ~470-505; `buildSpecProvider` ~1767-1860; `recordPrebuildId` ~1865)
- Modify: `packages/api/src/bakes/source-service.ts` (public `handleImageFallback`)
- Modify: `packages/api/src/providers/node.ts` (~567, after `prebuildService` is constructed), `packages/api/src/integration/_setup.ts` (~397)
- Test: `packages/api/src/engine/host.spec-provider.test.ts`, `packages/api/src/bakes/source-service.test.ts`, `packages/api/src/observability/image-fallback-metrics.test.ts` (create)

**Interfaces:**
- Consumes: `OnIncompatibleImage` / `IncompatibleImage` (Task 6); `setSourceHealth` (Task 4); `maybeFireFirstBake` guards (existing); `agentSessions.imageFallback` (Task 1).
- Produces: `export interface ImageFallbackEvent extends IncompatibleImage { sessionId: string }` in `packages/api/src/prebuilds/resolve.ts` (next to `IncompatibleImage`, so `source-service.ts` and `host.ts` both import it without a cycle); `EngineHost.setImageFallbackHandler(handler: (e: ImageFallbackEvent) => Promise<void>): void`; private `recordImageFallback(sessionId, fallback: ImageFallback | null)`; `export function recordImageFallback(reason: "contract"): void` in `image-fallback-metrics.ts` (counter `valet.sandbox.image_fallback`, attribute `{ reason }`); `SourceService.handleImageFallback(e: ImageFallbackEvent): Promise<void>` (never throws).

- [ ] **Step 1: Write the failing tests**

`packages/api/src/observability/image-fallback-metrics.test.ts` (copy the harness `credential-metrics.test.ts` uses to read points from an in-memory meter provider):

```ts
import { describe, expect, it } from "vitest";
import { recordImageFallback } from "./image-fallback-metrics.js";
// reuse the in-memory MeterProvider setup from credential-metrics.test.ts

describe("valet.sandbox.image_fallback", () => {
  it("counts by reason only", async () => {
    recordImageFallback("contract");
    recordImageFallback("contract");
    const points = await collectPoints("valet.sandbox.image_fallback");
    expect(points).toEqual([{ attributes: { reason: "contract" }, value: 2 }]);
  });
});
```

In `source-service.test.ts`:

```ts
  describe("handleImageFallback", () => {
    it("marks the source incompatible/contract and starts one bake through the first-bake guards", async () => {
      const src = await seedRepoSource(db);
      await seedBake(db, src, { id: "bad", contractVersion: 0, contractSource: "missing" });
      const svc = makeService();
      const event = { sessionId: "s1", sourceId: src, bakeId: "bad", contract: 0, repoFullName: "acme/widgets" };
      await svc.handleImageFallback(event);
      await svc.handleImageFallback(event); // second sweep of the same session
      await svc.handleImageFallback({ ...event, sessionId: "s2" }); // another session on the same source
      expect(builder.specs).toHaveLength(1);
      const row = (await db.select().from(imageSources).where(eq(imageSources.id, src)))[0];
      expect(row.health).toBe("incompatible");
      expect(row.healthReason).toBe("contract");
      expect(row.healthDetail).toContain("bad");
    });

    it("never throws when the source is gone or the builder is missing", async () => {
      const svc = makeService({ builder: null });
      await expect(svc.handleImageFallback({ sessionId: "s", sourceId: "src_missing", bakeId: "b", contract: 0, repoFullName: "x/y" })).resolves.toBeUndefined();
    });
  });
```

In `host.spec-provider.test.ts`, next to the "newer pushed prebuild produces different image ref" test (line ~418), seed the same way that test does but with the kubernetes-shaped provider (`backend: "kubernetes"`, `customImage: true`) and a bake row stamped `contractVersion: 0, contractSource: "missing"`:

```ts
  it("an incompatible repo bake records agent_sessions.image_fallback, calls the handler once, and clears on a compatible bake", async () => {
    const provider = makeIsolatedProvider({ customImage: true, backend: "kubernetes" });
    api = await bootTestApi({ sandboxProvider: provider, defaultImage: "stock:img" });
    const events: ImageFallbackEvent[] = [];
    api.providers.engineHost.setImageFallbackHandler(async (e) => { events.push(e); });

    const now = Date.now();
    await api.providers.db.insert(imageSources).values({
      id: "fb-cfg1", orgId: ORG, kind: "repo", parentId: null, name: "acme/widgets", externalRef: null, pullSecretName: null,
      setupCommands: null, repoHost: "github", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git",
      schedule: "nightly", enabled: true, lastBoundAt: null, createdAt: now, updatedAt: now,
    });
    const bakeRow = (id: string, createdAt: number, contract: { contractVersion: number | null; contractSource: "label" | "missing" | "override" | null }) => ({
      id, sourceId: "fb-cfg1", identityHash: "", commitSha: "sha1", imageRef: `valet-prebuild/acme-widgets:${id}`, status: "pushed" as const,
      builderBackend: "kubernetes", recipe: { recipe: [], setup: [], image: undefined }, error: null, logTail: null,
      startedAt: createdAt, finishedAt: createdAt, createdAt, ...contract,
    });
    await api.providers.db.insert(bakes).values(bakeRow("pb-bad", now, { contractVersion: 0, contractSource: "missing" }));

    const sessionId = "fb-session";
    await insertSession(api.providers.db, sessionId);
    const meta = { userId: USER, orgId: ORG, workspace: `/tmp/${sessionId}`, repos: [primaryBinding] };
    const session = await api.providers.engineHost.sessionFor(sessionId, meta);
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    // Stock image, not the bad bake; fallback recorded; handler called once.
    expect(provider.createCalls[0].image).toBeUndefined();
    const row = (await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)))[0];
    expect(row.imageFallback).toMatchObject({ reason: "contract", sourceId: "fb-cfg1", bakeId: "pb-bad" });
    expect(events).toEqual([expect.objectContaining({ sessionId, sourceId: "fb-cfg1", bakeId: "pb-bad", contract: 0, repoFullName: "acme/widgets" })]);

    // A compatible bake lands. Re-evaluating the spec provider (the same
    // closure a reconcile sweep runs) clears the fallback and picks the bake.
    await api.providers.db.insert(bakes).values(bakeRow("pb-good", now + 1000, { contractVersion: 3, contractSource: "label" }));
    const desired = await session.options.specProvider!();
    expect(desired.image).toBe("valet-prebuild/acme-widgets:pb-good");
    const cleared = (await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)))[0];
    expect(cleared.imageFallback).toBeNull();
    expect(events).toHaveLength(1);
  });
```

`makeIsolatedProvider` currently hardcodes `backend: "recording-isolated"`; give it a `backend?: string` option defaulting to that. The gate only applies on `kubernetes`, so every existing test keeps its backend. `session.options.specProvider` is how `host.legacy-persona.test.ts` reads built-session options (`session.options.systemPrompt`); if `specProvider` is not on `options` in this engine version, drive a second `ensureReady` after `session.attachment.suspend()` instead (the resume path re-runs the closure) and assert the same row state.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/observability/image-fallback-metrics.test.ts src/bakes/source-service.test.ts src/engine/host.spec-provider.test.ts -t "fallback"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`image-fallback-metrics.ts`:

```ts
/** Spec 9: sessions that fell back from their repo image, by reason. */
import { metrics } from "@opentelemetry/api";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let counter: Counter | null = null;

export function recordImageFallback(reason: "contract"): void {
  counter ??= metrics.getMeter("@valet/api").createCounter("valet.sandbox.image_fallback", {
    description: "Session starts that fell back from the repo image, by reason",
  });
  counter.add(1, { reason });
}
```

`resolve.ts` (next to `IncompatibleImage`):

```ts
export interface ImageFallbackEvent extends IncompatibleImage { sessionId: string }
```

`host.ts`, field and setter on `EngineHost` (import the type from `../prebuilds/resolve.js`):

```ts
  /** Spec 7.1 callback target; attached after construction because the
   * SourceService is built after the host (providers/node.ts). */
  private imageFallbackHandler?: (event: ImageFallbackEvent) => Promise<void>;
  setImageFallbackHandler(handler: (event: ImageFallbackEvent) => Promise<void>): void {
    this.imageFallbackHandler = handler;
  }
```

In `buildSpecProvider`'s closure, pass the callback and clear on success:

```ts
      const snap = await resolveSnapshot({
        db: host.opts.db,
        provider: host.opts.sandboxProvider,
        meta,
        apiUrl,
        stockImage,
        preflight: host.opts.prebuildPreflight,
        onIncompatible: async (info) => {
          recordImageFallback("contract");
          await host.recordImageFallback(sessionId, { reason: "contract", sourceId: info.sourceId, bakeId: info.bakeId, at: Date.now() });
          await host.imageFallbackHandler?.({ ...info, sessionId });
        },
      });
      ...
      if (snap.repoBake) {
        await host.recordPrebuildId(sessionId, snap.repoBake.bakeId);
        await host.recordImageFallback(sessionId, null);
      }
```

Next to `recordPrebuildId`:

```ts
  /** Best-effort write of `agent_sessions.image_fallback` (spec 7.1). A null
   * clears it; the clear is conditioned on the column being set so a
   * steady-state session costs no row write per reconcile. */
  private async recordImageFallback(sessionId: string, fallback: ImageFallback | null): Promise<void> {
    if (!this.opts.db) return;
    try {
      if (fallback) {
        await this.opts.db.update(agentSessions).set({ imageFallback: fallback }).where(eq(agentSessions.id, sessionId));
      } else {
        await this.opts.db.update(agentSessions).set({ imageFallback: null })
          .where(and(eq(agentSessions.id, sessionId), isNotNull(agentSessions.imageFallback)));
      }
    } catch (err) {
      console.error(`EngineHost: recording image_fallback for session ${sessionId} failed:`, err);
    }
  }
```

(`isNotNull` from `drizzle-orm`; `ImageFallback` type from the schema.)

`source-service.ts`:

```ts
  /** Spec 7.1: a session fell back from this source's image. Mark the source
   * and request a bake through the same guards the first bake uses
   * (`repoBakeDefers`, `hasActiveBake`), so one fallen-back session per
   * reconcile sweep cannot start a bake each. Never throws. */
  async handleImageFallback(event: ImageFallbackEvent): Promise<void> {
    try {
      await this.setSourceHealth(event.sourceId, "incompatible", "contract", `bake ${event.bakeId} contract ${event.contract ?? "missing"} < ${MIN_IMAGE_CONTRACT}; session ${event.sessionId} fell back`);
      await this.maybeFireFirstBake(event.sourceId, { fullName: event.repoFullName });
    } catch (err) {
      console.error(`image fallback handling for ${event.sourceId} failed:`, err);
    }
  }
```

(import the `ImageFallbackEvent` type from `../prebuilds/resolve.js`.)

Wiring, `providers/node.ts` right after `prebuildService` is constructed:

```ts
  engineHost.setImageFallbackHandler((event) => prebuildService.handleImageFallback(event));
```

and the same line in `integration/_setup.ts` after its `prebuildService`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test src/observability/image-fallback-metrics.test.ts src/bakes/source-service.test.ts src/engine/host.spec-provider.test.ts src/engine/resolve-snapshot.test.ts` and `pnpm --filter @valet/api typecheck`
Expected: PASS. The existing "a workflow session's spec provider writes nothing to agent_sessions" test must still pass: both writes are `UPDATE ... WHERE id = sessionId`, which touches nothing when the session has no row.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/observability/image-fallback-metrics.ts packages/api/src/observability/image-fallback-metrics.test.ts packages/api/src/engine/host.ts packages/api/src/engine/host.spec-provider.test.ts packages/api/src/bakes/source-service.ts packages/api/src/bakes/source-service.test.ts packages/api/src/providers/node.ts packages/api/src/integration/_setup.ts
git commit -S -F - <<'MSG'
feat(api): record image fallbacks, count them, and request the rebake

The spec provider stores agent_sessions.image_fallback when the gate falls
a session back and clears it once a compatible repo bake resolves; the
source service marks the source incompatible and starts one bake through
the first-bake guards. Counter valet.sandbox.image_fallback{reason}.

Changelog: internal
MSG
```

---

### Task 8: The startup warning paragraph and thread note

**Files:**
- Modify: `packages/api/src/engine/host.ts` (`scratchWarningPrompt` ~548; the three `systemPrompt:` sites ~1388, ~1427, ~4443; the workflow `systemPrompt:` site ~4642; the `noteSessionWarning` call ~1460)
- Test: `packages/api/src/engine/host.spec-provider.test.ts` (or a new `host.image-fallback.test.ts` beside it)

**Interfaces:**
- Consumes: `repoBakeCompatibility(db, meta, provider)` (Task 6).
- Produces: `export function imageFallbackPrompt(repoFullName: string | undefined): string`; private `repoImageFallbackRepo(meta: SessionMeta): Promise<string | undefined>` on `EngineHost`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("imageFallbackPrompt", () => {
  it("renders the spec 7.2 paragraph and nothing when there is no fallback", async () => {
    const { imageFallbackPrompt } = await import("./host.js");
    expect(imageFallbackPrompt(undefined)).toBe("");
    expect(imageFallbackPrompt("acme/widgets")).toBe(
      "\n\n## Startup warning\n\nPrebuilt dependencies for `acme/widgets` are unavailable right now because the repo image is being rebuilt. The workspace is checked out; install what you need.",
    );
  });
});

it("a session that falls back gets the startup warning in its system prompt and one thread note", async () => {
  // Same seeding as Task 7's test: kubernetes-shaped provider, source fb-cfg1, pushed bake pb-bad (contract 0 / missing).
  const session = await api.providers.engineHost.sessionFor(sessionId, meta);
  await session.attachment.ensureReady({ timeoutMs: 5_000 });
  const prompt = session.options.systemPrompt ?? "";
  expect(prompt).toContain("## Startup warning");
  expect(prompt).toContain("Prebuilt dependencies for `acme/widgets` are unavailable right now because the repo image is being rebuilt.");
  const thread = await session.createThread("web:default");
  const snapshot = await api.providers.engineStore.getThreadSnapshot(sessionId, thread.id);
  const notes = (snapshot?.entries ?? []).filter((e) => e.type === "message" && e.role === "system" && String(e.content).includes("failed its compatibility check"));
  expect(notes).toHaveLength(1);
  // A rebuild of the same session does not add a second note.
  await api.providers.engineHost.evict?.(sessionId);
  const again = await api.providers.engineHost.sessionFor(sessionId, meta);
  await again.attachment.ensureReady({ timeoutMs: 5_000 });
  const snapshot2 = await api.providers.engineStore.getThreadSnapshot(sessionId, thread.id);
  expect((snapshot2?.entries ?? []).filter((e) => e.type === "message" && e.role === "system" && String(e.content).includes("failed its compatibility check"))).toHaveLength(1);
});

it("a session whose repo bake is compatible has no startup warning", async () => {
  // Same seeding with pb-good (contract 3 / label) only.
  const session = await api.providers.engineHost.sessionFor(sessionId, meta);
  await session.attachment.ensureReady({ timeoutMs: 5_000 });
  expect(session.options.systemPrompt ?? "").not.toContain("## Startup warning");
});
```

`session.options.systemPrompt` is how `host.legacy-persona.test.ts` reads a built session's prompt. If the host has no public evict for the rebuild check, use whatever `host.*.test.ts` uses to force a rebuild (several call `api.providers.engineHost.releaseSession` or rebuild through `sessionFor` after `liveSession(...).attachment.suspend()`); the assertion that matters is one note after two builds.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/engine/host.spec-provider.test.ts -t "startup warning|imageFallbackPrompt"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Next to `scratchWarningPrompt`:

```ts
/** Spec 7.2. Appended to the system prompt at build time when the eager
 * compatibility check says the repo image is incompatible, so it repeats on
 * every turn of that build; a note that disappears mid-task is worse than
 * one that repeats. */
export function imageFallbackPrompt(repoFullName: string | undefined): string {
  return repoFullName
    ? `\n\n## Startup warning\n\nPrebuilt dependencies for \`${repoFullName}\` are unavailable right now because the repo image is being rebuilt. The workspace is checked out; install what you need.`
    : "";
}
```

Private method on `EngineHost`, next to `resolveRepoPrebuildFlags`:

```ts
  /** The primary repo's full name when its newest pushed bake would fail the
   * contract gate (one DB read), else undefined. Never throws. */
  private async repoImageFallbackRepo(meta: SessionMeta): Promise<string | undefined> {
    const check = await repoBakeCompatibility(this.opts.db, meta, this.opts.sandboxProvider);
    return check && !check.compatible ? check.info.repoFullName : undefined;
  }
```

At each of the three interactive/child `systemPrompt:` sites, compute `const fallbackRepo = await this.repoImageFallbackRepo(meta);` once near where `repoFlags` is resolved in that builder, and append `+ imageFallbackPrompt(fallbackRepo)` after `scratchWarningPrompt(repoFlags.scratchWarning)`. At the workflow site (`systemPrompt: codingSystemPrompt({ ...codingPromptOptions(specProvider !== undefined, {}) })`), append `+ imageFallbackPrompt(fallbackRepo)` the same way.

Next to the scratch-warning note in `buildSession`:

```ts
    if (fallbackRepo) {
      await this.noteSessionWarning(
        session,
        `Running on the stock image: the \`${fallbackRepo}\` image failed its compatibility check and is being rebuilt. Prebuilt dependencies are unavailable until then.`,
        meta.warningThreadKey ?? "web:default",
      );
    }
```

`noteSessionWarning` already de-duplicates by content, so a rebuild does not add a second note.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test src/engine/host.spec-provider.test.ts src/engine/host.default-image.test.ts` and `pnpm --filter @valet/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/engine/host.ts packages/api/src/engine/host.spec-provider.test.ts
git commit -S -F - <<'MSG'
feat(api): tell the agent and the user when a session runs on the stock image

Changelog: When a session cannot use its repo image, the agent is told that prebuilt dependencies are unavailable and the thread shows a note explaining the image is being rebuilt.
MSG
```

---

### Task 9: PR 1 carry-overs: capacity kind and owner-UID pod matching

**Files:**
- Modify: `packages/engine/src/errors.ts` (`SandboxStartupKind`), `packages/api/src/engine/gated-sandbox-provider.ts:106`
- Modify: `packages/sandbox-kubernetes/src/lifecycle.ts` (`resolvePodName`, ~1588)
- Test: `packages/engine/test/metrics.test.ts` (kind accepted), `packages/api/src/engine/gated-sandbox-provider.test.ts` (find the ceiling-timeout test and assert `kind`), `packages/sandbox-kubernetes/test/lifecycle.test.ts`

**Interfaces:**
- Produces: `SandboxStartupKind` gains `"capacity"`; the ceiling timeout throws `new SandboxStartupError(sessionId, <message>, "capacity")`; `resolvePodName` matches `ownerReferences` by `uid === cr.metadata.uid` when the CR has a uid, else by name.

- [ ] **Step 1: Write the failing tests**

In the gated provider's existing ceiling-timeout test, add `expect((err as SandboxStartupError).kind).toBe("capacity")`. In `lifecycle.test.ts`:

```ts
describe("resolvePodName owner matching", () => {
  it("prefers the pod whose ownerReference uid matches the live CR over a same-name predecessor", async () => {
    const cr = { metadata: { name: "sb", uid: "uid-new" }, status: {} };
    const pods = [
      { name: "sb", ownerReferences: [{ kind: SANDBOX_KIND, name: "sb", uid: "uid-old", controller: true }] },
      { name: "sb-recovered", ownerReferences: [{ kind: SANDBOX_KIND, name: "sb", uid: "uid-new", controller: true }] },
    ];
    // build fake objectsApi returning cr (no pod-name annotation) and podsApi listing pods, using the file's existing fakes
    expect(await resolvePodName(objectsApi, podsApi, cfg, "sb")).toBe("sb-recovered");
  });

  it("falls back to name matching when the CR has no uid", async () => {
    // cr without metadata.uid → the first controller-owned pod named for "sb" wins
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/engine/gated-sandbox-provider.test.ts` and `pnpm --filter @valet/sandbox-kubernetes test test/lifecycle.test.ts -t "owner matching"`
Expected: FAIL (kind `other`; predecessor pod returned).

- [ ] **Step 3: Implement**

`errors.ts`: `export type SandboxStartupKind = "crash_loop" | "image_pull" | "unschedulable" | "pod_failed" | "ownership" | "capacity" | "other";` (update the doc comment: `capacity` is the org sandbox ceiling, not an infrastructure failure, so alert expressions exclude it).

`gated-sandbox-provider.ts:106`: pass `"capacity"` as the third constructor argument.

`lifecycle.ts` `resolvePodName`:

```ts
  const crUid = cr.metadata.uid;
  const owned = items.find((pod) =>
    pod.ownerReferences?.some((ref) =>
      ref.kind === SANDBOX_KIND && ref.controller === true && (crUid ? ref.uid === crUid : ref.name === name)),
  );
```

Run `pnpm --filter @valet/engine build` before the sandbox-kubernetes typecheck.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/engine test test/metrics.test.ts test/sandbox-attachment.test.ts`, `pnpm --filter @valet/api test src/engine/gated-sandbox-provider.test.ts`, `pnpm --filter @valet/sandbox-kubernetes test test/lifecycle.test.ts`, then typecheck all three packages.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/errors.ts packages/api/src/engine/gated-sandbox-provider.ts packages/api/src/engine/gated-sandbox-provider.test.ts packages/sandbox-kubernetes/src/lifecycle.ts packages/sandbox-kubernetes/test/lifecycle.test.ts
git commit -S -F - <<'MSG'
fix(sandbox): count ceiling timeouts as kind capacity and match pods by owner uid

Changelog: internal
MSG
```

---

### Task 10: Whole-branch verification and PR

**Files:** none new.

- [ ] **Step 1: Run every affected suite**

```bash
pnpm typecheck
pnpm --filter @valet/engine test
pnpm --filter @valet/sandbox-kubernetes test
pnpm --filter @valet/api test src/bakes src/prebuilds src/engine src/schema/pg-schema.test.ts src/observability
node scripts/ci/changelog_commit_guard.mjs --base "$(git merge-base origin/conner/image-pipeline-health-pr1 HEAD)" --head HEAD
git diff --name-only origin/conner/image-pipeline-health-pr1...HEAD | python3 scripts/ci/schema_repair_guard.py
```

Expected: all PASS; the changelog guard validates every commit; the schema guard is satisfied by Task 1's repairs.

- [ ] **Step 2: Review the diff against spec 14 item 2**

`git log --oneline origin/conner/image-pipeline-health-pr1..HEAD` shows nine commits (Tasks 1 to 9). `git diff --stat` touches `packages/api`, `packages/engine/src/errors.ts`, `packages/sandbox-kubernetes/src/{manifest,lifecycle,index}.ts`, and `packages/api/migrations/pg/0000_app.sql`.

- [ ] **Step 3: Open the PR**

Write the body to a file first and lint it: `printf '%s' "$(cat body.md)" | python3 scripts/docs/pr_description_lint.py`. Keep it under 300 words with a `## Validation` section listing the commands above and their counts. Then:

```bash
git push -u origin conner/image-pipeline-health-pr2
gh pr create -R tkhq/valet --base conner/image-pipeline-health-pr1 --title "Sandbox images: runtime contract, source health, and session fallback (image pipeline health, PR 2 of 4)" --body-file body.md
```

Body outline (prose, not this list): Problem (sessions bound to a pre-contract image failed; nothing recorded why a source was unhealthy); Fix (contract stamped from the label and backfilled by lineage; `compatible()` gates scheduler and session start; fallback to base then stock with the agent told; health columns); Deployment note (the first scheduler pass after deploy marks every source built before 2026-10-26 15:20 UTC `incompatible` and rebakes it on a `-c3` tag; sessions bound to them run on the stock image until the push; schema repairs run at API boot, remediation rollback off); Validation. After #1071 merges, retarget this PR to `dev-v2`.

Pushing and the signed commits need a Yubikey tap; announce before each.

---

## Self-review notes

- Spec 14 item 2, each mapped: schema repairs with backfill (Task 1); `SANDBOX_IMAGE_CONTRACT`/`MIN_IMAGE_CONTRACT` (Task 2); post-push label read (Task 3); `parent_bake_id`/`base_image_ref` (Task 3); `setSourceHealth` and call sites (Task 4); `contract_changed` and the tag change replacing the identity change (Task 5, refinement 1); gates in both resolvers with the callback (Task 6); `image_fallback` and its clearing (Task 7); startup warning paragraph (Task 8); `image_fallback` counter (Task 7); in-process last-pass timestamp (Task 4). PR 1 carry-overs (Task 9).
- Names used across tasks: `compatible`, `readImageContractLabel`, `ContractRead`, `CONTRACT_LABEL`, `MIN_IMAGE_CONTRACT`, `setSourceHealth`, `healthReasonForError`, `pendingHealth`, `stampContract`, `contractReader`, `recordSchedulerPass`/`lastSchedulerPassAt`, `IncompatibleImage`, `OnIncompatibleImage`, `contractGateApplies`, `repoBakeCompatibility`, `ImageFallbackEvent`, `setImageFallbackHandler`, `recordImageFallback` (host method and metric function share the name in different modules; the host one is private), `handleImageFallback`, `imageFallbackPrompt`, `repoImageFallbackRepo`. Each is defined in the task that first introduces it.
- Review Focus lines: 1 is Task 6's `it.each` plus the override case; 2 is Task 2's index test; 3 is Task 6's docker test and Task 3's docker reader; 4 is Task 7's three-call handler test; 5 is Task 1's `repo-ext-1` and `repo-orphan-1` rows.
- Deferred to PR 3: `SourceSummary`/`BakeSummary` wire fields, the sources page and banner, admin notifications on health transitions, the sources and scheduler-age gauges.
- Spec amendments to make when this PR merges: 5.4 backfill as one statement; 6.3 tag suffix instead of identity term; 7.1 handler wiring; 7.2 build-time paragraph; 8.7 `capacity` kind and `reason` → `kind` label name; the PR 1 notes under 8.4 and 8.5.
