# Workflow Triggers UI + Workflows Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose workflow schedules and event triggers over REST, and redesign the web Workflows page into a tabbed hub (Workflows | Runs | Triggers).

**Architecture:** Aggregated read + kind-specific writes. New REST routes wrap the existing `schedule-service` / `trigger-service` / `WorkflowScheduler`; no storage changes, no scheduler-loop changes. The web page becomes a three-tab hub backed by new query hooks.

**Tech Stack:** Hono, Drizzle, PGlite (tests via `bootTestApi`), React 19, TanStack Router/Query, Tailwind, vitest.

**Spec:** `docs/specs/2026-08-15-workflow-triggers-ui-design.md`

## Global Constraints

- Branch `conner/workflow-triggers-ui`, PR target `dev-v2`. Worktree: `/Users/conner/code/valet/.claude/worktrees/workflow-triggers-ui`.
- Node 22 (`nvm use 22`). `WebSocket is not defined` failures mean wrong Node, not a regression.
- No `any`; no `as unknown as T`; no `@ts-ignore`. Build full shapes in tests.
- Every user-facing error message names the corrective action when one exists.
- No new migration files (pre-1.0 rule) — this plan adds NO schema changes at all.
- Commit subjects ≤72 chars.
- vitest filters: `pnpm --filter @valet/api test <filter>` — NEVER put `--` before the filter (vitest drops args after `--` and runs the full suite).
- Run all commands from the worktree root above.

## Existing interfaces you will consume (already on dev-v2)

- `packages/api/src/workflows/schedule-service.ts`: `nextFireAt(cron, timezone, from) → {ok:true; at} | {ok:false; error}`, `createWorkflowSchedule(db, user, input, now?)`, `listWorkflowSchedules(db, orgId, workflowId?)`, `deleteWorkflowSchedule(db, orgId, scheduleId) → "ok" | "not_found"`, `WorkflowScheduleSummary { scheduleId, targetKind, workflowId?, prompt?, name, cron, timezone, enabled, input?, lastFiredAt, nextFireAt }`.
- `packages/api/src/workflows/trigger-service.ts`: `createWorkflowTrigger(db, plugins, user, input)`, `listWorkflowTriggers(db, orgId, workflowId?)`, `deleteWorkflowTrigger(db, orgId, triggerId)`, `listEventTypes(plugins) → EventTypeCatalog[]`, `WorkflowTriggerSummary { triggerId, workflowId, name, eventKeys, filters, enabled }`.
- `packages/api/src/workflows/scheduler.ts`: `WorkflowScheduler` (deps `{ db, workflowStore, workflowRunHost, deliverToOrchestrator, now? }`), `scheduledRunId(scheduleId, slotMs)`.
- `packages/api/src/workflows/service.ts`: `WorkflowServiceDeps`, `WorkflowOwner { userId, orgId }`, `listWorkflowDefinitions(deps, owner)`, `deleteWorkflowDefinition(deps, owner, id)`.
- Test harness: `bootTestApi({ plugins })` from `packages/api/src/integration/_setup.ts` (see `packages/api/src/routes/events.test.ts` for the idiom: boot, hit HTTP with `fetch`, seed rows through `api.providers.db`, cleanup in `afterEach`).
- Web: `api` client in `packages/web/src/api/client.ts` (`request<T>(method, path, body?)`), hooks pattern in `packages/web/src/api/workflows.ts` (`qkWorkflows` key factory), primitives `Button, Badge, Dialog, Input, Label, Switch, Spinner` from `~/components/primitives`.

---

### Task 1: `updateWorkflowSchedule` in schedule-service

**Files:**
- Modify: `packages/api/src/workflows/schedule-service.ts`
- Test: `packages/api/src/workflows/schedule-service.db.test.ts` (new — the existing `schedule-service.test.ts` is pure-function only; DB-backed tests get their own file)

**Interfaces:**
- Consumes: existing `nextFireAt`, `rowToSummary`, drizzle `workflowSchedules`.
- Produces: `updateWorkflowSchedule(db, orgId, scheduleId, patch, now?) → Promise<{ ok: true; schedule: WorkflowScheduleSummary } | { ok: false; status: 400 | 404; error: string }>` where `patch = { name?: string; cron?: string; timezone?: string; enabled?: boolean; prompt?: string; input?: unknown }`. Target kind is immutable (delete + recreate to switch; the spec's "partial update of the same fields" is resolved this way — kind-switching is ambiguous with the exactly-one-of workflowId/prompt invariant).

- [ ] **Step 1: Write the failing tests**

Use the DB helper the other DB-backed workflow tests use: check `packages/api/src/workflows/pg-store.test.ts` for how it gets a drizzle `AppDb` over fresh PGlite (`freshTestPgDb` from `../test-helpers/pg-test-db.js`) and copy that boot/cleanup shape exactly. Seed an org/user row the same way that file does if FK constraints require it; then create a schedule via `createWorkflowSchedule`.

```typescript
// packages/api/src/workflows/schedule-service.db.test.ts
import { describe, expect, it } from "vitest";
import {
  createWorkflowSchedule,
  updateWorkflowSchedule,
  nextFireAt,
} from "./schedule-service.js";

// boot boilerplate: copy from pg-store.test.ts (freshTestPgDb → db, cleanup)

const USER = { id: "user_1", orgId: "org_1" };
const NOW = Date.UTC(2026, 0, 15, 12, 30, 0);

describe("updateWorkflowSchedule", () => {
  it("updates name and enabled without recomputing nextFireAt", async () => {
    const created = await createWorkflowSchedule(
      db, USER, { prompt: "daily digest", name: "digest", cron: "0 9 * * *" }, NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const before = created.schedule.nextFireAt;

    const updated = await updateWorkflowSchedule(
      db, USER.orgId, created.schedule.scheduleId, { name: "morning digest", enabled: false }, NOW + 1000,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.schedule.name).toBe("morning digest");
    expect(updated.schedule.enabled).toBe(false);
    expect(updated.schedule.nextFireAt).toBe(before);
  });

  it("recomputes nextFireAt when cron changes", async () => {
    const created = await createWorkflowSchedule(
      db, USER, { prompt: "p", name: "s", cron: "0 9 * * *" }, NOW,
    );
    if (!created.ok) throw new Error(created.error);

    const updated = await updateWorkflowSchedule(
      db, USER.orgId, created.schedule.scheduleId, { cron: "0 18 * * *" }, NOW,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const expected = nextFireAt("0 18 * * *", "UTC", NOW);
    if (!expected.ok) throw new Error(expected.error);
    expect(updated.schedule.nextFireAt).toBe(expected.at);
  });

  it("recomputes nextFireAt on re-enable so a stale slot does not fire immediately", async () => {
    const created = await createWorkflowSchedule(
      db, USER, { prompt: "p", name: "s", cron: "0 9 * * *" }, NOW,
    );
    if (!created.ok) throw new Error(created.error);
    await updateWorkflowSchedule(db, USER.orgId, created.schedule.scheduleId, { enabled: false }, NOW);

    const later = NOW + 7 * 24 * 3600 * 1000;
    const updated = await updateWorkflowSchedule(
      db, USER.orgId, created.schedule.scheduleId, { enabled: true }, later,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.schedule.nextFireAt).toBeGreaterThan(later);
  });

  it("rejects an invalid cron with a corrective error and 400", async () => {
    const created = await createWorkflowSchedule(
      db, USER, { prompt: "p", name: "s", cron: "0 9 * * *" }, NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const updated = await updateWorkflowSchedule(
      db, USER.orgId, created.schedule.scheduleId, { cron: "not a cron" }, NOW,
    );
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.status).toBe(400);
    expect(updated.error).toContain("5-field");
  });

  it("returns 404 for an unknown id or another org's schedule", async () => {
    const missing = await updateWorkflowSchedule(db, USER.orgId, "nope", { name: "x" }, NOW);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    const created = await createWorkflowSchedule(
      db, USER, { prompt: "p", name: "s", cron: "0 9 * * *" }, NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const crossOrg = await updateWorkflowSchedule(
      db, "org_other", created.schedule.scheduleId, { name: "x" }, NOW,
    );
    expect(crossOrg.ok).toBe(false);
    if (!crossOrg.ok) expect(crossOrg.status).toBe(404);
  });

  it("rejects prompt on a workflow-target schedule", async () => {
    // seed a workflow definition row through drizzle (id "wf_1", orgId "org_1")
    // — copy the insert shape from events.test.ts's workflowDefinitions seed.
    const created = await createWorkflowSchedule(
      db, USER, { workflowId: "wf_1", name: "s", cron: "0 9 * * *" }, NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const updated = await updateWorkflowSchedule(
      db, USER.orgId, created.schedule.scheduleId, { prompt: "nope" }, NOW,
    );
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.status).toBe(400);
    expect(updated.error).toContain("orchestrator");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @valet/api test schedule-service.db`
Expected: FAIL — `updateWorkflowSchedule` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/api/src/workflows/schedule-service.ts`:

```typescript
export interface WorkflowSchedulePatch {
  name?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  prompt?: string;
  input?: unknown;
}

/**
 * Partial update. Target kind is immutable — delete and recreate to switch.
 * `nextFireAt` is recomputed when cron/timezone change or when the schedule
 * transitions disabled → enabled (so a stale slot does not fire at once).
 */
export async function updateWorkflowSchedule(
  db: AppDb,
  orgId: string,
  scheduleId: string,
  patch: WorkflowSchedulePatch,
  now = Date.now(),
): Promise<
  | { ok: true; schedule: WorkflowScheduleSummary }
  | { ok: false; status: 400 | 404; error: string }
> {
  const rows = await db
    .select()
    .from(workflowSchedules)
    .where(and(eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.orgId, orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "schedule not found" };

  if (patch.prompt !== undefined && row.targetKind !== "orchestrator") {
    return {
      ok: false,
      status: 400,
      error: "prompt only applies to orchestrator-target schedules. Delete this schedule and create an orchestrator one to switch.",
    };
  }
  if (patch.input !== undefined && row.targetKind !== "workflow") {
    return {
      ok: false,
      status: 400,
      error: "input only applies to workflow-target schedules. Delete this schedule and create a workflow one to switch.",
    };
  }
  if (patch.prompt !== undefined && patch.prompt.trim() === "") {
    return { ok: false, status: 400, error: "prompt must not be empty. Provide the text to send to the orchestrator." };
  }

  const cron = patch.cron ?? row.cron;
  const timezone = patch.timezone ?? row.timezone;
  const cronOrTzChanged = cron !== row.cron || timezone !== row.timezone;
  const reEnabled = patch.enabled === true && !row.enabled;

  let nextAt = row.nextFireAt;
  if (cronOrTzChanged || reEnabled) {
    const next = nextFireAt(cron, timezone, now);
    if (!next.ok) return { ok: false, status: 400, error: next.error };
    nextAt = next.at;
  }

  const updated = await db
    .update(workflowSchedules)
    .set({
      name: patch.name ?? row.name,
      cron,
      timezone,
      enabled: patch.enabled ?? row.enabled,
      prompt: patch.prompt ?? row.prompt,
      input: patch.input !== undefined ? patch.input : row.input,
      nextFireAt: nextAt,
      updatedAt: now,
    })
    .where(eq(workflowSchedules.id, scheduleId))
    .returning();
  return { ok: true, schedule: rowToSummary(updated[0]!) };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @valet/api test schedule-service`
Expected: PASS (both the pure-function file and the new DB file).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/workflows/schedule-service.ts packages/api/src/workflows/schedule-service.db.test.ts
git commit -m "feat(api): updateWorkflowSchedule with next-fire recompute"
```

---

### Task 2: `WorkflowScheduler.fireNow` (manual fire)

**Files:**
- Modify: `packages/api/src/workflows/scheduler.ts`
- Test: `packages/api/src/workflows/scheduler.fire-now.test.ts` (new; if an existing `scheduler`-adjacent DB test exists on this branch, put the cases beside its harness instead)

**Interfaces:**
- Consumes: existing private `fire()` internals; `scheduledRunId`.
- Produces: `WorkflowScheduler.fireNow(orgId: string, scheduleId: string): Promise<"ok" | "not_found" | { error: string }>`. Fire-now does NOT advance `nextFireAt` and does not require `enabled`.

- [ ] **Step 1: Refactor `fire()` to extract the dispatch half (no behavior change)**

In `scheduler.ts`, split `fire()`:

```typescript
  /** Dispatch one fire for `slotMs`. Shared by the poll loop (slot =
   * next_fire_at) and fireNow (slot = now → a distinct, still-idempotent
   * runId per manual fire). Returns an error string for states the poll
   * loop responds to by disabling. Does NOT touch next_fire_at. */
  private async dispatch(
    schedule: typeof workflowSchedules.$inferSelect,
    slotMs: number,
  ): Promise<"ok" | { error: string }> {
    const { db, workflowRunHost } = this.deps;

    if (schedule.targetKind === "orchestrator") {
      if (!schedule.prompt || schedule.prompt.trim() === "") {
        return { error: "orchestrator target without a prompt. Edit the schedule and set a prompt." };
      }
      await this.deps.deliverToOrchestrator({
        orgId: schedule.orgId,
        ownerType: schedule.ownerType,
        ownerId: schedule.ownerId,
        signal: {
          kind: "signal",
          signalType: "schedule",
          body: schedule.prompt,
          attributes: {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            cron: schedule.cron,
            firedAt: new Date(slotMs).toISOString(),
          },
        },
        dispatchId: `schedule:${schedule.id}:${slotMs}`,
      });
      return "ok";
    }

    if (!schedule.workflowId) {
      return { error: "workflow target without a workflow_id. Delete this schedule and recreate it against a workflow." };
    }
    const defRows = await db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, schedule.workflowId), eq(workflowDefinitions.orgId, schedule.orgId)))
      .limit(1);
    const def = defRows[0];
    if (!def) {
      return { error: `workflow ${schedule.workflowId} is gone. Delete this schedule or recreate the workflow.` };
    }

    const runId = scheduledRunId(schedule.id, slotMs);
    const existing = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (existing.length === 0) {
      const trigger: WorkflowTriggerPayload = {
        type: "schedule",
        triggerId: schedule.id,
        timestamp: new Date(slotMs).toISOString(),
        data: { scheduleName: schedule.name, cron: schedule.cron, input: schedule.input ?? {} },
        metadata: { scheduleId: schedule.id, timezone: schedule.timezone },
      };
      const params: RunParams = {
        workflowId: schedule.workflowId,
        definitionVersionId: definitionVersionId(def.definition),
        triggerId: schedule.id,
        input: trigger,
      };
      await workflowRunHost.start(runId, params, def.definition, {
        ownerType: schedule.ownerType,
        ownerId: schedule.ownerId,
      });
    }
    return "ok";
  }
```

Rewrite `fire()` to keep its exact current semantics on top of `dispatch`:

```typescript
  private async fire(schedule: typeof workflowSchedules.$inferSelect, now: number): Promise<void> {
    const { db } = this.deps;
    const next = nextFireAt(schedule.cron, schedule.timezone, now);
    if (!next.ok) {
      console.error(`workflow scheduler: disabling ${schedule.id} — ${next.error}`);
      await db.update(workflowSchedules).set({ enabled: false, updatedAt: now }).where(eq(workflowSchedules.id, schedule.id));
      return;
    }
    const result = await this.dispatch(schedule, schedule.nextFireAt);
    if (result !== "ok") {
      console.error(`workflow scheduler: disabling ${schedule.id} — ${result.error}`);
      await db.update(workflowSchedules).set({ enabled: false, updatedAt: now }).where(eq(workflowSchedules.id, schedule.id));
      return;
    }
    await db
      .update(workflowSchedules)
      .set({ lastFiredAt: now, nextFireAt: next.at, updatedAt: now })
      .where(eq(workflowSchedules.id, schedule.id));
  }
```

Then add the public method:

```typescript
  /** Manual fire from the API. Uses `now` as the slot (distinct idempotent
   * runId per press), updates lastFiredAt, never moves nextFireAt, and
   * works on disabled schedules (firing by hand is how you test one). */
  async fireNow(orgId: string, scheduleId: string): Promise<"ok" | "not_found" | { error: string }> {
    const { db } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const rows = await db
      .select()
      .from(workflowSchedules)
      .where(and(eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.orgId, orgId)))
      .limit(1);
    const schedule = rows[0];
    if (!schedule) return "not_found";
    const result = await this.dispatch(schedule, now);
    if (result !== "ok") return result;
    await db
      .update(workflowSchedules)
      .set({ lastFiredAt: now, updatedAt: now })
      .where(eq(workflowSchedules.id, scheduleId));
    return "ok";
  }
```

- [ ] **Step 2: Verify no regression in existing scheduler behavior**

Run: `pnpm --filter @valet/api test scheduler`
Expected: PASS (existing `scheduler`-matching suites still green after the refactor).

- [ ] **Step 3: Write fireNow tests**

Harness: same PGlite + drizzle boot as Task 1's DB test. Build the scheduler with stub deps — `deliverToOrchestrator` as a recording `vi.fn()`, `workflowRunHost` as `{ start: vi.fn(), wake: vi.fn(), scheduleWake: vi.fn(), terminate: vi.fn(), startHost: vi.fn(), stopHost: vi.fn() }` typed against `RunHost` (build the full shape — no casts), `workflowStore` from the pg-store over the same db (copy construction from `pg-store.test.ts`), and `now: () => FIXED_NOW`.

```typescript
// packages/api/src/workflows/scheduler.fire-now.test.ts — cases:
it("fires an orchestrator schedule and does not advance nextFireAt", async () => {
  // seed schedule via createWorkflowSchedule (prompt target)
  const result = await scheduler.fireNow("org_1", scheduleId);
  expect(result).toBe("ok");
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0][0].dispatchId).toBe(`schedule:${scheduleId}:${FIXED_NOW}`);
  const after = (await listWorkflowSchedules(db, "org_1"))[0]!;
  expect(after.nextFireAt).toBe(before.nextFireAt); // unchanged
  expect(after.lastFiredAt).toBe(FIXED_NOW);
});

it("fires a workflow schedule through runHost.start with the derived runId", async () => {
  // seed workflowDefinitions row + workflow-target schedule
  const result = await scheduler.fireNow("org_1", scheduleId);
  expect(result).toBe("ok");
  expect(runHost.start).toHaveBeenCalledTimes(1);
  expect(runHost.start.mock.calls[0][0]).toBe(scheduledRunId(scheduleId, FIXED_NOW));
});

it("returns not_found for cross-org and unknown ids", async () => {
  expect(await scheduler.fireNow("org_other", scheduleId)).toBe("not_found");
  expect(await scheduler.fireNow("org_1", "nope")).toBe("not_found");
});

it("fires a disabled schedule (manual fire is the test path)", async () => {
  // disable via updateWorkflowSchedule, then fireNow → "ok"
});
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @valet/api test fire-now`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/workflows/scheduler.ts packages/api/src/workflows/scheduler.fire-now.test.ts
git commit -m "feat(api): WorkflowScheduler.fireNow for manual schedule fires"
```

---

### Task 3: `updateWorkflowTrigger` in trigger-service

**Files:**
- Modify: `packages/api/src/workflows/trigger-service.ts`
- Test: `packages/api/src/workflows/trigger-service.test.ts` (create if absent; same PGlite harness as Task 1, real `githubPlugin` from `@valet/plugin-github/plugin` for `validateSubscription`)

**Interfaces:**
- Produces: `updateWorkflowTrigger(db, plugins, orgId, triggerId, patch) → Promise<{ ok: true; trigger: WorkflowTriggerSummary } | { ok: false; status: 400 | 404; error: string }>` where `patch = { name?: string; eventKeys?: string[]; filters?: unknown[]; enabled?: boolean }`.

- [ ] **Step 1: Write the failing tests**

```typescript
it("updates name/eventKeys/enabled and returns the summary", async () => {
  // seed workflowDefinitions row, createWorkflowTrigger with
  // eventKeys: ["github.pull_request.opened"]
  const updated = await updateWorkflowTrigger(db, [githubPlugin], "org_1", triggerId, {
    name: "renamed", enabled: false,
  });
  expect(updated.ok).toBe(true);
  if (updated.ok) {
    expect(updated.trigger.name).toBe("renamed");
    expect(updated.trigger.enabled).toBe(false);
  }
});

it("re-validates merged eventKeys/filters and 400s with the validator message", async () => {
  const updated = await updateWorkflowTrigger(db, [githubPlugin], "org_1", triggerId, {
    eventKeys: ["github.no_such_event"],
  });
  expect(updated.ok).toBe(false);
  if (!updated.ok) expect(updated.status).toBe(400);
});

it("404s for unknown ids, cross-org rows, and non-workflow subscriptions", async () => {
  // seed a raw eventSubscriptions row with target {kind:"orchestrator"} and
  // assert updateWorkflowTrigger on its id → 404 (this seam must not manage
  // orchestrator subscriptions — same rule as deleteWorkflowTrigger).
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @valet/api test trigger-service`

- [ ] **Step 3: Implement**

```typescript
export interface WorkflowTriggerPatch {
  name?: string;
  eventKeys?: string[];
  filters?: unknown[];
  enabled?: boolean;
}

export async function updateWorkflowTrigger(
  db: AppDb,
  plugins: ValetPlugin[],
  orgId: string,
  triggerId: string,
  patch: WorkflowTriggerPatch,
): Promise<
  | { ok: true; trigger: WorkflowTriggerSummary }
  | { ok: false; status: 400 | 404; error: string }
> {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, orgId)))
    .limit(1);
  const row = rows[0];
  const current = row ? rowToTrigger(row) : null;
  if (!row || !current) return { ok: false, status: 404, error: "trigger not found" };

  const name = patch.name ?? current.name;
  const eventKeys = patch.eventKeys ?? current.eventKeys;
  const filters = patch.filters ?? current.filters;
  const error = validateSubscription(plugins, {
    name,
    eventKeys,
    filters,
    target: { kind: "workflow", workflowId: current.workflowId },
  });
  if (error) return { ok: false, status: 400, error };

  const updated = await db
    .update(eventSubscriptions)
    .set({ name, eventKeys, filters, enabled: patch.enabled ?? current.enabled, updatedAt: Date.now() })
    .where(eq(eventSubscriptions.id, triggerId))
    .returning();
  const trigger = rowToTrigger(updated[0]!);
  if (!trigger) return { ok: false, status: 400, error: "trigger update produced an unexpected row shape" };
  return { ok: true, trigger };
}
```

- [ ] **Step 4: Run, verify PASS** — `pnpm --filter @valet/api test trigger-service`

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/workflows/trigger-service.ts packages/api/src/workflows/trigger-service.test.ts
git commit -m "feat(api): updateWorkflowTrigger partial update"
```

---

### Task 4: Trigger cleanup on workflow delete + global runs service

**Files:**
- Modify: `packages/api/src/workflows/service.ts`
- Test: extend the suite that covers `deleteWorkflowDefinition` (find it: `grep -rln "deleteWorkflowDefinition" packages/api/src --include="*.test.ts"`); global-runs cases go in Task 5's route tests.

**Interfaces:**
- Produces: `listRecentWorkflowRuns(deps, owner, limit) → Promise<GlobalWorkflowRunSummary[]>` with `GlobalWorkflowRunSummary = WorkflowRunSummary & { workflowName: string }` (newest first). `deleteWorkflowDefinition` additionally deletes the workflow's schedules and workflow-target event subscriptions.

- [ ] **Step 1: Write failing test for trigger cleanup**

In the existing delete suite, add: create a definition, add a schedule (via `createWorkflowSchedule` with its `workflowId`) and an event trigger (via `createWorkflowTrigger`), delete the definition, then assert both `workflow_schedules` and `eventSubscriptions` no longer contain rows referencing it (query through drizzle).

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

In `deleteWorkflowDefinition`, after the existing definition delete succeeds (and only on the `"ok"` path), add:

```typescript
  // Triggers must not outlive the workflow: orphaned schedules would be
  // disabled by the scheduler eventually, but the triggers list would show
  // ghosts until then. Event subscriptions targeting the workflow are
  // app-db rows with no FK, so remove them explicitly.
  await deps.db.delete(workflowSchedules).where(eq(workflowSchedules.workflowId, id));
  const subs = await deps.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.orgId, owner.orgId));
  for (const sub of subs) {
    const target = sub.target as { kind?: string; workflowId?: string };
    if (target?.kind === "workflow" && target.workflowId === id) {
      await deps.db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, sub.id));
    }
  }
```

(Import `workflowSchedules`, `eventSubscriptions` from `../schema/index.js`.)

Then add the global runs read, mirroring `listWorkflowRuns`'s store-backed shape:

```typescript
export interface GlobalWorkflowRunSummary extends WorkflowRunSummary {
  workflowName: string;
}

export async function listRecentWorkflowRuns(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  limit = 50,
): Promise<GlobalWorkflowRunSummary[]> {
  const defs = await listWorkflowDefinitions(deps, owner);
  if (defs.length === 0) return [];
  const nameById = new Map(defs.map((d) => [d.id, d.name]));

  const runRows = await deps.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(inArray(workflowRuns.workflowId, [...nameById.keys()]))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit);

  const runs: GlobalWorkflowRunSummary[] = [];
  for (const r of runRows) {
    const run = await deps.workflowStore.getRun(r.id);
    if (!run) continue;
    runs.push({
      runId: run.runId,
      workflowId: run.params.workflowId,
      workflowName: nameById.get(run.params.workflowId) ?? run.params.workflowId,
      status: run.status,
      outcome: run.outcome,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
  }
  return runs;
}
```

(Add `inArray` to the drizzle import.)

- [ ] **Step 4: Run, verify PASS** — the delete suite plus `pnpm --filter @valet/api typecheck` if the package has one (else `pnpm typecheck`).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/workflows/service.ts <the-delete-test-file>
git commit -m "feat(api): delete workflow triggers with the workflow; global runs read"
```

---

### Task 5: Wire types + REST routes + mount

**Files:**
- Modify: `packages/api/src/wire/types.ts`
- Create: `packages/api/src/routes/workflow-triggers.ts`
- Modify: `packages/api/src/app.ts` (mount BEFORE `workflowsRouter` — see step 3)
- Test: `packages/api/src/routes/workflow-triggers.test.ts` (via `bootTestApi`, idiom of `events.test.ts`)

**Interfaces:**
- Consumes: Tasks 1–4 exports; `providers.workflowScheduler` and `providers.plugins` off `c.var.providers` (both exist on the `Providers` type — scheduler at `providers/node.ts:416`, plugins at `providers/types.ts:72`).
- Produces (wire): the request/response types below, consumed verbatim by the web client in Task 6.

- [ ] **Step 1: Add wire types**

Append to `packages/api/src/wire/types.ts` next to the workflow types (~line 770):

```typescript
// ── Workflow triggers (spec 2026-08-15) ──────────────────────────────────

export interface WorkflowScheduleTriggerDetail {
  cron: string;
  timezone: string;
  targetKind: "workflow" | "orchestrator";
  prompt?: string;
  input?: unknown;
  nextFireAt: number;
  lastFiredAt: number | null;
}

export interface WorkflowEventTriggerDetail {
  eventKeys: string[];
  filters: unknown[];
}

export type WorkflowTriggerItem =
  | {
      kind: "schedule";
      id: string;
      workflowId?: string;
      name: string;
      enabled: boolean;
      detail: WorkflowScheduleTriggerDetail;
    }
  | {
      kind: "event";
      id: string;
      workflowId: string;
      name: string;
      enabled: boolean;
      detail: WorkflowEventTriggerDetail;
    };

export interface ListWorkflowTriggersResponse {
  triggers: WorkflowTriggerItem[];
}

export type CreateWorkflowScheduleRequest = {
  name: string;
  cron: string;
  timezone?: string;
} & (
  | { target: { kind: "workflow"; workflowId: string; input?: unknown } }
  | { target: { kind: "orchestrator"; prompt: string } }
);

export interface UpdateWorkflowScheduleRequest {
  name?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  prompt?: string;
  input?: unknown;
}

export interface WorkflowScheduleResponse {
  schedule: {
    scheduleId: string;
    targetKind: "workflow" | "orchestrator";
    workflowId?: string;
    prompt?: string;
    name: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    input?: unknown;
    lastFiredAt: number | null;
    nextFireAt: number;
  };
}

export interface CreateWorkflowEventTriggerRequest {
  workflowId: string;
  name: string;
  eventKeys: string[];
  filters?: unknown[];
}

export interface UpdateWorkflowEventTriggerRequest {
  name?: string;
  eventKeys?: string[];
  filters?: unknown[];
  enabled?: boolean;
}

export interface WorkflowEventTriggerResponse {
  trigger: {
    triggerId: string;
    workflowId: string;
    name: string;
    eventKeys: string[];
    filters: unknown[];
    enabled: boolean;
  };
}

export interface WorkflowTriggerCatalogEntry {
  key: string;
  description: string;
  filters: { field: string; description: string }[];
}

export interface GetWorkflowTriggerCatalogResponse {
  catalog: { service: string; entries: WorkflowTriggerCatalogEntry[] }[];
}

export interface GlobalWorkflowRunSummary extends WorkflowRunSummary {
  workflowName: string;
}

export interface ListAllWorkflowRunsResponse {
  runs: GlobalWorkflowRunSummary[];
}
```

- [ ] **Step 2: Write the failing route tests**

`packages/api/src/routes/workflow-triggers.test.ts`, `bootTestApi({ plugins: [githubPlugin] })` (import from `@valet/plugin-github/plugin`), following `events.test.ts` exactly (boot per test, `afterEach` cleanup, seed via `api.providers.db`). Cases — write each as a real test now, not later:

1. `POST /api/workflows/schedules` with an orchestrator target → 201, body has `schedule.nextFireAt > now`, `targetKind: "orchestrator"`.
2. `POST /api/workflows/schedules` with cron `"bad"` → 400 and `error` contains `"5-field"` and an example (route appends the example — see step 3).
3. `POST /api/workflows/schedules` with both/neither of workflowId+prompt → 400 (service's exactly-one-of message passes through).
4. `GET /api/workflows/triggers` after seeding one schedule + one event trigger (seed a `workflowDefinitions` row first, copy the insert from `events.test.ts`) → both items present with correct `kind` discriminants; schedule item carries `detail.cron`.
5. `GET /api/workflows/triggers?workflowId=wf_1` → only wf_1's triggers; the orchestrator-target schedule (no workflowId) is excluded.
6. `PATCH /api/workflows/schedules/:id` `{ enabled: false }` → 200; unknown id → 404.
7. `DELETE /api/workflows/schedules/:id` → 200 `{ ok: true }`; second delete → 404.
8. `POST /api/workflows/schedules/:id/run` on a workflow-target schedule → 200 `{ ok: true }` and a `workflow_runs` row exists whose id starts with `wfrun_sch_` (query drizzle).
9. `POST/PATCH/DELETE /api/workflows/event-triggers` round trip incl. validator 400 on a bogus event key.
10. `GET /api/workflows/trigger-catalog` → 200, catalog contains a `github` service entry.
11. `GET /api/workflows/runs` → 200 with `runs: []` on a fresh org — this asserts route precedence, i.e. it is NOT swallowed by `workflowsRouter`'s `GET /:id` returning "workflow not found". Then seed a definition + start a run via `POST /api/workflows/:id/runs` and assert the run appears with `workflowName`.
12. Cross-org invisibility: seed a schedule row with `orgId: "org_other"` directly through drizzle; `GET /api/workflows/triggers` must not include it; `PATCH`/`DELETE` on its id → 404.

- [ ] **Step 3: Run, verify FAIL, then implement the router**

Run: `pnpm --filter @valet/api test workflow-triggers` → FAIL (404s: router absent).

Create `packages/api/src/routes/workflow-triggers.ts`:

```typescript
/**
 * `/api/workflows/{triggers,schedules,event-triggers,trigger-catalog,runs}`
 * (spec 2026-08-15). Aggregated trigger read + kind-specific writes over
 * `schedule-service` / `trigger-service` / `WorkflowScheduler.fireNow`.
 *
 * MOUNT ORDER MATTERS: this router must be mounted on `/api/workflows`
 * BEFORE `workflowsRouter`, whose `GET /:id` would otherwise swallow
 * `/triggers` and `/runs` as workflow ids.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
  updateWorkflowSchedule,
} from "../workflows/schedule-service.js";
import {
  createWorkflowTrigger,
  deleteWorkflowTrigger,
  listEventTypes,
  listWorkflowTriggers,
  updateWorkflowTrigger,
} from "../workflows/trigger-service.js";
import { listRecentWorkflowRuns } from "../workflows/service.js";
import type {
  CreateWorkflowEventTriggerRequest,
  CreateWorkflowScheduleRequest,
  GetWorkflowTriggerCatalogResponse,
  ListAllWorkflowRunsResponse,
  ListWorkflowTriggersResponse,
  UpdateWorkflowEventTriggerRequest,
  UpdateWorkflowScheduleRequest,
  WorkflowEventTriggerResponse,
  WorkflowScheduleResponse,
  WorkflowTriggerItem,
} from "../wire/types.js";

export const workflowTriggersRouter = new Hono<AppEnv>();

const CRON_HINT = " Use 5 fields, for example \"0 9 * * 1-5\" (09:00 on weekdays).";

/** Cron/timezone service errors get the example appended once. */
function withCronHint(error: string): string {
  return error.includes("cron") ? error + CRON_HINT : error;
}

workflowTriggersRouter.get("/triggers", async (c) => {
  const { db } = c.var.providers;
  const orgId = c.var.user.orgId;
  const workflowId = c.req.query("workflowId") || undefined;

  const [schedules, events] = await Promise.all([
    listWorkflowSchedules(db, orgId, workflowId),
    listWorkflowTriggers(db, orgId, workflowId),
  ]);
  const triggers: WorkflowTriggerItem[] = [
    ...schedules.map((s): WorkflowTriggerItem => ({
      kind: "schedule",
      id: s.scheduleId,
      workflowId: s.workflowId,
      name: s.name,
      enabled: s.enabled,
      detail: {
        cron: s.cron,
        timezone: s.timezone,
        targetKind: s.targetKind,
        prompt: s.prompt,
        input: s.input,
        nextFireAt: s.nextFireAt,
        lastFiredAt: s.lastFiredAt,
      },
    })),
    ...events.map((t): WorkflowTriggerItem => ({
      kind: "event",
      id: t.triggerId,
      workflowId: t.workflowId,
      name: t.name,
      enabled: t.enabled,
      detail: { eventKeys: t.eventKeys, filters: t.filters },
    })),
  ];
  const resp: ListWorkflowTriggersResponse = { triggers };
  return c.json(resp);
});

workflowTriggersRouter.get("/trigger-catalog", (c) => {
  const resp: GetWorkflowTriggerCatalogResponse = {
    catalog: listEventTypes(c.var.providers.plugins),
  };
  return c.json(resp);
});

workflowTriggersRouter.get("/runs", async (c) => {
  const { db, workflowStore, workflowRunHost, actionPluginByService } = c.var.providers;
  const owner = { userId: c.var.user.id, orgId: c.var.user.orgId };
  const rawLimit = Number(c.req.query("limit") ?? 50);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 200 ? rawLimit : 50;
  const runs = await listRecentWorkflowRuns(
    { db, workflowStore, workflowRunHost, actionPluginByService },
    owner,
    limit,
  );
  const resp: ListAllWorkflowRunsResponse = { runs };
  return c.json(resp);
});

// ── Schedules ────────────────────────────────────────────────────────────

workflowTriggersRouter.post("/schedules", async (c) => {
  const { db } = c.var.providers;
  const user = { id: c.var.user.id, orgId: c.var.user.orgId };

  let body: CreateWorkflowScheduleRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowScheduleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  if (!body.target || (body.target.kind !== "workflow" && body.target.kind !== "orchestrator")) {
    return c.json(
      { error: "target.kind must be \"workflow\" (start a run) or \"orchestrator\" (send a prompt)" },
      400,
    );
  }

  const result = await createWorkflowSchedule(db, user, {
    name: body.name,
    cron: body.cron,
    timezone: body.timezone,
    workflowId: body.target.kind === "workflow" ? body.target.workflowId : undefined,
    prompt: body.target.kind === "orchestrator" ? body.target.prompt : undefined,
    input: body.target.kind === "workflow" ? body.target.input : undefined,
  });
  if (!result.ok) return c.json({ error: withCronHint(result.error) }, 400);
  const resp: WorkflowScheduleResponse = { schedule: result.schedule };
  return c.json(resp, 201);
});

workflowTriggersRouter.patch("/schedules/:id", async (c) => {
  const { db } = c.var.providers;
  let body: UpdateWorkflowScheduleRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowScheduleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const result = await updateWorkflowSchedule(db, c.var.user.orgId, c.req.param("id"), body);
  if (!result.ok) return c.json({ error: withCronHint(result.error) }, result.status);
  const resp: WorkflowScheduleResponse = { schedule: result.schedule };
  return c.json(resp);
});

workflowTriggersRouter.delete("/schedules/:id", async (c) => {
  const { db } = c.var.providers;
  const result = await deleteWorkflowSchedule(db, c.var.user.orgId, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "schedule not found" }, 404);
  return c.json({ ok: true });
});

workflowTriggersRouter.post("/schedules/:id/run", async (c) => {
  const result = await c.var.providers.workflowScheduler.fireNow(
    c.var.user.orgId,
    c.req.param("id"),
  );
  if (result === "not_found") return c.json({ error: "schedule not found" }, 404);
  if (result !== "ok") return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

// ── Event triggers ───────────────────────────────────────────────────────

workflowTriggersRouter.post("/event-triggers", async (c) => {
  const { db, plugins } = c.var.providers;
  const user = { id: c.var.user.id, orgId: c.var.user.orgId };
  let body: CreateWorkflowEventTriggerRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowEventTriggerRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const result = await createWorkflowTrigger(db, plugins, user, {
    workflowId: body.workflowId,
    name: body.name,
    eventKeys: body.eventKeys,
    filters: body.filters,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  const resp: WorkflowEventTriggerResponse = { trigger: result.trigger };
  return c.json(resp, 201);
});

workflowTriggersRouter.patch("/event-triggers/:id", async (c) => {
  const { db, plugins } = c.var.providers;
  let body: UpdateWorkflowEventTriggerRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowEventTriggerRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const result = await updateWorkflowTrigger(db, plugins, c.var.user.orgId, c.req.param("id"), body);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const resp: WorkflowEventTriggerResponse = { trigger: result.trigger };
  return c.json(resp);
});

workflowTriggersRouter.delete("/event-triggers/:id", async (c) => {
  const { db } = c.var.providers;
  const result = await deleteWorkflowTrigger(db, c.var.user.orgId, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "trigger not found" }, 404);
  return c.json({ ok: true });
});

export type WorkflowTriggersRouter = typeof workflowTriggersRouter;
```

Note on `serviceCtx`: this router reads providers directly instead of importing `serviceCtx` from `routes/workflows.ts` because only `/runs` needs the service deps bundle; keep the one local construction there.

Mount in `packages/api/src/app.ts` — immediately BEFORE the existing line 203 `app.route("/api/workflows", workflowsRouter);`:

```typescript
  // Trigger routes first: workflowsRouter's `GET /:id` would otherwise
  // swallow `/triggers` and `/runs` as workflow ids.
  app.route("/api/workflows", workflowTriggersRouter);
  app.route("/api/workflows", workflowsRouter);
```

(Add the import at the top with the other route imports.)

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter @valet/api test workflow-triggers`
Expected: PASS, all 12 cases. Also run `pnpm --filter @valet/api test workflows` to confirm the existing workflows route suite still passes with the new mount order.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/wire/types.ts packages/api/src/routes/workflow-triggers.ts packages/api/src/app.ts packages/api/src/routes/workflow-triggers.test.ts
git commit -m "feat(api): REST routes for workflow triggers, schedules, global runs"
```

---

### Task 6: Web API client methods + query hooks

**Files:**
- Modify: `packages/web/src/api/client.ts` (after the existing workflows block, ~line 365)
- Modify: `packages/web/src/api/workflows.ts`

**Interfaces:**
- Consumes: Task 5 wire types via `@valet/api/wire`.
- Produces (client): `listWorkflowTriggers(workflowId?)`, `getWorkflowTriggerCatalog()`, `listAllWorkflowRuns(limit?)`, `createWorkflowSchedule(body)`, `updateWorkflowSchedule(id, body)`, `deleteWorkflowSchedule(id)`, `runWorkflowScheduleNow(id)`, `createWorkflowEventTrigger(body)`, `updateWorkflowEventTrigger(id, body)`, `deleteWorkflowEventTrigger(id)`.
- Produces (hooks): `useWorkflowTriggers(workflowId?)`, `useTriggerCatalog()`, `useAllWorkflowRuns()`, `useCreateSchedule()`, `useUpdateSchedule()`, `useDeleteSchedule()`, `useRunScheduleNow()`, `useCreateEventTrigger()`, `useUpdateEventTrigger()`, `useDeleteEventTrigger()`; new keys `qkWorkflows.triggers(workflowId?)`, `qkWorkflows.allRuns()`, `qkWorkflows.triggerCatalog()`.

- [ ] **Step 1: Add client methods**

```typescript
  // workflow triggers (spec 2026-08-15)
  listWorkflowTriggers: (workflowId?: string) =>
    request<ListWorkflowTriggersResponse>(
      "GET",
      `/workflows/triggers${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`,
    ),
  getWorkflowTriggerCatalog: () =>
    request<GetWorkflowTriggerCatalogResponse>("GET", "/workflows/trigger-catalog"),
  listAllWorkflowRuns: (limit?: number) =>
    request<ListAllWorkflowRunsResponse>("GET", `/workflows/runs${limit ? `?limit=${limit}` : ""}`),
  createWorkflowSchedule: (body: CreateWorkflowScheduleRequest) =>
    request<WorkflowScheduleResponse>("POST", "/workflows/schedules", body),
  updateWorkflowSchedule: (id: string, body: UpdateWorkflowScheduleRequest) =>
    request<WorkflowScheduleResponse>("PATCH", `/workflows/schedules/${encodeURIComponent(id)}`, body),
  deleteWorkflowSchedule: (id: string) =>
    request<{ ok: true }>("DELETE", `/workflows/schedules/${encodeURIComponent(id)}`),
  runWorkflowScheduleNow: (id: string) =>
    request<{ ok: true }>("POST", `/workflows/schedules/${encodeURIComponent(id)}/run`),
  createWorkflowEventTrigger: (body: CreateWorkflowEventTriggerRequest) =>
    request<WorkflowEventTriggerResponse>("POST", "/workflows/event-triggers", body),
  updateWorkflowEventTrigger: (id: string, body: UpdateWorkflowEventTriggerRequest) =>
    request<WorkflowEventTriggerResponse>("PATCH", `/workflows/event-triggers/${encodeURIComponent(id)}`, body),
  deleteWorkflowEventTrigger: (id: string) =>
    request<{ ok: true }>("DELETE", `/workflows/event-triggers/${encodeURIComponent(id)}`),
```

(Add the type imports to the file's `@valet/api/wire` import list.)

- [ ] **Step 2: Add hooks**

In `packages/web/src/api/workflows.ts` — keys first:

```typescript
  triggers: (workflowId?: string) => ["workflows", "triggers", workflowId ?? "all"] as const,
  allRuns: () => ["workflows", "all-runs"] as const,
  triggerCatalog: () => ["workflows", "trigger-catalog"] as const,
```

Reads:

```typescript
export function useWorkflowTriggers(
  workflowId?: string,
  opts?: Partial<UseQueryOptions<ListWorkflowTriggersResponse>>,
) {
  return useQuery<ListWorkflowTriggersResponse>({
    queryKey: qkWorkflows.triggers(workflowId),
    queryFn: () => api.listWorkflowTriggers(workflowId),
    ...opts,
  });
}

export function useTriggerCatalog() {
  return useQuery<GetWorkflowTriggerCatalogResponse>({
    queryKey: qkWorkflows.triggerCatalog(),
    queryFn: () => api.getWorkflowTriggerCatalog(),
    staleTime: 5 * 60_000, // plugin catalog changes only on deploy
  });
}

export function useAllWorkflowRuns(opts?: Partial<UseQueryOptions<ListAllWorkflowRunsResponse>>) {
  return useQuery<ListAllWorkflowRunsResponse>({
    queryKey: qkWorkflows.allRuns(),
    queryFn: () => api.listAllWorkflowRuns(),
    refetchInterval: 5000, // runs move; same cadence as run detail
    ...opts,
  });
}
```

Mutations — every trigger write invalidates every `triggers(...)` key via the `["workflows", "triggers"]` prefix:

```typescript
function useInvalidateTriggers() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["workflows", "triggers"] });
}

export function useCreateSchedule() {
  const invalidate = useInvalidateTriggers();
  return useMutation<WorkflowScheduleResponse, Error, CreateWorkflowScheduleRequest>({
    mutationFn: (body) => api.createWorkflowSchedule(body),
    onSuccess: invalidate,
  });
}

export function useUpdateSchedule() {
  const invalidate = useInvalidateTriggers();
  return useMutation<WorkflowScheduleResponse, Error, { id: string; body: UpdateWorkflowScheduleRequest }>({
    mutationFn: ({ id, body }) => api.updateWorkflowSchedule(id, body),
    onSuccess: invalidate,
  });
}

export function useDeleteSchedule() {
  const invalidate = useInvalidateTriggers();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteWorkflowSchedule(id),
    onSuccess: invalidate,
  });
}

export function useRunScheduleNow() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.runWorkflowScheduleNow(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflows", "triggers"] });
      void qc.invalidateQueries({ queryKey: qkWorkflows.allRuns() });
    },
  });
}

export function useCreateEventTrigger() {
  const invalidate = useInvalidateTriggers();
  return useMutation<WorkflowEventTriggerResponse, Error, CreateWorkflowEventTriggerRequest>({
    mutationFn: (body) => api.createWorkflowEventTrigger(body),
    onSuccess: invalidate,
  });
}

export function useUpdateEventTrigger() {
  const invalidate = useInvalidateTriggers();
  return useMutation<WorkflowEventTriggerResponse, Error, { id: string; body: UpdateWorkflowEventTriggerRequest }>({
    mutationFn: ({ id, body }) => api.updateWorkflowEventTrigger(id, body),
    onSuccess: invalidate,
  });
}

export function useDeleteEventTrigger() {
  const invalidate = useInvalidateTriggers();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteWorkflowEventTrigger(id),
    onSuccess: invalidate,
  });
}
```

(Add the new wire type imports.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/api/workflows.ts
git commit -m "feat(web): trigger + global-runs client methods and hooks"
```

---

### Task 7: Shared web components — status chip + trigger list + trigger dialog

**Files:**
- Create: `packages/web/src/components/workflows/run-status-chip.tsx`
- Create: `packages/web/src/components/workflows/trigger-list.tsx`
- Create: `packages/web/src/components/workflows/trigger-dialog.tsx`
- Test: `packages/web/src/components/workflows/trigger-list.test.tsx`, `packages/web/src/components/workflows/trigger-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 6 hooks; primitives `Button, Badge, Dialog, Input, Label, Switch, Spinner` from `~/components/primitives`; icons `Clock, Zap, Pencil, Trash2, Play` from `lucide-react`; `WorkflowTriggerItem` from `@valet/api/wire`.
- Produces:
  - `RunStatusChip({ status, outcome }: { status: WorkflowRunStatus; outcome?: WorkflowRunOutcome })`
  - `TriggerList({ workflowId }: { workflowId?: string })` — full list UI incl. toggle/edit/delete/fire-now and the "New trigger" button + dialog wiring.
  - `TriggerDialog({ open, onOpenChange, workflowId, editing }: { open: boolean; onOpenChange: (o: boolean) => void; workflowId?: string; editing?: WorkflowTriggerItem })`

- [ ] **Step 1: RunStatusChip (no test needed beyond usage in Task 8's tests)**

```tsx
import type { WorkflowRunOutcome, WorkflowRunStatus } from "@valet/api/wire";

const STYLES: Record<string, string> = {
  pending: "bg-muted/20 text-muted",
  running: "bg-info-500/15 text-info-500",
  parked: "bg-warning-500/15 text-warning-500",
  terminalizing: "bg-warning-500/15 text-warning-500",
  completed: "bg-moss/15 text-moss",
  failed: "bg-danger-500/15 text-danger-500",
  cancelled: "bg-muted/20 text-muted",
};

/** One chip for run state: outcome once settled, status until then. */
export function RunStatusChip({ status, outcome }: { status: WorkflowRunStatus; outcome?: WorkflowRunOutcome }) {
  const label = status === "settled" ? (outcome ?? "settled") : status;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[label] ?? "bg-muted/20 text-muted"}`}>
      {label}
    </span>
  );
}
```

Check the color token names against `packages/web/tailwind.config.*` / existing usage (`text-danger-500` appears in `workflows.index.tsx`; verify `info`, `warning`, `moss` exist — `text-moss` appears in `workflows.index.tsx`). Substitute the project's actual tokens where these differ; do not invent new tokens.

- [ ] **Step 2: Write failing component tests**

`trigger-list.test.tsx` (jsdom, mock `~/api/workflows` exactly like `-workflows.index.test.tsx` mocks its hooks — full mock module with `vi.fn()` mutateAsyncs):

```tsx
const triggersData: { triggers: WorkflowTriggerItem[] } = {
  triggers: [
    {
      kind: "schedule", id: "sch_1", workflowId: "wf_1", name: "Nightly build",
      enabled: true,
      detail: { cron: "0 3 * * *", timezone: "UTC", targetKind: "workflow", nextFireAt: Date.now() + 3600_000, lastFiredAt: null },
    },
    {
      kind: "schedule", id: "sch_2", name: "Morning digest", enabled: true,
      detail: { cron: "0 9 * * *", timezone: "UTC", targetKind: "orchestrator", prompt: "digest", nextFireAt: Date.now() + 60_000, lastFiredAt: null },
    },
    {
      kind: "event", id: "ev_1", workflowId: "wf_1", name: "On PR open", enabled: false,
      detail: { eventKeys: ["github.pull_request.opened"], filters: [] },
    },
  ],
};

it("renders one row per trigger with kind-appropriate summaries", () => {
  render(<TriggerList />);
  expect(screen.getByText("Nightly build")).toBeTruthy();
  expect(screen.getByText(/0 3 \* \* \*/)).toBeTruthy();          // cron shown
  expect(screen.getByText(/github\.pull_request\.opened/)).toBeTruthy(); // event keys shown
});

it("toggles enabled through the kind-specific update hook", () => {
  render(<TriggerList />);
  fireEvent.click(screen.getAllByRole("switch")[0]);
  expect(updateScheduleMutateAsync).toHaveBeenCalledWith({ id: "sch_1", body: { enabled: false } });
});

it("filters to a workflow when workflowId is passed (hook receives it)", () => {
  render(<TriggerList workflowId="wf_1" />);
  expect(useWorkflowTriggersMock).toHaveBeenCalledWith("wf_1");
});

it("fires a schedule now", () => {
  render(<TriggerList />);
  fireEvent.click(screen.getAllByLabelText(/run now/i)[0]);
  expect(runNowMutateAsync).toHaveBeenCalledWith("sch_1");
});
```

`trigger-dialog.test.tsx`:

```tsx
it("creates an orchestrator schedule from the form", async () => {
  render(<TriggerDialog open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByText(/^Schedule$/));                 // kind picker
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "digest" } });
  fireEvent.change(screen.getByLabelText(/cron/i), { target: { value: "0 9 * * *" } });
  fireEvent.click(screen.getByLabelText(/orchestrator/i));         // target radio
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
  fireEvent.click(screen.getByText(/^Create$/));
  await waitFor(() =>
    expect(createScheduleMutateAsync).toHaveBeenCalledWith({
      name: "digest", cron: "0 9 * * *", timezone: expect.any(String),
      target: { kind: "orchestrator", prompt: "summarize" },
    }),
  );
});

it("shows the server's corrective error on failure", async () => {
  createScheduleMutateAsync.mockRejectedValueOnce(new Error("invalid cron \"x\". Use 5 fields, for example \"0 9 * * 1-5\"."));
  // fill form as above, submit
  await waitFor(() => expect(screen.getByText(/Use 5 fields/)).toBeTruthy());
});

it("creates an event trigger with a catalog-picked key", async () => {
  render(<TriggerDialog open onOpenChange={() => {}} workflowId="wf_1" />);
  fireEvent.click(screen.getByText(/^Event$/));
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "on pr" } });
  // catalog mock returns github.pull_request.opened; select it
  fireEvent.change(screen.getByLabelText(/event/i), { target: { value: "github.pull_request.opened" } });
  fireEvent.click(screen.getByText(/^Create$/));
  await waitFor(() =>
    expect(createEventTriggerMutateAsync).toHaveBeenCalledWith({
      workflowId: "wf_1", name: "on pr", eventKeys: ["github.pull_request.opened"], filters: [],
    }),
  );
});
```

- [ ] **Step 3: Run, verify FAIL** — `pnpm --filter @valet/web test trigger-`

- [ ] **Step 4: Implement `TriggerList`**

```tsx
import { useState } from "react";
import { Clock, Pencil, Play, Trash2, Zap } from "lucide-react";
import type { WorkflowTriggerItem } from "@valet/api/wire";
import {
  useDeleteEventTrigger,
  useDeleteSchedule,
  useRunScheduleNow,
  useUpdateEventTrigger,
  useUpdateSchedule,
  useWorkflowTriggers,
  useWorkflows,
} from "~/api/workflows";
import { Button, Spinner, Switch } from "~/components/primitives";
import { TriggerDialog } from "./trigger-dialog";

/** Relative "in 2h" formatting for next fire times. */
function relativeTime(ms: number): string {
  const delta = ms - Date.now();
  if (delta <= 0) return "due now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function triggerSummary(t: WorkflowTriggerItem): string {
  if (t.kind === "schedule") {
    const next = t.enabled ? ` · next ${relativeTime(t.detail.nextFireAt)}` : "";
    const target = t.detail.targetKind === "orchestrator" ? " · orchestrator" : "";
    return `${t.detail.cron} (${t.detail.timezone})${target}${next}`;
  }
  return t.detail.eventKeys.join(", ");
}

export function TriggerList({ workflowId }: { workflowId?: string }) {
  const { data, isLoading, error } = useWorkflowTriggers(workflowId);
  const workflowsQ = useWorkflows();
  const updateSchedule = useUpdateSchedule();
  const updateEvent = useUpdateEventTrigger();
  const deleteSchedule = useDeleteSchedule();
  const deleteEvent = useDeleteEventTrigger();
  const runNow = useRunScheduleNow();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowTriggerItem | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);

  const nameById = new Map((workflowsQ.data?.workflows ?? []).map((w) => [w.id, w.name]));
  const triggers = data?.triggers ?? [];

  async function guarded(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Request failed.");
    }
  }

  function toggle(t: WorkflowTriggerItem) {
    const body = { enabled: !t.enabled };
    void guarded(() =>
      t.kind === "schedule"
        ? updateSchedule.mutateAsync({ id: t.id, body })
        : updateEvent.mutateAsync({ id: t.id, body }),
    );
  }

  function remove(t: WorkflowTriggerItem) {
    if (!confirm(`Delete trigger "${t.name}"?`)) return;
    void guarded(() =>
      t.kind === "schedule" ? deleteSchedule.mutateAsync(t.id) : deleteEvent.mutateAsync(t.id),
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">Triggers</span>
        <Button size="sm" onClick={() => { setEditing(undefined); setDialogOpen(true); }}>
          New trigger
        </Button>
      </div>

      {actionError && <div className="text-xs text-danger-500">{actionError}</div>}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted"><Spinner size={14} /> Loading triggers…</div>
      )}
      {!isLoading && error && <div className="text-sm text-danger-500">Failed to load triggers.</div>}
      {!isLoading && !error && triggers.length === 0 && (
        <div className="text-sm text-muted">No triggers yet. Create one to run this on a schedule or on an event.</div>
      )}

      <ul className="space-y-2">
        {triggers.map((t) => (
          <li key={`${t.kind}:${t.id}`} className="flex items-center gap-3 rounded border border-line bg-paper px-4 py-3">
            {t.kind === "schedule"
              ? <Clock className="h-4 w-4 shrink-0 text-muted" aria-label="schedule trigger" />
              : <Zap className="h-4 w-4 shrink-0 text-muted" aria-label="event trigger" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">{t.name}</div>
              <div className="truncate text-xs text-muted">
                {triggerSummary(t)}
                {!workflowId && t.workflowId && ` · ${nameById.get(t.workflowId) ?? t.workflowId}`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {t.kind === "schedule" && (
                <Button size="sm" variant="ghost" aria-label={`Run now: ${t.name}`}
                  onClick={() => void guarded(() => runNow.mutateAsync(t.id))} disabled={runNow.isPending}>
                  <Play className="h-4 w-4" />
                </Button>
              )}
              <Button size="sm" variant="ghost" aria-label={`Edit ${t.name}`}
                onClick={() => { setEditing(t); setDialogOpen(true); }}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => remove(t)}>
                <Trash2 className="h-4 w-4" />
              </Button>
              <Switch checked={t.enabled} onCheckedChange={() => toggle(t)} aria-label={`${t.enabled ? "Disable" : "Enable"} ${t.name}`} />
            </div>
          </li>
        ))}
      </ul>

      <TriggerDialog open={dialogOpen} onOpenChange={setDialogOpen} workflowId={workflowId} editing={editing} />
    </div>
  );
}
```

Check the `Switch` primitive's props (`packages/web/src/components/primitives/switch.tsx`) — use its actual prop names (`checked`/`onCheckedChange` if Radix-based; adjust if not).

- [ ] **Step 5: Implement `TriggerDialog`**

Structure (follow `new-workflow-dialog.tsx` for the Dialog idiom and error display):

- Local state: `kind: "schedule" | "event"` (locked to `editing.kind` when editing; picker shown only when creating), `name`, and per-kind fields.
- Schedule fields: `cron` (Input), `timezone` (Input, default `Intl.DateTimeFormat().resolvedOptions().timeZone`), target radio `workflow | orchestrator` (locked when editing — kind is immutable server-side), `workflowSelect` (a `<select>` over `useWorkflows()` — preselected + hidden when a `workflowId` prop is passed), `prompt` (textarea, shown for orchestrator), `input` (textarea holding JSON, shown for workflow target; parse on submit, inline error "Input must be valid JSON, for example {\"env\": \"prod\"}" on parse failure).
- Event fields: `workflowSelect` (same), `eventKey` (a `<select>` built from `useTriggerCatalog()` flattened to `service.entries[].key`, option label `key — description`), filters deferred to a raw JSON textarea (same parse rule) — a per-field filter builder is YAGNI for this pass.
- Submit: `editing` present → `useUpdateSchedule`/`useUpdateEventTrigger` with only the changed fields; else create. On success `onOpenChange(false)` and reset. On error render `err.message` verbatim (the server messages carry the corrective action).
- Labels wired with `htmlFor`/`id` so the tests' `getByLabelText` works.

- [ ] **Step 6: Run, verify PASS** — `pnpm --filter @valet/web test trigger-`

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/workflows/run-status-chip.tsx packages/web/src/components/workflows/trigger-list.tsx packages/web/src/components/workflows/trigger-dialog.tsx packages/web/src/components/workflows/trigger-list.test.tsx packages/web/src/components/workflows/trigger-dialog.test.tsx
git commit -m "feat(web): trigger list, trigger dialog, run status chip"
```

---

### Task 8: Workflows hub — tabbed index page redesign

**Files:**
- Modify: `packages/web/src/routes/workflows.index.tsx` (rewrite)
- Modify: `packages/web/src/routes/-workflows.index.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 6/7 components + hooks; `RunStatusChip`; TanStack Router search params.
- Produces: `/workflows?tab=workflows|runs|triggers` (default `workflows`), linkable tabs.

- [ ] **Step 1: Extend the route test**

Keep the existing mocks; extend the `~/api/workflows` mock module with `useWorkflowTriggers`, `useAllWorkflowRuns`, `useUpdateSchedule`, `useUpdateEventTrigger`, `useDeleteSchedule`, `useDeleteEventTrigger`, `useRunScheduleNow`, `useTriggerCatalog`, `useCreateSchedule`, `useCreateEventTrigger` (each returning the standard `{ data / mutateAsync, isPending: false }` shapes). Extend the router mock with `useSearch: () => searchState` (a mutable test variable, default `{}`).

New cases:

```tsx
it("shows the Workflows tab by default with per-workflow trigger badges", () => {
  // triggers mock: schedule on wf_1 → expect a clock badge within wf_1's row
  render(<WorkflowsIndexPage />);
  expect(screen.getByText("Deploy pipeline")).toBeTruthy();
  expect(screen.getByLabelText(/1 schedule/)).toBeTruthy();
});

it("renders the Runs tab from the global runs feed", () => {
  searchState = { tab: "runs" };
  // allRuns mock: one settled/completed run for wf_1
  render(<WorkflowsIndexPage />);
  expect(screen.getByText("Deploy pipeline")).toBeTruthy(); // workflowName column
  expect(screen.getByText("completed")).toBeTruthy();       // RunStatusChip label
});

it("renders the Triggers tab with the unified list", () => {
  searchState = { tab: "triggers" };
  render(<WorkflowsIndexPage />);
  expect(screen.getByText("Nightly build")).toBeTruthy();
});

it("tab buttons navigate via search params", () => {
  render(<WorkflowsIndexPage />);
  fireEvent.click(screen.getByRole("tab", { name: /Triggers/ }));
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { tab: "triggers" } }));
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @valet/web test workflows.index`

- [ ] **Step 3: Implement the rewrite**

Shape of the new `workflows.index.tsx`:

```tsx
type HubTab = "workflows" | "runs" | "triggers";

export const Route = createFileRoute("/workflows/")({
  component: WorkflowsIndexPage,
  validateSearch: (search: Record<string, unknown>): { tab?: HubTab } => ({
    tab: search.tab === "runs" || search.tab === "triggers" ? search.tab : undefined,
  }),
});

const TABS: { id: HubTab; label: string }[] = [
  { id: "workflows", label: "Workflows" },
  { id: "runs", label: "Runs" },
  { id: "triggers", label: "Triggers" },
];

export function WorkflowsIndexPage() {
  const search = Route.useSearch();          // NOTE: test mock — see below
  const navigate = useNavigate();
  const tab: HubTab = search.tab ?? "workflows";
  const [newOpen, setNewOpen] = useState(false);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-line px-6 pt-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight text-ink font-display">Workflows</h1>
          <Button size="sm" onClick={() => setNewOpen(true)}>New workflow</Button>
        </div>
        <div role="tablist" className="mt-3 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => void navigate({ to: "/workflows", search: t.id === "workflows" ? {} : { tab: t.id } })}
              className={`rounded-t px-3 py-1.5 text-sm border-b-2 ${
                tab === t.id
                  ? "border-ink font-medium text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <NewWorkflowDialog open={newOpen} onOpenChange={setNewOpen} />

      <div className="flex-1 overflow-y-auto p-6">
        {tab === "workflows" && <WorkflowsTab onNew={() => setNewOpen(true)} />}
        {tab === "runs" && <RunsTab />}
        {tab === "triggers" && <TriggerList />}
      </div>
    </div>
  );
}
```

`Route.useSearch()` breaks under the test's `createFileRoute` mock (the mock returns the config object, not a route). Use the top-level `useSearch` hook instead — `import { useSearch } from "@tanstack/react-router"` with `useSearch({ from: "/workflows/" })` — and add `useSearch: () => searchState` to the router mock. If the `from`-typed overload fights the mock, use `useSearch({ strict: false })`.

`WorkflowsTab`: the current `DefinitionRow` list, upgraded —

```tsx
function WorkflowsTab({ onNew }: { onNew: () => void }) {
  const { data, isLoading, error } = useWorkflows();
  const triggersQ = useWorkflowTriggers();
  const workflows = data?.workflows ?? [];
  // group triggers by workflowId once for badges
  const triggersByWf = new Map<string, WorkflowTriggerItem[]>();
  for (const t of triggersQ.data?.triggers ?? []) {
    if (!t.workflowId) continue;
    const list = triggersByWf.get(t.workflowId) ?? [];
    list.push(t);
    triggersByWf.set(t.workflowId, list);
  }
  // loading / error / empty states: keep the current copy verbatim
  return (
    <ul className="space-y-2">
      {workflows.map((wf) => (
        <DefinitionRow key={wf.id} workflow={wf} triggers={triggersByWf.get(wf.id) ?? []} />
      ))}
    </ul>
  );
}
```

`DefinitionRow` keeps its current Run/Delete behavior and adds, next to the run count: latest-run chip (`useWorkflowRuns(workflow.id)` already fetches; take `runs[0]` — the API returns newest-first — and render `<RunStatusChip …/>` when present) and trigger badges:

```tsx
{scheduleCount > 0 && (
  <span aria-label={`${scheduleCount} schedule${scheduleCount === 1 ? "" : "s"}`}
    title={nextFire ? `next fire ${new Date(nextFire).toLocaleString()}` : undefined}
    className="inline-flex items-center gap-1 rounded-full bg-muted/10 px-2 py-0.5 text-xs text-muted">
    <Clock className="h-3 w-3" /> {scheduleCount}
  </span>
)}
{eventCount > 0 && (
  <span aria-label={`${eventCount} event trigger${eventCount === 1 ? "" : "s"}`}
    className="inline-flex items-center gap-1 rounded-full bg-muted/10 px-2 py-0.5 text-xs text-muted">
    <Zap className="h-3 w-3" /> {eventCount}
  </span>
)}
```

where `scheduleCount`/`eventCount` partition the `triggers` prop by `kind` and `nextFire` is the minimum `detail.nextFireAt` among enabled schedules.

`RunsTab`:

```tsx
function RunsTab() {
  const { data, isLoading, error } = useAllWorkflowRuns();
  const runs = data?.runs ?? [];
  if (isLoading) return <div className="flex items-center gap-2 text-sm text-muted"><Spinner size={14} /> Loading runs…</div>;
  if (error) return <div className="text-sm text-danger-500">Failed to load runs.</div>;
  if (runs.length === 0) return <div className="text-sm text-muted">No runs yet. Run a workflow from the Workflows tab.</div>;
  return (
    <ul className="space-y-2">
      {runs.map((r) => (
        <li key={r.runId}>
          <Link to="/workflows/runs/$runId" params={{ runId: r.runId }}
            className="flex items-center justify-between gap-3 rounded border border-line bg-paper px-4 py-3 hover:border-ink/30">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink">{r.workflowName}</div>
              <div className="truncate text-xs text-muted font-mono">{r.runId}</div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-xs text-muted">{new Date(r.createdAt).toLocaleString()}</span>
              <RunStatusChip status={r.status} outcome={r.outcome} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Run, verify PASS (old cases too)** — `pnpm --filter @valet/web test workflows.index`

The pre-existing cases (name links to editor, Run navigates, New workflow dialog) must stay green — they pin behavior the redesign must not break.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/workflows.index.tsx packages/web/src/routes/-workflows.index.test.tsx
git commit -m "feat(web): tabbed workflows hub with runs and triggers tabs"
```

---

### Task 9: Editor page — scoped triggers panel

**Files:**
- Modify: `packages/web/src/routes/workflows.$workflowId.tsx`
- Test: extend `packages/web/src/routes/-workflows.$workflowId.test.tsx`

**Interfaces:**
- Consumes: `TriggerList` from Task 7.

- [ ] **Step 1: Write the failing test**

Extend the editor page test's `~/api/workflows` mock with the trigger hooks (same shapes as Task 8). Add:

```tsx
it("renders the scoped triggers panel for this workflow", () => {
  render(<WorkflowEditorPage …/* match the file's existing render helper */ />);
  expect(screen.getByText("Triggers")).toBeTruthy();
  expect(useWorkflowTriggersMock).toHaveBeenCalledWith("wf_1");
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @valet/web test 'workflows.\$workflowId'`

- [ ] **Step 3: Implement**

In `workflows.$workflowId.tsx`, the page already has a collapsible runs section in a side column. Render `<TriggerList workflowId={workflowId} />` in that same column, above or below the runs section, wrapped in the same container styling the runs section uses (match its `border-line rounded` wrapper and heading treatment; read the surrounding JSX and mirror it — do not restyle the runs section itself).

- [ ] **Step 4: Run, verify PASS** — `pnpm --filter @valet/web test 'workflows.\$workflowId'`

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/workflows.\$workflowId.tsx packages/web/src/routes/-workflows.\$workflowId.test.tsx
git commit -m "feat(web): scoped triggers panel on the workflow editor page"
```

---

### Task 10: Spec sync + full validation

**Files:**
- Modify: `docs/specs/2026-08-15-workflow-triggers-ui-design.md` (record any deviations discovered during implementation — e.g. the target-kind-immutable PATCH decision is already in Task 1; add anything else that shifted)

- [ ] **Step 1: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 2: Targeted regression suites**

```bash
pnpm --filter @valet/api test workflows
pnpm --filter @valet/api test schedule
pnpm --filter @valet/api test trigger
pnpm --filter @valet/api test events
pnpm --filter @valet/web test workflows
pnpm --filter @valet/web test trigger-
```

Expected: all PASS.

- [ ] **Step 3: Manual smoke in the dev stack**

Follow CLAUDE.md "Start the local stack cleanly" (check ports 8788/5173, check `~/.valet/pg` ownership, then `make dev-local`, then `curl -sf localhost:8788/api/health`). In the browser: create a schedule from the Triggers tab (orchestrator target, `* * * * *`), see it listed with a next-fire time, watch the Runs/orchestrator side fire within a minute, toggle it off, delete it. Create an event trigger against a workflow and confirm the badge appears on the Workflows tab.

- [ ] **Step 4: Full e2e scorecard**

Run: `make e2e 2>&1 | tee /tmp/e2e.log` — capture the FULL output, never pipe through tail/head/grep.
Expected: clean scorecard. The only acceptable red rows are pre-existing environmental failures you can name and explain as unrelated (per CLAUDE.md). If a Docker-heavy suite goes red while the dev stack runs, re-run it in isolation: `make e2e E2E_ARGS="--only <suite-id>"`.

- [ ] **Step 5: Commit spec updates (if any) and push**

```bash
git add docs/specs/2026-08-15-workflow-triggers-ui-design.md
git commit -m "docs(specs): sync triggers UI spec with implementation"
# Before push: run `say "yubikey"` first (SSH remote needs a YubiKey tap)
say "yubikey" && git push -u origin conner/workflow-triggers-ui
```

Then open the PR against `dev-v2` with `gh pr create --base dev-v2` (no YubiKey needed for `gh`). PR body: summarize the REST surface, the hub tabs, and the spec/plan paths. No AI co-author trailers.
