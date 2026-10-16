# Sandbox Scratch, Wakeups, and Leases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a sandbox a large node-local `/scratch` volume sized per session, and let an agent run work for days through durable wakeups (process, watch, timer) and leases that keep the sandbox alive.

**Architecture:** `scratch` is a fourth sandbox resource that rides the existing cpu/memory path (prebuild.yaml, saved defaults, `task`) into the Kubernetes manifest as an emptyDir plus ephemeral-storage sums. Wakeups and leases are two engine-store tables; a DB-driven api sweep (`WakeWatcher`) probes them through the sandbox provider's job-mode protocol, releases leases, delivers signals, and keeps leased pods out of autoscaler eviction. Both idle sweeps and `ChildWatcher` consult leases.

**Tech Stack:** TypeScript, vitest, pi-agent-core tool defs (`@sinclair/typebox`), PGlite/node-postgres (`@valet/store-postgres`), Hono, `@kubernetes/client-node`, Helm.

**Spec:** `docs/specs/2026-10-08-sandbox-scratch-wakeups-leases-design.md`. Rollout steps 1 to 4 only. Part E (workspace growth retirement, home-seed trim), the web wakeups strip, and the infra PR are separate plans.

## Global Constraints

- No `any`, no `as unknown as T`, no `@ts-ignore`. Narrow with `typeof`/`in`. Legitimate `as` gets a comment.
- Pre-1.0 migrations: edit `packages/store-postgres/migrations/pg/0000_engine.sql` in place; add a `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts`; do NOT bump `ENGINE_SCHEMA_VERSION`. After editing, run `make dev-clean` in every worktree with dev data.
- Every user-facing refusal names the corrective action and the knob (spec A4, B3, Part D). Copy the strings verbatim from the spec.
- Prose (comments, docs) in ASD-STE100 style: short sentences, active voice, no em dashes.
- Terminology: "sandbox process" (never "job" for the new concept), "scratch", "workspace claim", "wakeup", "lease", "WakeWatcher".
- Tests: `pnpm --filter @valet/<pkg> test <filter>` (no `--` before the filter). Node 22 (`nvm use 22`).
- Commit per task, subject ≤ 72 chars, no AI co-author trailers.
- Chart changes need a `Chart.yaml` version bump.
- The host has five session builders (`extractDocument: extractDocumentText` sites in `packages/api/src/engine/host.ts`). A feature wired into one and not the others ships broken (TKAI-385). Task 15 adds a test that counts them.

## Review Focus

1. A `scratch` value over the agent cap passed to `task` must return the A4 refusal text and write no `agent_sessions` row. Test in Task 13.
2. An api restart while a process wakeup is `running` must not emit a signal, must not release the lease, and must deliver `process.exited` later when the process exits. Test in Task 17 (restart adoption) and Task 21 (integration).
3. A `timer` on a hibernated session must fire without creating a lease and without the idle sweep touching it. Test in Task 17 and Task 18.
4. A session with an active lease and no queue activity for longer than the idle window must stay active in BOTH idle sweeps. Test in Task 18.
5. `bash { background: true }` without `deadline_hours` or `reason` must refuse with the B3 text and start nothing. Test in Task 7.

---

### Task 1: Shared scratch validation

**Files:**
- Modify: `packages/shared/src/sandbox-resources.ts`
- Test: `packages/shared/src/sandbox-resources.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ScratchCaps { max?: string; agentMax?: string }   // undefined max = disabled
  export type ScratchSource = "task" | "prebuild" | "saved" | "create";
  export class ScratchRequestError extends Error { readonly code = "scratch_refused"; readonly reason: ScratchRefusalReason }
  export type ScratchRefusalReason = "invalid" | "disabled" | "deploy_cap" | "agent_cap";
  export function isScratchRequestError(err: unknown): err is ScratchRequestError;
  export function validateScratchRequest(value: unknown, source: ScratchSource, caps: ScratchCaps): string; // returns trimmed quantity or throws
  export const MIN_SCRATCH_BYTES = 2 ** 30;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/sandbox-resources.test.ts`:

```ts
import { ScratchRequestError, validateScratchRequest } from "./sandbox-resources.js";

describe("validateScratchRequest", () => {
  const caps = { max: "1Ti", agentMax: "100Gi" };

  it("returns the trimmed quantity when inside every cap", () => {
    expect(validateScratchRequest(" 200Gi ", "prebuild", caps)).toBe("200Gi");
    expect(validateScratchRequest("50Gi", "task", caps)).toBe("50Gi");
  });

  it("refuses a non-quantity or a value below 1Gi with the A4 text", () => {
    for (const bad of ["nope", 4, "500Mi", "0", "-1Gi"]) {
      expect(() => validateScratchRequest(bad, "prebuild", caps)).toThrow(
        `scratch "${String(bad)}" is not a Kubernetes quantity of at least 1Gi. Use a form like "200Gi".`,
      );
    }
  });

  it("refuses when scratch is disabled", () => {
    expect(() => validateScratchRequest("10Gi", "prebuild", {})).toThrow(
      "scratch is not enabled on this deployment. Ask an admin to set sandbox.scratchMax.",
    );
  });

  it("refuses over the deploy cap, never clamps", () => {
    expect(() => validateScratchRequest("2Ti", "prebuild", caps)).toThrow(
      "scratch 2Ti exceeds the 1Ti deploy cap (sandbox.scratchMax). Request at most 1Ti, or ask an admin to raise the cap.",
    );
  });

  it("refuses a task request over the agent cap with the agent text", () => {
    let err: unknown;
    try { validateScratchRequest("200Gi", "task", caps); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ScratchRequestError);
    expect((err as ScratchRequestError).reason).toBe("agent_cap");
    expect((err as ScratchRequestError).message).toBe(
      "scratch 200Gi exceeds the 100Gi agent cap (sandbox.scratchAgentMax). Declare it in .valet/prebuild.yaml, or ask an admin to raise the cap.",
    );
  });

  it("applies the agent cap only to the task source", () => {
    expect(validateScratchRequest("200Gi", "saved", caps)).toBe("200Gi");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/shared test sandbox-resources`
Expected: FAIL, `validateScratchRequest is not a function`.

- [ ] **Step 3: Implement**

Append to `packages/shared/src/sandbox-resources.ts` (it already exports `parseResourceQuantity`; if not, import it from the module that does, `grep -rn "export function parseResourceQuantity" packages/shared/src`):

```ts
/** Scratch caps a deployment sets. `max` undefined means scratch is disabled. */
export interface ScratchCaps {
  max?: string;
  agentMax?: string;
}

export type ScratchSource = "task" | "prebuild" | "saved" | "create";
export type ScratchRefusalReason = "invalid" | "disabled" | "deploy_cap" | "agent_cap";

export const MIN_SCRATCH_BYTES = 2 ** 30;

export class ScratchRequestError extends Error {
  readonly code = "scratch_refused";
  constructor(readonly reason: ScratchRefusalReason, message: string) {
    super(message);
    this.name = "ScratchRequestError";
  }
}

export function isScratchRequestError(err: unknown): err is ScratchRequestError {
  return err instanceof ScratchRequestError;
}

/**
 * One validation for every scratch source (spec INV-4). Refuses, never
 * clamps. The refusal text names the knob and the corrective action.
 */
export function validateScratchRequest(value: unknown, source: ScratchSource, caps: ScratchCaps): string {
  const text = typeof value === "string" ? value.trim() : "";
  const bytes = text ? parseResourceQuantity(text) : null;
  if (bytes === null || bytes < MIN_SCRATCH_BYTES) {
    throw new ScratchRequestError(
      "invalid",
      `scratch "${String(value)}" is not a Kubernetes quantity of at least 1Gi. Use a form like "200Gi".`,
    );
  }
  const maxBytes = caps.max ? parseResourceQuantity(caps.max) : null;
  if (maxBytes === null || maxBytes <= 0) {
    throw new ScratchRequestError("disabled", "scratch is not enabled on this deployment. Ask an admin to set sandbox.scratchMax.");
  }
  if (bytes > maxBytes) {
    throw new ScratchRequestError(
      "deploy_cap",
      `scratch ${text} exceeds the ${caps.max} deploy cap (sandbox.scratchMax). Request at most ${caps.max}, or ask an admin to raise the cap.`,
    );
  }
  if (source === "task") {
    const agentBytes = caps.agentMax ? parseResourceQuantity(caps.agentMax) : null;
    if (agentBytes !== null && bytes > agentBytes) {
      throw new ScratchRequestError(
        "agent_cap",
        `scratch ${text} exceeds the ${caps.agentMax} agent cap (sandbox.scratchAgentMax). Declare it in .valet/prebuild.yaml, or ask an admin to raise the cap.`,
      );
    }
  }
  return text;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/shared test sandbox-resources`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/sandbox-resources.ts packages/shared/src/sandbox-resources.test.ts
git commit -m "feat(shared): validate scratch requests against deploy and agent caps"
```

---

### Task 2: Engine types, in-memory store, and store contract

**Files:**
- Modify: `packages/engine/src/types.ts` (SandboxResources ~1347, SandboxResourceField ~1365, Sandbox.resourceOverrides ~1298, DesiredSandboxSpec.resources ~2170, ExecOpts ~1200, ToolContext ~677, SessionOptions ~2346, SessionStore ~1862, SandboxProvider ~1541, SpawnChildRequest ~2742)
- Create: `packages/engine/src/wakeups/types.ts`, `packages/engine/src/wakeups/ids.ts`
- Modify: `packages/engine/src/index.ts` (export the new module)
- Modify: `packages/engine/src/providers/in-memory/store.ts`
- Modify: `packages/engine/src/test-helpers/store-contract.ts`
- Test: `packages/engine/test/in-memory-store.test.ts` (runs the contract)

**Interfaces:**
- Produces (in `wakeups/types.ts`, re-exported from `types.ts`):
  ```ts
  export type WakeupKind = "process" | "watch" | "timer";
  export type WakeupStatus = "pending" | "running" | "done" | "cancelled" | "expired" | "lost";
  export type WakeupCause = "exit" | "deadline" | "cancelled" | "pid_missing" | "sandbox_unavailable" | "rate" | "fired";
  export interface Wakeup {
    id: string; sessionId: string; threadId: string; kind: WakeupKind; status: WakeupStatus;
    reason: string; command?: string; prompt?: string; execId?: string; leaseId?: string;
    fireAt?: number; deadlineAt?: number; exitCode?: number; cause?: WakeupCause;
    logOffset: number; logTail: string; eventCount: number;
    createdAt: number; updatedAt: number; endedAt?: number;
  }
  export type LeaseOwnerKind = "process" | "watch" | "hold";
  export type LeaseReleaseCause = "owner_ended" | "cancelled" | "deadline";
  export interface Lease {
    id: string; sessionId: string; sandboxId?: string; ownerKind: LeaseOwnerKind; ownerId?: string;
    reason: string; createdAt: number; deadlineAt: number; releasedAt?: number; releaseCause?: LeaseReleaseCause;
  }
  export type WakeupPatch = Partial<Pick<Wakeup, "cause" | "exitCode" | "endedAt" | "logOffset" | "logTail" | "eventCount" | "execId" | "leaseId">>;
  export interface WakeupLimits { leaseMaxHours: number; timerMaxHours: number; perSession: number; watchMaxEventsPerHour: number }
  export type WakeupCreateInput =
    | { kind: "process"; command: string; reason: string; deadlineHours: number }
    | { kind: "watch"; command: string; reason: string; maxHours: number }
    | { kind: "timer"; prompt: string; fireAt: number };
  export interface WakeupsSeam {
    limits: WakeupLimits;
    create(threadId: string, input: WakeupCreateInput): Promise<{ wakeup: Wakeup; lease?: Lease }>;
    hold(input: { hours: number; reason: string }): Promise<Lease>;
    get(id: string): Promise<Wakeup | null>;
    list(): Promise<{ wakeups: Wakeup[]; leases: Lease[] }>;
    cancel(id: string): Promise<{ kind: "wakeup" | "lease" } | null>;
    readLog(id: string, offset: number, bytes: number): Promise<{ text: string; nextOffset: number; eof: boolean }>;
  }
  ```
- `ids.ts`: `export function newWakeupId(): string` (`wk_` + 20 lowercase base32 chars from `crypto.randomBytes`), `export function newLeaseId(): string` (`ls_` + 20).
- `SessionStore` gains:
  ```ts
  createWakeup(wakeup: Wakeup): Promise<void>;
  getWakeup(id: string): Promise<Wakeup | null>;
  listWakeups(sessionId: string, statuses?: readonly WakeupStatus[]): Promise<Wakeup[]>;
  listDueWakeups(now: number, limit: number): Promise<Wakeup[]>;   // running process/watch + pending timer with fireAt <= now
  transitionWakeup(id: string, from: readonly WakeupStatus[], to: WakeupStatus, patch: WakeupPatch, updatedAt: number): Promise<Wakeup | null>;
  createLease(lease: Lease): Promise<void>;
  releaseLease(id: string, cause: LeaseReleaseCause, releasedAt: number): Promise<Lease | null>;  // null when already released
  listActiveLeases(sessionId: string): Promise<Lease[]>;
  listAllActiveLeases(): Promise<Lease[]>;
  countActiveLeases(sessionId: string): Promise<number>;
  ```
- `SandboxResources.scratch?: string`; `SandboxResourceField = "cpu" | "memory" | "scratch"`; `Sandbox.resourceOverrides`, `DesiredSandboxSpec.resources`, `SpawnChildRequest.resources` become `Pick<SandboxResources, "cpu" | "memory" | "scratch">`.
- `ExecOpts.detached?: boolean` (doc: "uncapped output, not tracked as a pending job; the caller owns its lifetime").
- `ToolContext.wakeups?: WakeupsSeam`; `SessionOptions.wakeups?: WakeupsSeam`.
- `SandboxProvider.setEvictionProtection?(id: string, enabled: boolean): Promise<{ changed: boolean }>`; `SandboxProvider.listEvictionProtected?(): Promise<string[]>`.

- [ ] **Step 1: Add the contract tests**

In `packages/engine/src/test-helpers/store-contract.ts`, inside the `describe` block after the existing decision-gate tests, add:

```ts
    describe("wakeups and leases", () => {
      const wakeup = (over: Partial<Wakeup> = {}): Wakeup => ({
        id: "wk_a", sessionId: "sess-1", threadId: "th-1", kind: "process", status: "running",
        reason: "proof build", command: "lake build", execId: "job-1", leaseId: "ls_a",
        deadlineAt: 10_000, logOffset: 0, logTail: "", eventCount: 0, createdAt: 1, updatedAt: 1, ...over,
      });
      const lease = (over: Partial<Lease> = {}): Lease => ({
        id: "ls_a", sessionId: "sess-1", sandboxId: "sb-1", ownerKind: "process", ownerId: "wk_a",
        reason: "proof build", createdAt: 1, deadlineAt: 10_000, ...over,
      });

      it("creates, gets, and lists wakeups by status", async () => {
        await store.createWakeup(wakeup());
        await store.createWakeup(wakeup({ id: "wk_b", kind: "timer", status: "pending", command: undefined, execId: undefined, leaseId: undefined, prompt: "check", fireAt: 500, deadlineAt: undefined }));
        expect(await store.getWakeup("wk_a")).toEqual(wakeup());
        expect((await store.listWakeups("sess-1")).map((w) => w.id).sort()).toEqual(["wk_a", "wk_b"]);
        expect((await store.listWakeups("sess-1", ["pending"])).map((w) => w.id)).toEqual(["wk_b"]);
        expect(await store.getWakeup("missing")).toBeNull();
      });

      it("lists due wakeups: running process/watch always, pending timer only at or past fireAt", async () => {
        await store.createWakeup(wakeup());
        await store.createWakeup(wakeup({ id: "wk_t", kind: "timer", status: "pending", prompt: "p", fireAt: 500, command: undefined, execId: undefined, leaseId: undefined, deadlineAt: undefined }));
        await store.createWakeup(wakeup({ id: "wk_done", status: "done" }));
        expect((await store.listDueWakeups(100, 10)).map((w) => w.id)).toEqual(["wk_a"]);
        expect((await store.listDueWakeups(500, 10)).map((w) => w.id).sort()).toEqual(["wk_a", "wk_t"]);
        expect(await store.listDueWakeups(500, 1)).toHaveLength(1);
      });

      it("transitionWakeup is a CAS: the second caller gets null", async () => {
        await store.createWakeup(wakeup());
        const first = await store.transitionWakeup("wk_a", ["running"], "done", { cause: "exit", exitCode: 0, endedAt: 50 }, 50);
        expect(first).toMatchObject({ status: "done", cause: "exit", exitCode: 0, endedAt: 50, updatedAt: 50 });
        const second = await store.transitionWakeup("wk_a", ["running"], "expired", { cause: "deadline" }, 60);
        expect(second).toBeNull();
        expect((await store.getWakeup("wk_a"))?.status).toBe("done");
      });

      it("transitionWakeup can patch a running row in place", async () => {
        await store.createWakeup(wakeup());
        const patched = await store.transitionWakeup("wk_a", ["running"], "running", { logOffset: 40, logTail: "tail", eventCount: 2 }, 7);
        expect(patched).toMatchObject({ status: "running", logOffset: 40, logTail: "tail", eventCount: 2 });
      });

      it("creates, lists, counts, and releases leases exactly once", async () => {
        await store.createLease(lease());
        await store.createLease(lease({ id: "ls_b", sessionId: "sess-2", ownerKind: "hold", ownerId: undefined }));
        expect(await store.countActiveLeases("sess-1")).toBe(1);
        expect((await store.listActiveLeases("sess-1")).map((l) => l.id)).toEqual(["ls_a"]);
        expect((await store.listAllActiveLeases()).map((l) => l.id).sort()).toEqual(["ls_a", "ls_b"]);
        const released = await store.releaseLease("ls_a", "owner_ended", 99);
        expect(released).toMatchObject({ releasedAt: 99, releaseCause: "owner_ended" });
        expect(await store.releaseLease("ls_a", "deadline", 100)).toBeNull();
        expect(await store.countActiveLeases("sess-1")).toBe(0);
        expect((await store.listAllActiveLeases()).map((l) => l.id)).toEqual(["ls_b"]);
      });
    });
```

Add `Wakeup` and `Lease` to the type import at the top of the file.

- [ ] **Step 2: Run the contract to verify it fails**

Run: `pnpm --filter @valet/engine test in-memory-store`
Expected: FAIL (type errors or `createWakeup is not a function`).

- [ ] **Step 3: Add the types**

Create `packages/engine/src/wakeups/types.ts` with the interfaces from the Interfaces block above (verbatim). Create `packages/engine/src/wakeups/ids.ts`:

```ts
import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytesCount: number): string {
  const bytes = randomBytes(bytesCount);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

export function newWakeupId(): string {
  return `wk_${base32(20)}`;
}

export function newLeaseId(): string {
  return `ls_${base32(20)}`;
}
```

In `packages/engine/src/types.ts`:
- `export * from "./wakeups/types.js";` near the top (or re-export the names explicitly if the file uses explicit exports).
- `SandboxResources`: add `scratch?: string;` with the comment `/** Node-local /scratch emptyDir size (spec Part A). Wiped when the pod stops. */`.
- `SandboxResourceField = "cpu" | "memory" | "scratch"`.
- Replace the three `Pick<SandboxResources, "cpu" | "memory">` (Sandbox.resourceOverrides, DesiredSandboxSpec.resources, SpawnChildRequest.resources) with `Pick<SandboxResources, "cpu" | "memory" | "scratch">`.
- `ExecOpts`: add `detached?: boolean;`.
- `ToolContext`: add `wakeups?: WakeupsSeam;` after `requestDecision`.
- `SessionOptions`: add `wakeups?: WakeupsSeam;` next to `extractDocument`.
- `SandboxProvider`: add the two optional eviction-protection methods.
- `SessionStore`: add the ten methods from the Interfaces block, under a `// === Wakeups and leases (spec 2026-10-08) ===` header.

Then run `pnpm typecheck` and fix every call site the Pick widening breaks (they are all type-only; `preserveResourceFieldsOnAdopt?.length === 2` in `attachment.ts:1083` becomes `=== 3`? No: that line compares against the number of fields. Change `(["cpu", "memory"] as const)` at `attachment.ts:1046` to `(["cpu", "memory", "scratch"] as const)` and the `=== 2` at `:1083` to `=== 3`).

- [ ] **Step 4: Implement the in-memory store**

In `packages/engine/src/providers/in-memory/store.ts`: add `private wakeups = new Map<string, Wakeup>()` and `private leases = new Map<string, Lease>()` as class fields (not per session row; `listDueWakeups` and `listAllActiveLeases` are global). Implement:

```ts
  async createWakeup(wakeup: Wakeup): Promise<void> {
    this.wakeups.set(wakeup.id, { ...wakeup });
  }
  async getWakeup(id: string): Promise<Wakeup | null> {
    const w = this.wakeups.get(id);
    return w ? { ...w } : null;
  }
  async listWakeups(sessionId: string, statuses?: readonly WakeupStatus[]): Promise<Wakeup[]> {
    return [...this.wakeups.values()]
      .filter((w) => w.sessionId === sessionId && (!statuses || statuses.includes(w.status)))
      .map((w) => ({ ...w }));
  }
  async listDueWakeups(now: number, limit: number): Promise<Wakeup[]> {
    return [...this.wakeups.values()]
      .filter((w) =>
        (w.status === "running" && (w.kind === "process" || w.kind === "watch")) ||
        (w.status === "pending" && w.kind === "timer" && w.fireAt !== undefined && w.fireAt <= now))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((w) => ({ ...w }));
  }
  async transitionWakeup(id: string, from: readonly WakeupStatus[], to: WakeupStatus, patch: WakeupPatch, updatedAt: number): Promise<Wakeup | null> {
    const w = this.wakeups.get(id);
    if (!w || !from.includes(w.status)) return null;
    const next: Wakeup = { ...w, ...patch, status: to, updatedAt };
    this.wakeups.set(id, next);
    return { ...next };
  }
  async createLease(lease: Lease): Promise<void> {
    this.leases.set(lease.id, { ...lease });
  }
  async releaseLease(id: string, cause: LeaseReleaseCause, releasedAt: number): Promise<Lease | null> {
    const l = this.leases.get(id);
    if (!l || l.releasedAt !== undefined) return null;
    const next: Lease = { ...l, releasedAt, releaseCause: cause };
    this.leases.set(id, next);
    return { ...next };
  }
  async listActiveLeases(sessionId: string): Promise<Lease[]> {
    return [...this.leases.values()].filter((l) => l.sessionId === sessionId && l.releasedAt === undefined).map((l) => ({ ...l }));
  }
  async listAllActiveLeases(): Promise<Lease[]> {
    return [...this.leases.values()].filter((l) => l.releasedAt === undefined).map((l) => ({ ...l }));
  }
  async countActiveLeases(sessionId: string): Promise<number> {
    return (await this.listActiveLeases(sessionId)).length;
  }
```

- [ ] **Step 5: Run the contract and typecheck**

Run: `pnpm --filter @valet/engine test in-memory-store` then `pnpm typecheck`
Expected: PASS for the engine; typecheck fails ONLY in `@valet/store-postgres` (`PgSessionStore` lacks the new methods). Task 3 fixes that.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src packages/engine/test
git commit -m "feat(engine): wakeup and lease types, store contract, scratch resource"
```

---

### Task 3: Postgres store and schema repairs

**Files:**
- Modify: `packages/store-postgres/migrations/pg/0000_engine.sql`
- Modify: `packages/store-postgres/src/helpers.ts`
- Modify: `packages/store-postgres/src/store.ts`
- Modify: `packages/api/src/lib/drizzle.ts` (`SCHEMA_REPAIRS`, ~line 393)
- Test: `packages/store-postgres/test/pg-store.test.ts` (already runs `runSessionStoreContract`)

**Interfaces:**
- Consumes: Task 2's `SessionStore` methods and types.

- [ ] **Step 1: Run the contract to see it fail**

Run: `pnpm --filter @valet/store-postgres test pg-store`
Expected: FAIL on the wakeups tests (missing methods).

- [ ] **Step 2: Add the DDL**

Append to `0000_engine.sql` (keep the `--> statement-breakpoint` separators the file uses):

```sql
CREATE TABLE "engine_wakeups" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"command" text,
	"prompt" text,
	"exec_id" text,
	"lease_id" text,
	"fire_at" bigint,
	"deadline_at" bigint,
	"exit_code" integer,
	"cause" text,
	"log_offset" bigint NOT NULL DEFAULT 0,
	"log_tail" text NOT NULL DEFAULT '',
	"event_count" integer NOT NULL DEFAULT 0,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"ended_at" bigint
);
--> statement-breakpoint
CREATE INDEX "engine_wakeups_session" ON "engine_wakeups" ("session_id","status");
--> statement-breakpoint
CREATE INDEX "engine_wakeups_due" ON "engine_wakeups" ("status","kind","fire_at");
--> statement-breakpoint
CREATE TABLE "engine_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sandbox_id" text,
	"owner_kind" text NOT NULL,
	"owner_id" text,
	"reason" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deadline_at" bigint NOT NULL,
	"released_at" bigint,
	"release_cause" text
);
--> statement-breakpoint
CREATE INDEX "engine_leases_active" ON "engine_leases" ("session_id") WHERE "released_at" IS NULL;
```

- [ ] **Step 3: Add row mappers**

In `helpers.ts`:

```ts
export interface WakeupRow {
  id: string; session_id: string; thread_id: string; kind: string; status: string; reason: string;
  command: string | null; prompt: string | null; exec_id: string | null; lease_id: string | null;
  fire_at: number | null; deadline_at: number | null; exit_code: number | null; cause: string | null;
  log_offset: number; log_tail: string; event_count: number; created_at: number; updated_at: number; ended_at: number | null;
}

export function rawToWakeupRow(raw: Record<string, unknown>): WakeupRow {
  return {
    id: asString(raw.id, "id"), session_id: asString(raw.session_id, "session_id"), thread_id: asString(raw.thread_id, "thread_id"),
    kind: asString(raw.kind, "kind"), status: asString(raw.status, "status"), reason: asString(raw.reason, "reason"),
    command: asStringOrNull(raw.command, "command"), prompt: asStringOrNull(raw.prompt, "prompt"),
    exec_id: asStringOrNull(raw.exec_id, "exec_id"), lease_id: asStringOrNull(raw.lease_id, "lease_id"),
    fire_at: toNumOrNull(raw.fire_at, "fire_at"), deadline_at: toNumOrNull(raw.deadline_at, "deadline_at"),
    exit_code: toNumOrNull(raw.exit_code, "exit_code"), cause: asStringOrNull(raw.cause, "cause"),
    log_offset: toNum(raw.log_offset, "log_offset"), log_tail: asString(raw.log_tail, "log_tail"),
    event_count: toNum(raw.event_count, "event_count"), created_at: toNum(raw.created_at, "created_at"),
    updated_at: toNum(raw.updated_at, "updated_at"), ended_at: toNumOrNull(raw.ended_at, "ended_at"),
  };
}

function isWakeupKind(v: string): v is WakeupKind { return v === "process" || v === "watch" || v === "timer"; }
function isWakeupStatus(v: string): v is WakeupStatus { return ["pending", "running", "done", "cancelled", "expired", "lost"].includes(v); }
function isWakeupCause(v: string): v is WakeupCause { return ["exit", "deadline", "cancelled", "pid_missing", "sandbox_unavailable", "rate", "fired"].includes(v); }

export function rowToWakeup(row: WakeupRow): Wakeup {
  if (!isWakeupKind(row.kind)) throw new Error(`engine_wakeups.kind "${row.kind}" is not a known kind`);
  if (!isWakeupStatus(row.status)) throw new Error(`engine_wakeups.status "${row.status}" is not a known status`);
  if (row.cause !== null && !isWakeupCause(row.cause)) throw new Error(`engine_wakeups.cause "${row.cause}" is not a known cause`);
  return {
    id: row.id, sessionId: row.session_id, threadId: row.thread_id, kind: row.kind, status: row.status, reason: row.reason,
    ...(row.command !== null ? { command: row.command } : {}),
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
    ...(row.exec_id !== null ? { execId: row.exec_id } : {}),
    ...(row.lease_id !== null ? { leaseId: row.lease_id } : {}),
    ...(row.fire_at !== null ? { fireAt: row.fire_at } : {}),
    ...(row.deadline_at !== null ? { deadlineAt: row.deadline_at } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.cause !== null ? { cause: row.cause } : {}),
    logOffset: row.log_offset, logTail: row.log_tail, eventCount: row.event_count,
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
  };
}
```

Add the equivalent `LeaseRow`, `rawToLeaseRow`, `rowToLease` (columns from Step 2; `owner_kind` narrowed to `LeaseOwnerKind`, `release_cause` to `LeaseReleaseCause`).

- [ ] **Step 4: Implement the store methods**

In `store.ts`, following the `saveDecisionGate` / `listDecisionGates` style:

```ts
  async createWakeup(w: Wakeup): Promise<void> {
    await this.db.query(
      `INSERT INTO engine_wakeups (id, session_id, thread_id, kind, status, reason, command, prompt, exec_id, lease_id,
         fire_at, deadline_at, exit_code, cause, log_offset, log_tail, event_count, created_at, updated_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [w.id, w.sessionId, w.threadId, w.kind, w.status, w.reason, w.command ?? null, w.prompt ?? null, w.execId ?? null,
       w.leaseId ?? null, w.fireAt ?? null, w.deadlineAt ?? null, w.exitCode ?? null, w.cause ?? null, w.logOffset,
       w.logTail, w.eventCount, w.createdAt, w.updatedAt, w.endedAt ?? null],
    );
  }

  async getWakeup(id: string): Promise<Wakeup | null> {
    const r = await this.db.query("SELECT * FROM engine_wakeups WHERE id = $1", [id]);
    return r.rows[0] ? rowToWakeup(rawToWakeupRow(r.rows[0])) : null;
  }

  async listWakeups(sessionId: string, statuses?: readonly WakeupStatus[]): Promise<Wakeup[]> {
    const params: unknown[] = [sessionId];
    let where = "session_id = $1";
    if (statuses && statuses.length > 0) { params.push([...statuses]); where += ` AND status = ANY($2)`; }
    const r = await this.db.query(`SELECT * FROM engine_wakeups WHERE ${where} ORDER BY created_at, id`, params);
    return r.rows.map((raw) => rowToWakeup(rawToWakeupRow(raw)));
  }

  async listDueWakeups(now: number, limit: number): Promise<Wakeup[]> {
    const r = await this.db.query(
      `SELECT * FROM engine_wakeups
       WHERE (status = 'running' AND kind IN ('process','watch'))
          OR (status = 'pending' AND kind = 'timer' AND fire_at IS NOT NULL AND fire_at <= $1)
       ORDER BY created_at, id LIMIT $2`,
      [now, limit],
    );
    return r.rows.map((raw) => rowToWakeup(rawToWakeupRow(raw)));
  }

  async transitionWakeup(id: string, from: readonly WakeupStatus[], to: WakeupStatus, patch: WakeupPatch, updatedAt: number): Promise<Wakeup | null> {
    const r = await this.db.query(
      `UPDATE engine_wakeups SET status = $3, updated_at = $4,
         cause = COALESCE($5, cause), exit_code = COALESCE($6, exit_code), ended_at = COALESCE($7, ended_at),
         log_offset = COALESCE($8, log_offset), log_tail = COALESCE($9, log_tail), event_count = COALESCE($10, event_count),
         exec_id = COALESCE($11, exec_id), lease_id = COALESCE($12, lease_id)
       WHERE id = $1 AND status = ANY($2) RETURNING *`,
      [id, [...from], to, updatedAt, patch.cause ?? null, patch.exitCode ?? null, patch.endedAt ?? null,
       patch.logOffset ?? null, patch.logTail ?? null, patch.eventCount ?? null, patch.execId ?? null, patch.leaseId ?? null],
    );
    return r.rows[0] ? rowToWakeup(rawToWakeupRow(r.rows[0])) : null;
  }
```

Leases: `createLease` (plain INSERT), `releaseLease` as `UPDATE engine_leases SET released_at = $2, release_cause = $3 WHERE id = $1 AND released_at IS NULL RETURNING *`, `listActiveLeases` (`WHERE session_id = $1 AND released_at IS NULL ORDER BY created_at`), `listAllActiveLeases`, `countActiveLeases` (`SELECT count(*)::int AS n ...`, read `toNum(r.rows[0].n)`).

- [ ] **Step 5: Add the schema repairs**

In `packages/api/src/lib/drizzle.ts` `SCHEMA_REPAIRS`, add four entries after the existing engine ones (`probe: { kind: "table" }` for each table, `{ kind: "index" }` for `engine_wakeups_due` and `engine_leases_active`), with the DDL from Step 2 as single-line `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements. `describe` strings: `"engine_wakeups table (spec 2026-10-08)"` etc.

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm --filter @valet/store-postgres test` then `pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/store-postgres packages/api/src/lib/drizzle.ts
git commit -m "feat(store-postgres): engine_wakeups and engine_leases tables"
```

---

### Task 4: Detached exec in the policy sandbox

**Files:**
- Modify: `packages/engine/src/sandbox/policy.ts:296-345` (`execJob`, `pollJob`)
- Test: `packages/engine/test/bash-job-mode.test.ts` (add a describe) or a new `packages/engine/test/policy-detached-exec.test.ts`

**Interfaces:**
- Consumes: `ExecOpts.detached` (Task 2).
- Produces: `PolicySandbox.execJob(command, { detached: true })` sends `maxOutputBytes: undefined` to the raw sandbox and does NOT add the exec id to `pendingJobs`; `pollJob` on an id not in `pendingJobs` behaves as today (no deletion needed).

- [ ] **Step 1: Write the failing test**

Find how existing tests construct a `PolicySandbox` (`grep -rn "new PolicySandbox" packages/engine/test | head -3`) and copy that construction. Then:

```ts
describe("PolicySandbox.execJob detached", () => {
  it("omits the output cap and leaves pendingJobCount at zero", async () => {
    const seen: ExecOpts[] = [];
    const raw: FakeSandbox = {
      id: "sb",
      execJob: async (_c, opts) => { seen.push(opts ?? {}); return { execId: "job-9" }; },
      pollJob: async () => ({ status: "running", output: "", nextOffset: 0 }),
      cancelJob: async () => {},
    };
    const policy = makePolicySandbox(raw); // the construction helper from the existing tests
    await policy.execJob("sleep 1000", { detached: true });
    expect(seen[0]?.maxOutputBytes).toBeUndefined();
    expect(policy.pendingJobCount()).toBe(0);
  });

  it("keeps the cap and the pending count for a foreground job", async () => {
    const seen: ExecOpts[] = [];
    const raw: FakeSandbox = { id: "sb", execJob: async (_c, opts) => { seen.push(opts ?? {}); return { execId: "job-1" }; }, pollJob: async () => ({ status: "running", output: "", nextOffset: 0 }), cancelJob: async () => {} };
    const policy = makePolicySandbox(raw);
    await policy.execJob("ls");
    expect(seen[0]?.maxOutputBytes).toBeGreaterThan(0);
    expect(policy.pendingJobCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/engine test policy-detached-exec`
Expected: FAIL (`maxOutputBytes` defined; count 1).

- [ ] **Step 3: Implement**

In `policy.ts` `execJob`:

```ts
    const effectiveOpts: ExecOpts = opts?.detached
      // A detached sandbox process (wakeups spec B4): uncapped output on
      // disk, and no pending-job entry because a lease owns its lifetime.
      ? { ...opts, maxOutputBytes: undefined }
      : { ...opts, maxOutputBytes: opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES };
    ...
        if (!opts?.detached) this.pendingJobs.add(handle.execId);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/engine test policy-detached-exec bash-job-mode`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sandbox/policy.ts packages/engine/test
git commit -m "feat(engine): detached execJob skips the output cap and pending count"
```

---

### Task 5: Wakeup tool argument validation (pure)

**Files:**
- Create: `packages/engine/src/wakeups/validate.ts`
- Test: `packages/engine/test/wakeups-validate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Validation<T> = { ok: true; value: T } | { ok: false; text: string };
  export function validateBackground(args: { background?: boolean; deadline_hours?: number; reason?: string }, limits: WakeupLimits): Validation<{ deadlineHours: number; reason: string }>;
  export function validateWatch(args: { reason: string; max_hours: number }, limits: WakeupLimits): Validation<{ reason: string; maxHours: number }>;
  export function validateWakeAt(args: { at?: string; after_seconds?: number; prompt: string }, now: number, limits: WakeupLimits): Validation<{ fireAt: number; prompt: string }>;
  export function validateHold(args: { hours: number; reason: string }, limits: WakeupLimits): Validation<{ hours: number; reason: string }>;
  export function sleepRefusal(command: string): string | null;   // B3: `^\s*sleep\s+(\d+)` over 300 seconds
  export const BACKGROUND_REFUSAL = (max: number) => `[bash_background] Set deadline_hours (1 to ${max}) and reason when background is true.`;
  export const SLEEP_REFUSAL = "[bash_sleep] Use wake_at to pause for more than 5 minutes.";
  export const WAKEUPS_UNAVAILABLE = "[wakeups_unavailable] this session cannot schedule wakeups.";
  export function wakeupsLimitRefusal(n: number, cap: number): string;  // "[wakeups_limit] This session already has <n> active wakeups and leases (limit <cap>, sandbox.wakeupsPerSession). Cancel one with wakeup_cancel."
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { validateBackground, validateWakeAt, validateHold, validateWatch, sleepRefusal, wakeupsLimitRefusal } from "../src/wakeups/validate.js";

const limits = { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 };

describe("validateBackground", () => {
  it("accepts a deadline inside the lease max and a reason", () => {
    expect(validateBackground({ background: true, deadline_hours: 48, reason: "proof build" }, limits)).toEqual({ ok: true, value: { deadlineHours: 48, reason: "proof build" } });
  });
  it("refuses a missing deadline, a missing reason, or a deadline over the max with the B3 text", () => {
    const text = "[bash_background] Set deadline_hours (1 to 72) and reason when background is true.";
    expect(validateBackground({ background: true, reason: "x" }, limits)).toEqual({ ok: false, text });
    expect(validateBackground({ background: true, deadline_hours: 2 }, limits)).toEqual({ ok: false, text });
    expect(validateBackground({ background: true, deadline_hours: 100, reason: "x" }, limits)).toEqual({ ok: false, text });
    expect(validateBackground({ background: true, deadline_hours: 0.5, reason: "x" }, limits)).toEqual({ ok: false, text });
  });
});

describe("validateWakeAt", () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  it("accepts after_seconds in range", () => {
    expect(validateWakeAt({ after_seconds: 7200, prompt: "Check the proof report" }, now, limits)).toEqual({ ok: true, value: { fireAt: now + 7_200_000, prompt: "Check the proof report" } });
  });
  it("accepts an ISO `at` in the future", () => {
    expect(validateWakeAt({ at: "2026-10-08T14:00:00Z", prompt: "p" }, now, limits)).toEqual({ ok: true, value: { fireAt: now + 7_200_000, prompt: "p" } });
  });
  it("refuses both or neither, under 60s, past, or over timerMaxHours", () => {
    for (const bad of [{ prompt: "p" }, { at: "2026-10-08T14:00:00Z", after_seconds: 60, prompt: "p" }, { after_seconds: 30, prompt: "p" }, { at: "2026-10-08T11:00:00Z", prompt: "p" }, { after_seconds: 720 * 3600 + 1, prompt: "p" }, { after_seconds: 60, prompt: "" }]) {
      const r = validateWakeAt(bad, now, limits);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.text.startsWith("[wake_at]")).toBe(true);
    }
  });
});

describe("validateHold and validateWatch", () => {
  it("bound hours by leaseMaxHours and require a reason", () => {
    expect(validateHold({ hours: 72, reason: "soak" }, limits).ok).toBe(true);
    expect(validateHold({ hours: 73, reason: "soak" }, limits).ok).toBe(false);
    expect(validateHold({ hours: 1, reason: "" }, limits).ok).toBe(false);
    expect(validateWatch({ reason: "ci", max_hours: 72 }, limits).ok).toBe(true);
    expect(validateWatch({ reason: "ci", max_hours: 0 }, limits).ok).toBe(false);
  });
});

describe("sleepRefusal", () => {
  it("refuses sleep over 300 seconds only", () => {
    expect(sleepRefusal("sleep 301")).toBe("[bash_sleep] Use wake_at to pause for more than 5 minutes.");
    expect(sleepRefusal("  sleep 3000 && echo hi")).not.toBeNull();
    expect(sleepRefusal("sleep 300")).toBeNull();
    expect(sleepRefusal("echo sleep 999")).toBeNull();
  });
});

describe("wakeupsLimitRefusal", () => {
  it("names the knob", () => {
    expect(wakeupsLimitRefusal(20, 20)).toBe("[wakeups_limit] This session already has 20 active wakeups and leases (limit 20, sandbox.wakeupsPerSession). Cancel one with wakeup_cancel.");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/engine test wakeups-validate`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `validate.ts`**

Write the functions to satisfy the tests. Rules: `deadline_hours`/`hours`/`max_hours` are numbers, finite, `>= 1`, `<= leaseMaxHours`; `reason` trimmed length 1..200; `prompt` trimmed length 1..4000; `at` parsed with `Date.parse`, must be `> now`; `after_seconds` integer in `[60, timerMaxHours * 3600]`; exactly one of `at`/`after_seconds`. Refusal texts start with the bracketed tag (`[wake_at] …`, `[hold_sandbox] …`, `[watch] …`) and name the valid range.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/engine test wakeups-validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/wakeups/validate.ts packages/engine/test/wakeups-validate.test.ts
git commit -m "feat(engine): pure validation for wakeup tool arguments"
```

---

### Task 6: Wakeup tools

**Files:**
- Create: `packages/engine/src/builtin-tools/wakeups.ts`
- Modify: `packages/engine/src/builtin-tools/index.ts` (register in `builtinTools` after `bashTool`)
- Test: `packages/engine/test/wakeup-tools.test.ts`

**Interfaces:**
- Consumes: `ToolContext.wakeups` (`WakeupsSeam`, Task 2), validators (Task 5).
- Produces: `watchTool`, `wakeAtTool`, `holdSandboxTool`, `processReadTool`, `wakeupListTool`, `wakeupCancelTool` (all `ToolDef`), and `startBackgroundProcess(ctx, command, value)` used by `bash` in Task 7.

- [ ] **Step 1: Write the failing tests**

Build a `makeCtx(seam: Partial<WakeupsSeam>)` helper like `bash-job-mode.test.ts`'s `makeCtx`, with `wakeups: { limits, create: vi.fn(), hold: vi.fn(), get: vi.fn(), list: vi.fn(), cancel: vi.fn(), readLog: vi.fn(), ...seam }`. Tests:

```ts
it("watch starts a watch wakeup and reports the id", async () => {
  const create = vi.fn(async () => ({ wakeup: { ...baseWakeup, id: "wk_w", kind: "watch" }, lease: { ...baseLease, id: "ls_w" } }));
  const r = await watchTool.execute({ command: "tail -f out.log", reason: "ci", max_hours: 2 }, makeCtx({ create }));
  expect(create).toHaveBeenCalledWith("t1", { kind: "watch", command: "tail -f out.log", reason: "ci", maxHours: 2 });
  expect(r.text).toContain("started watch wk_w");
});

it("wake_at schedules a timer and echoes the ISO time", async () => {
  const create = vi.fn(async () => ({ wakeup: { ...baseWakeup, id: "wk_t", kind: "timer", status: "pending", fireAt: 1_700_000_000_000 } }));
  const r = await wakeAtTool.execute({ after_seconds: 7200, prompt: "Check the proof report" }, makeCtx({ create }));
  expect(create.mock.calls[0]?.[1]).toMatchObject({ kind: "timer", prompt: "Check the proof report" });
  expect(r.text).toBe("scheduled wakeup wk_t at 2023-11-14T22:13:20.000Z");
});

it("hold_sandbox creates a lease", async () => {
  const hold = vi.fn(async () => ({ ...baseLease, id: "ls_h", deadlineAt: 1_700_000_000_000 }));
  const r = await holdSandboxTool.execute({ hours: 48, reason: "manual run" }, makeCtx({ hold }));
  expect(r.text).toBe("holding sandbox until 2023-11-14T22:13:20.000Z (lease ls_h)");
});

it("process_read returns the slice and nextOffset", async () => {
  const readLog = vi.fn(async () => ({ text: "hello", nextOffset: 5, eof: false }));
  const r = await processReadTool.execute({ id: "wk_a", offset: 0, bytes: 4096 }, makeCtx({ readLog }));
  expect(r.text).toBe("hello\n[nextOffset 5]");
});

it("process_read marks eof", async () => {
  const readLog = vi.fn(async () => ({ text: "", nextOffset: 5, eof: true }));
  const r = await processReadTool.execute({ id: "wk_a", offset: 5 }, makeCtx({ readLog }));
  expect(r.text).toBe("(no new output)\n[nextOffset 5] [eof]");
});

it("wakeup_list renders one line per row and a hold lease", async () => {
  const list = vi.fn(async () => ({ wakeups: [{ ...baseWakeup, id: "wk_a", reason: "proof build", deadlineAt: 1_700_000_000_000 }], leases: [{ ...baseLease, id: "ls_h", ownerKind: "hold", reason: "manual", deadlineAt: 1_700_000_000_000 }] }));
  const r = await wakeupListTool.execute({}, makeCtx({ list }));
  expect(r.text).toContain("wk_a process running \"proof build\" deadline 2023-11-14T22:13:20.000Z");
  expect(r.text).toContain("ls_h hold \"manual\" deadline 2023-11-14T22:13:20.000Z");
});

it("wakeup_cancel reports the kind and unknown ids", async () => {
  expect((await wakeupCancelTool.execute({ id: "wk_a" }, makeCtx({ cancel: vi.fn(async () => ({ kind: "wakeup" })) }))).text).toBe("cancelled wk_a");
  expect((await wakeupCancelTool.execute({ id: "nope" }, makeCtx({ cancel: vi.fn(async () => null) }))).text).toBe("[wakeup_cancel] nope is not an active wakeup or lease. Call wakeup_list to see active ids.");
});

it("every tool refuses without the seam", async () => {
  const ctx = makeCtx({}); delete ctx.wakeups;
  for (const [tool, args] of [[watchTool, { command: "x", reason: "r", max_hours: 1 }], [wakeAtTool, { after_seconds: 60, prompt: "p" }], [holdSandboxTool, { hours: 1, reason: "r" }], [processReadTool, { id: "x" }], [wakeupListTool, {}], [wakeupCancelTool, { id: "x" }]] as const) {
    expect((await tool.execute(args, ctx)).text).toBe("[wakeups_unavailable] this session cannot schedule wakeups.");
  }
});

it("refuses over the per-session limit", async () => {
  const list = vi.fn(async () => ({ wakeups: Array.from({ length: 20 }, (_, i) => ({ ...baseWakeup, id: `wk_${i}` })), leases: [] }));
  const r = await wakeAtTool.execute({ after_seconds: 60, prompt: "p" }, makeCtx({ list }));
  expect(r.text).toBe("[wakeups_limit] This session already has 20 active wakeups and leases (limit 20, sandbox.wakeupsPerSession). Cancel one with wakeup_cancel.");
});
```

(`baseWakeup`/`baseLease` are full `Wakeup`/`Lease` literals; `t1` is the ctx threadId.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/engine test wakeup-tools`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `wakeups.ts`**

Each tool: `const seam = ctx.wakeups; if (!seam) return { text: WAKEUPS_UNAVAILABLE };`. Create tools call a shared `async function assertUnderLimit(seam): Promise<string | null>` that lists and returns `wakeupsLimitRefusal(n, seam.limits.perSession)` when `wakeups.filter(nonTerminal).length + leases.length >= perSession`. Tool descriptions (verbatim contracts):

- `watch`: "Run a command in the background and receive each stdout line as a `watch.event` signal. The sandbox stays awake until the command exits or `max_hours` passes. Use it to follow a log or poll an external system. Keep the command's output to the lines you would act on."
- `wake_at`: "Pause this thread and wake it later with `prompt` as the input. Give `at` (ISO 8601) or `after_seconds` (60 to the deploy max). The sandbox may hibernate while you wait; this costs nothing. Use it instead of `sleep`."
- `hold_sandbox`: "Keep this sandbox running for `hours` even when idle, for example while a person works in the terminal. Give a `reason`; it is shown to people. A background `bash` already holds the sandbox, so do not add a hold for it."
- `process_read`: "Read a slice of a background process's log by byte `offset` (default 0) and `bytes` (default 4096, max 65536). The result ends with `[nextOffset N]` and `[eof]` when the process has exited and no bytes remain."
- `wakeup_list`: "List this session's active background processes, watches, timers, and holds with their ids and deadlines."
- `wakeup_cancel`: "Cancel a background process, watch, timer, or hold by id. A process or watch is killed and its lease released."

`startBackgroundProcess(ctx, command, value: { deadlineHours; reason })` returns a `ToolResult`: checks the seam and the limit, calls `seam.create(ctx.threadId, { kind: "process", command, reason, deadlineHours })`, and returns `started sandbox process <id> (deadline <ISO>). You will receive a process.exited signal. Read its log with process_read.`

Register the six tools in `builtinTools` after `bashTool`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/engine test wakeup-tools`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/builtin-tools packages/engine/test/wakeup-tools.test.ts
git commit -m "feat(engine): watch, wake_at, hold_sandbox, process_read, wakeup tools"
```

---

### Task 7: `bash` background mode and sleep refusal

**Files:**
- Modify: `packages/engine/src/builtin-tools/index.ts` (`bashTool`, ~line 290; timeout text in `pollJobToCompletion` ~line 136 and the sync path)
- Test: `packages/engine/test/bash-background.test.ts`

**Interfaces:**
- Consumes: `startBackgroundProcess` (Task 6), `validateBackground`, `sleepRefusal` (Task 5).
- Produces: `bash` parameters `background?: boolean`, `deadline_hours?: number`, `reason?: string`.

- [ ] **Step 1: Write the failing tests**

```ts
it("background: true with deadline and reason starts a process and returns at once", async () => {
  const create = vi.fn(async () => ({ wakeup: { ...baseWakeup, id: "wk_p", deadlineAt: 1_700_000_000_000 }, lease: baseLease }));
  const ctx = makeCtx({ id: "sb" }, { create });
  const r = await bashTool.execute({ command: "lake build", background: true, deadline_hours: 48, reason: "full proof build" }, ctx);
  expect(create).toHaveBeenCalledWith("t1", { kind: "process", command: "lake build", reason: "full proof build", deadlineHours: 48 });
  expect(r.text).toBe("started sandbox process wk_p (deadline 2023-11-14T22:13:20.000Z). You will receive a process.exited signal. Read its log with process_read.");
});

it("background without deadline or reason refuses and starts nothing", async () => {
  const create = vi.fn();
  const r = await bashTool.execute({ command: "lake build", background: true }, makeCtx({ id: "sb" }, { create }));
  expect(r.text).toBe("[bash_background] Set deadline_hours (1 to 72) and reason when background is true.");
  expect(create).not.toHaveBeenCalled();
});

it("foreground sleep over 300s is refused", async () => {
  const exec = vi.fn();
  const r = await bashTool.execute({ command: "sleep 3600" }, makeCtx({ id: "sb", exec }));
  expect(r.text).toBe("[bash_sleep] Use wake_at to pause for more than 5 minutes.");
  expect(exec).not.toHaveBeenCalled();
});

it("the job-mode timeout text points at background mode", async () => {
  // reuse the job-mode harness from bash-job-mode.test.ts with a job that never finishes and timeout 61
  ...
  expect(r.text).toContain("[timed out after 61s] For work longer than an hour, rerun with background: true and a deadline_hours.");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/engine test bash-background`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `bashTool.parameters` add `background: Type.Optional(Type.Boolean())`, `deadline_hours: Type.Optional(Type.Number())`, `reason: Type.Optional(Type.String())`. Extend the description with: "`background: true` starts the command as a detached sandbox process and returns at once; give `deadline_hours` and `reason`. The thread receives a `process.exited` signal when it ends. Use it for work longer than an hour."

At the top of `execute`:

```ts
    if (args.background) {
      const limits = ctx.wakeups?.limits ?? { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 };
      const v = validateBackground(args, limits);
      if (!v.ok) return { text: v.text };
      return startBackgroundProcess(ctx, args.command, v.value);
    }
    const sleep = sleepRefusal(args.command);
    if (sleep) return { text: sleep };
```

Change the timeout note in `pollJobToCompletion` and the sync path to `[timed out after ${s}s] For work longer than an hour, rerun with background: true and a deadline_hours.`; update any existing test that asserts the old text (`grep -rn "timed out after" packages/engine/test`).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/engine test bash-background bash-job-mode bash-truncation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/builtin-tools/index.ts packages/engine/test
git commit -m "feat(engine): bash background mode, sleep refusal, timeout hint"
```

---

### Task 8: `task` tool carries `resources.scratch`

**Files:**
- Modify: `packages/engine/src/builtin-tools/index.ts` (`taskTool`, ~line 804)
- Test: `packages/engine/test/task-tool-scratch.test.ts`

**Interfaces:**
- Consumes: `ScratchRequestError`, `isScratchRequestError` from `@valet/shared` (Task 1); `SpawnChildRequest.resources.scratch` (Task 2).
- Produces: `task.resources.scratch` passed through verbatim (trimmed); a `ScratchRequestError` thrown by the spawner returns `[task_resources] <message>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("passes resources.scratch to the spawner trimmed", async () => {
  const spawner = vi.fn(async () => ({ childSessionId: "c1", queueItemId: "q1" }));
  const r = await taskTool.execute({ prompt: "p", resources: { scratch: " 50Gi " } }, makeCtx({ config: { childSpawner: spawner } }));
  expect(spawner.mock.calls[0]?.[0].resources).toEqual({ scratch: "50Gi" });
  expect(r.text).toContain("spawned child session c1");
});

it("renders a ScratchRequestError from the spawner as a task_resources refusal", async () => {
  const spawner = vi.fn(async () => { throw new ScratchRequestError("agent_cap", "scratch 200Gi exceeds the 100Gi agent cap (sandbox.scratchAgentMax). Declare it in .valet/prebuild.yaml, or ask an admin to raise the cap."); });
  const r = await taskTool.execute({ prompt: "p", resources: { scratch: "200Gi" } }, makeCtx({ config: { childSpawner: spawner } }));
  expect(r.text).toBe("[task_resources] scratch 200Gi exceeds the 100Gi agent cap (sandbox.scratchAgentMax). Declare it in .valet/prebuild.yaml, or ask an admin to raise the cap.");
});

it("refuses a non-string scratch before calling the spawner", async () => {
  const spawner = vi.fn();
  const r = await taskTool.execute({ prompt: "p", resources: { scratch: "nope" } }, makeCtx({ config: { childSpawner: spawner } }));
  expect(r.text).toBe('[task_resources] scratch "nope" is not a Kubernetes quantity of at least 1Gi. Use a form like "200Gi".');
  expect(spawner).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/engine test task-tool-scratch`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `taskTool.parameters.resources` add `scratch: Type.Optional(Type.String({ description: 'Node-local /scratch size for the child as a Kubernetes quantity, such as "200Gi". Wiped when the child\'s sandbox stops. Bounded by the deploy agent cap.' }))`. In `execute`, after the memory check:

```ts
      const scratchRaw = args.resources.scratch;
      let normalizedScratch: string | undefined;
      if (scratchRaw !== undefined) {
        // Syntax only here; the spawner applies the deploy and agent caps
        // (spec A4) because the caps live in api config.
        const text = typeof scratchRaw === "string" ? scratchRaw.trim() : "";
        const bytes = text ? parseResourceQuantity(text) : null;
        if (bytes === null || bytes < MIN_SCRATCH_BYTES) {
          return { text: `[task_resources] scratch "${String(scratchRaw)}" is not a Kubernetes quantity of at least 1Gi. Use a form like "200Gi".` };
        }
        normalizedScratch = text;
      }
      resources = { ...cpu, ...memory, ...(normalizedScratch !== undefined ? { scratch: normalizedScratch } : {}) };
```

Wrap the `spawner(...)` call: `try { ... } catch (err) { if (isScratchRequestError(err)) return { text: `[task_resources] ${err.message}` }; throw err; }`. Extend the `task` description with "`resources.scratch` requests node-local scratch disk for the child, bounded by the deploy agent cap."

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/engine test task-tool-scratch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/builtin-tools/index.ts packages/engine/test/task-tool-scratch.test.ts
git commit -m "feat(engine): task tool accepts resources.scratch"
```

---

### Task 9: Engine metrics for wakeups and leases

**Files:**
- Modify: `packages/engine/src/metrics.ts`
- Test: `packages/engine/test/metrics.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export function recordWakeupEnded(kind: WakeupKind, cause: WakeupCause): void;        // valet.wakeups.total {kind, cause}
  export function recordWakeupsActive(kind: WakeupKind, count: number): void;          // valet.wakeups.active gauge (observable or last-set)
  export function recordLeasesActive(ownerKind: LeaseOwnerKind, count: number): void;  // valet.leases.active
  export function recordLeaseNodeSeconds(ownerKind: LeaseOwnerKind, seconds: number): void; // valet.leases.node_seconds
  export function recordLeasesOverDeadline(count: number): void;                       // valet.leases.over_deadline
  export function recordLeasesUnannotated(count: number): void;                        // valet.leases.unannotated
  export function recordScratchRequested(sessionClass: string, bytes: number): void;   // valet.sandbox.scratch.requested_bytes
  export function recordScratchRefused(source: string, reason: string): void;          // valet.sandbox.scratch.refused
  ```

- [ ] **Step 1: Write the failing test**

Follow the style of the existing `metrics.test.ts` (it reads the in-memory exporter). Assert each function records the named instrument with its labels.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/engine test metrics`

- [ ] **Step 3: Implement**

Add the instruments to the `instruments` object (counters for totals/refused, gauges via the same mechanism the file uses for `sandboxFlagged`-style re-emitted values; for the gauges use `meter.createUpDownCounter` set-by-delta or the file's existing gauge helper, whichever it already uses). Descriptions in the file's style, each naming what a sustained non-zero value means.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/engine test metrics`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/metrics.ts packages/engine/test/metrics.test.ts
git commit -m "feat(engine): wakeup, lease, and scratch metrics"
```

---

### Task 10: Kubernetes manifest: scratch emptyDir, env, ephemeral sums

**Files:**
- Modify: `packages/sandbox-kubernetes/src/types.ts` (`SandboxResourceOpts` ~117)
- Modify: `packages/sandbox-kubernetes/src/manifest.ts` (`mergeResourceOpts` ~150, `resourceRequirementsFrom` ~194, container assembly ~283-300, volumes ~470-495)
- Modify: `packages/sandbox-kubernetes/src/provider.ts` (~787: the live-pod resource drift comparison must treat `scratch` as authoritative; find it with `grep -n "resourceOverrides\|resources.cpu\|resources.memory" packages/sandbox-kubernetes/src/provider.ts packages/sandbox-kubernetes/src/lifecycle.ts`)
- Test: `packages/sandbox-kubernetes/test/manifest.test.ts`

**Interfaces:**
- Consumes: `SandboxCreateOpts.resources.scratch` (Task 2).
- Produces: `SCRATCH_VOLUME_NAME = "scratch"`, `SCRATCH_MOUNT_PATH = "/scratch"`, `export function ephemeralStorageSums(scratch: string | undefined, request: string | undefined, limit: string | undefined): { request?: string; limit?: string }`.

- [ ] **Step 1: Write the failing tests**

In `manifest.test.ts` (copy the file's existing `buildSandboxCR` call pattern and `cfg` fixture):

```ts
describe("scratch", () => {
  it("adds the emptyDir, mount, TMPDIR, and the ephemeral sums", () => {
    const cr = buildSandboxCR(cfgWith({ defaultResources: { ephemeralStorage: "2Gi", ephemeralStorageLimit: "30Gi" } }), { ...baseOpts, resources: { scratch: "800Gi" } }, "s1");
    const c = cr.spec.podTemplate.spec.containers.find((x) => x.name === "sandbox")!;
    expect(cr.spec.podTemplate.spec.volumes).toContainEqual({ name: "scratch", emptyDir: { sizeLimit: "800Gi" } });
    expect(c.volumeMounts).toContainEqual({ name: "scratch", mountPath: "/scratch" });
    expect(c.env).toContainEqual({ name: "TMPDIR", value: "/scratch/tmp" });
    expect(c.resources?.requests?.["ephemeral-storage"]).toBe("802Gi");
    expect(c.resources?.limits?.["ephemeral-storage"]).toBe("830Gi");
  });

  it("uses scratch alone when a deploy knob is disabled", () => {
    const cr = buildSandboxCR(cfgWith({ defaultResources: { ephemeralStorage: "2Gi" } }), { ...baseOpts, resources: { scratch: "100Gi" } }, "s1");
    const c = cr.spec.podTemplate.spec.containers.find((x) => x.name === "sandbox")!;
    expect(c.resources?.requests?.["ephemeral-storage"]).toBe("102Gi");
    expect(c.resources?.limits?.["ephemeral-storage"]).toBe("100Gi");
  });

  it("is byte-identical to today without scratch", () => {
    const a = buildSandboxCR(baseCfg, baseOpts, "s1");
    const b = buildSandboxCR(baseCfg, { ...baseOpts, resources: { cpu: 1 } }, "s1");
    expect(JSON.stringify(a)).not.toContain("scratch");
    expect(JSON.stringify(b)).not.toContain("scratch");
  });

  it("ephemeralStorageSums adds quantities", () => {
    expect(ephemeralStorageSums("800Gi", "2Gi", "30Gi")).toEqual({ request: "802Gi", limit: "830Gi" });
    expect(ephemeralStorageSums(undefined, "2Gi", "30Gi")).toEqual({ request: "2Gi", limit: "30Gi" });
    expect(ephemeralStorageSums("1Ti", undefined, undefined)).toEqual({ request: "1Ti", limit: "1Ti" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/sandbox-kubernetes test manifest`

- [ ] **Step 3: Implement**

- `SandboxResourceOpts.scratch?: string`; `mergeResourceOpts` copies `scratch` when defined.
- `ephemeralStorageSums`: parse with `parseStorageQuantity`, add, format with `formatStorageQuantity`; an absent term is `0`; both absent and no scratch → `{}`.
- `resourceRequirementsFrom`: replace the two ephemeral lines with the sums (`const sums = ephemeralStorageSums(resources.scratch, resources.ephemeralStorage, resources.ephemeralStorageLimit)`).
- Container: when `resourceOpts?.scratch`, push `{ name: SCRATCH_VOLUME_NAME, mountPath: SCRATCH_MOUNT_PATH }` to `volumeMounts`, `{ name: "TMPDIR", value: "/scratch/tmp" }` to `env`, and `{ name: SCRATCH_VOLUME_NAME, emptyDir: { sizeLimit: resourceOpts.scratch } }` to `podSpec.volumes`.
- Provider drift: wherever cpu/memory on the live pod are compared to the desired resources to decide a pod recreate, include `scratch`. Add a provider test next to the existing resource-drift test (`grep -n "drift\|recreat" packages/sandbox-kubernetes/test/provider.test.ts`).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/sandbox-kubernetes test manifest provider quantity`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-kubernetes
git commit -m "feat(sandbox-k8s): scratch emptyDir with ephemeral-storage sums"
```

---

### Task 11: Kubernetes eviction protection

**Files:**
- Modify: `packages/sandbox-kubernetes/src/lifecycle.ts` (`SandboxPodsApi` ~339, `podsApiAdapter` ~377)
- Modify: `packages/sandbox-kubernetes/src/provider.ts` (add the two `SandboxProvider` methods)
- Test: `packages/sandbox-kubernetes/test/provider.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lifecycle.ts
  export const EVICTION_PROTECT_ANNOTATION = "cluster-autoscaler.kubernetes.io/safe-to-evict";
  export const LEASED_LABEL = "valet.dev/leased";
  export interface SandboxPodsApi {
    listNamespacedPod(params: ListPodsParams): Promise<{ items: PodSummary[] }>;
    patchNamespacedPod(params: { name: string; namespace: string; body: unknown }): Promise<unknown>;
  }
  // provider.ts
  async setEvictionProtection(id: string, enabled: boolean): Promise<{ changed: boolean }>;
  async listEvictionProtected(): Promise<string[]>;   // sandbox ids (CR names) whose pod carries LEASED_LABEL=true
  ```
- `PodSummary` must expose `metadata.annotations` and `metadata.labels` (extend the projection in `podsApiAdapter` if absent).

- [ ] **Step 1: Write the failing tests**

```ts
it("setEvictionProtection patches the annotation and label once, then reports unchanged", async () => {
  const patches: unknown[] = [];
  const pods = fakePodsApi({ listNamespacedPod: async () => ({ items: [podSummary({ name: "sb-1-abc", labels: { "valet.dev/session-id": "sb-1" } })] }), patchNamespacedPod: async (p) => { patches.push(p.body); } });
  const provider = makeProvider({ podsApi: pods });
  expect(await provider.setEvictionProtection("sb-1", true)).toEqual({ changed: true });
  expect(patches[0]).toEqual({ metadata: { annotations: { "cluster-autoscaler.kubernetes.io/safe-to-evict": "false" }, labels: { "valet.dev/leased": "true" } } });
  pods.setPod(podSummary({ name: "sb-1-abc", annotations: { "cluster-autoscaler.kubernetes.io/safe-to-evict": "false" }, labels: { "valet.dev/leased": "true" } }));
  expect(await provider.setEvictionProtection("sb-1", true)).toEqual({ changed: false });
});

it("setEvictionProtection false removes both with a null merge patch", async () => { ... expect(body).toEqual({ metadata: { annotations: { "cluster-autoscaler.kubernetes.io/safe-to-evict": null }, labels: { "valet.dev/leased": null } } }); });

it("listEvictionProtected returns the CR names of labelled pods", async () => { ... labelSelector "valet.dev/leased=true" ... });

it("setEvictionProtection on a sandbox with no pod returns changed:false", async () => { ... });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/sandbox-kubernetes test provider`

- [ ] **Step 3: Implement**

`podsApiAdapter.patchNamespacedPod` calls `api.patchNamespacedPod(params, setHeaderOptions("Content-Type", "application/merge-patch+json"))` (same device as `patchNamespacedCustomObject`). Provider: resolve the pod with the existing `resolvePodName` helper, compare current annotation/label, patch only on difference. `listEvictionProtected`: `listNamespacedPod({ namespace, labelSelector: "valet.dev/leased=true" })` and map each pod to its `valet.dev/session-id` label (the CR name).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/sandbox-kubernetes test provider lifecycle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-kubernetes
git commit -m "feat(sandbox-k8s): eviction protection for leased sandboxes"
```

---

### Task 12: Docker `/scratch` and start scripts

**Files:**
- Modify: `packages/sandbox-docker/src/sandbox.ts` (run args ~336, create opts ~295, destroy ~710)
- Modify: `docker/start-headless.sh`, `docker/start-full.sh`
- Test: `packages/sandbox-docker/test/*` (find the create-args test: `grep -rln "bindMount\|credsHostDir" packages/sandbox-docker/test`)

**Interfaces:**
- Produces: when `opts.resources?.scratch` is set, the docker sandbox bind-mounts a host dir (sibling of `credsHostDir(sandboxId)`, named `scratchHostDir(sandboxId)`) at `/scratch`, sets `TMPDIR=/scratch/tmp`, deletes the dir on destroy, and `create()` returns the warning `scratch is not size-limited on the docker backend.` through the existing warnings channel (`grep -n "warnings" packages/sandbox-docker/src/sandbox.ts`; if create has no warnings channel, log with `console.warn` and note it in the spec Deviations).

- [ ] **Step 1: Write the failing test**

Assert the run args contain `-v <dir>:/scratch` and `-e TMPDIR=/scratch/tmp` when scratch is set, and neither when it is not; assert destroy removes the dir.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/sandbox-docker test`

- [ ] **Step 3: Implement**

Mirror the `credsHostDir` plumbing for `scratchHostDir`. In both start scripts, before the final `exec`:

```sh
if [ -d /scratch ]; then
  mkdir -p /scratch/tmp /scratch/valet-jobs
  chmod 1777 /scratch/tmp
  # Background process logs live on scratch when it exists (spec B4).
  ln -sfn /scratch/valet-jobs /tmp/valet-jobs
fi
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/sandbox-docker test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-docker docker/start-headless.sh docker/start-full.sh
git commit -m "feat(sandbox-docker): /scratch bind mount and scratch-backed job logs"
```

---

### Task 13: api config, prebuild.yaml, saved defaults, and `task` caps

**Files:**
- Modify: `packages/api/src/providers/sandbox-backend.ts` (after `resolveSandboxWorkspaceStorageMax` ~401)
- Modify: `packages/api/src/prebuilds/recipe.ts` (~195, resources parsing)
- Modify: `packages/api/src/engine/resolve-repo-resources.ts` (`RESOURCE_FIELDS`)
- Modify: `packages/api/src/wire/types.ts:4372` (`sandboxResources` adds `scratch?: string`)
- Modify: `packages/api/src/routes/sources.ts:279-308`
- Modify: `packages/api/src/orchestrator/children.ts` (`buildChildSpawner`, before the `agentSessions` insert ~line 350; `ChildrenDeps` gains `scratchCaps: ScratchCaps`)
- Modify: `packages/api/src/providers/node.ts` (pass `scratchCaps` into `childrenDeps`)
- Modify: `packages/api/src/schema/index.ts:386` type comment only (jsonb `$type<PrebuildResources>` widens automatically)
- Modify: `docs/environment-variables.md` (Sandboxes table)
- Tests: `packages/api/src/providers/sandbox-backend.test.ts`, `packages/api/src/prebuilds/recipe.test.ts`, `packages/api/src/engine/resolve-repo-resources.test.ts`, `packages/api/src/routes/sources.test.ts`, `packages/api/src/orchestrator/children.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function resolveSandboxScratchMax(env: NodeJS.ProcessEnv): string | undefined;       // VALET_SANDBOX_SCRATCH_MAX, default undefined ("0" or unset = disabled)
  export function resolveSandboxScratchAgentMax(env: NodeJS.ProcessEnv): string | undefined;  // VALET_SANDBOX_SCRATCH_AGENT_MAX, default "100Gi"
  export function resolveScratchCaps(env: NodeJS.ProcessEnv): ScratchCaps;                    // throws at boot when agentMax > max (both set)
  ```

- [ ] **Step 1: Write the failing tests**

- `sandbox-backend.test.ts`: `resolveScratchCaps({})` → `{ agentMax: "100Gi" }`; `{ VALET_SANDBOX_SCRATCH_MAX: "1Ti" }` → `{ max: "1Ti", agentMax: "100Gi" }`; `{ VALET_SANDBOX_SCRATCH_MAX: "50Gi", VALET_SANDBOX_SCRATCH_AGENT_MAX: "100Gi" }` throws `VALET_SANDBOX_SCRATCH_AGENT_MAX (effective "100Gi") exceeds VALET_SANDBOX_SCRATCH_MAX (effective "50Gi"). Lower the agent cap or raise the deploy cap.`; `"0"` disables.
- `recipe.test.ts`: `resources: { scratch: "800Gi" }` parses to `{ scratch: "800Gi" }`; `scratch: 4` throws `.valet/prebuild.yaml: resources.scratch must be a quantity string of at least 1Gi — use resources: { scratch: "200Gi" }`; `"500Mi"` throws the same.
- `resolve-repo-resources.test.ts`: a saved `{ scratch: "100Gi" }` merges under a yaml `{ cpu: 2 }`; `applySandboxResourceOverrides` with `{ scratch: "50Gi" }` sets `resources.scratch`; the preservation mask lists `scratch`.
- `sources.test.ts`: PATCH `sandboxResources: { scratch: "200Gi" }` → 200 and round-trips; `{ scratch: "2Ti" }` → 400 with the A4 deploy-cap text; `{ scratch: "x" }` → 400 with the invalid text. The test app must set `VALET_SANDBOX_SCRATCH_MAX=1Ti` (see how the file sets other env).
- `children.test.ts`: spawning with `resources: { scratch: "200Gi" }` under caps `{ max: "1Ti", agentMax: "100Gi" }` rejects with `ScratchRequestError` and inserts no `agent_sessions` row; `{ scratch: "50Gi" }` persists `sandboxResourceOverrides: { scratch: "50Gi" }`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @valet/api test sandbox-backend recipe resolve-repo-resources sources children`

- [ ] **Step 3: Implement**

- `sandbox-backend.ts`: the two resolvers via `quantityEnv` (default `"0"` for max → `undefined`; `"100Gi"` for agent); `resolveScratchCaps` compares parsed bytes and throws the text above. Wire the boot check into the kubernetes branch next to the workspace check (it is harmless on other backends; call it in `resolveScratchCaps` so every backend validates).
- `recipe.ts`: parse `resources.scratch` as a string, `parseStorageQuantity` ≥ `MIN_SCRATCH_BYTES`; the error texts above. Update the "resources must be a mapping" text to mention scratch.
- `resolve-repo-resources.ts`: `RESOURCE_FIELDS = ["cpu", "memory", "scratch"]`.
- `sources.ts`: allow `scratch`; validate with `validateScratchRequest(value, "saved", deps.scratchCaps)` and return 400 with `err.message` on `ScratchRequestError`. Thread `scratchCaps` into the route deps from `node.ts`.
- `children.ts`: in `buildChildSpawner`, before the transaction: `if (req.resources?.scratch !== undefined) req = { ...req, resources: { ...req.resources, scratch: validateScratchRequest(req.resources.scratch, "task", deps.scratchCaps) } };` (throws `ScratchRequestError`; the task tool renders it).
- `docs/environment-variables.md`: two rows in the Sandboxes table, same style as `VALET_SANDBOX_WORKSPACE_MAX`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @valet/api test sandbox-backend recipe resolve-repo-resources sources children` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api docs/environment-variables.md
git commit -m "feat(api): scratch caps, prebuild.yaml and saved-default scratch, task cap"
```

---

### Task 14: Host applies scratch caps to repo-declared values

**Files:**
- Modify: `packages/api/src/engine/host.ts` (`resolveRepoPrebuildFlags` ~2062; `EngineHostOptions` gains `scratchCaps: ScratchCaps`; child builder ~3760 pushes the warning)
- Create: `packages/api/src/engine/apply-scratch-caps.ts`
- Test: `packages/api/src/engine/apply-scratch-caps.test.ts`, extend `packages/api/src/engine/host.*.test.ts` where `resolveRepoPrebuildFlags` is covered (`grep -rln "resolveRepoPrebuildFlags" packages/api/src/engine/*.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export function applyScratchCaps(flags: ResolvedRepoPrebuildFlags, caps: ScratchCaps): { flags: ResolvedRepoPrebuildFlags; warning?: string };
  ```
  Drops `scratch` from `resources` and `initialResources` when `validateScratchRequest(value, "prebuild", caps)` throws, and returns `warning = "Valet did not apply the repository's scratch setting. " + err.message`. `task`-supplied scratch has already been validated against the agent cap (Task 13), so overrides pass through `source: "saved"` semantics here (deploy cap only).

- [ ] **Step 1: Write the failing tests**

```ts
it("keeps scratch inside the cap", () => {
  const r = applyScratchCaps({ docker: false, outcome: "present", resources: { scratch: "100Gi" }, initialResources: { scratch: "100Gi" } }, { max: "1Ti", agentMax: "100Gi" });
  expect(r.flags.resources).toEqual({ scratch: "100Gi" });
  expect(r.warning).toBeUndefined();
});
it("drops scratch over the deploy cap and returns the warning", () => {
  const r = applyScratchCaps({ docker: false, outcome: "present", resources: { cpu: 2, scratch: "2Ti" }, initialResources: { cpu: 2, scratch: "2Ti" } }, { max: "1Ti" });
  expect(r.flags.resources).toEqual({ cpu: 2 });
  expect(r.flags.initialResources).toEqual({ cpu: 2 });
  expect(r.warning).toBe("Valet did not apply the repository's scratch setting. scratch 2Ti exceeds the 1Ti deploy cap (sandbox.scratchMax). Request at most 1Ti, or ask an admin to raise the cap.");
});
it("drops scratch when scratch is disabled", () => { ... "scratch is not enabled on this deployment. Ask an admin to set sandbox.scratchMax." });
```

Host test: with `scratchCaps: { max: "1Ti" }` and a prebuild.yaml stub declaring `scratch: "2Ti"`, `childSessionFor` pushes the warning into `startupWarnings` and the child's `sandbox.resources` has no `scratch`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @valet/api test apply-scratch-caps host`

- [ ] **Step 3: Implement**

`apply-scratch-caps.ts` as specified. In `resolveRepoPrebuildFlags`, after `applySandboxResourceOverrides`: `const capped = applyScratchCaps(result, this.opts.scratchCaps); if (capped.warning) { console.warn(\`EngineHost: session ${sessionId}: ${capped.warning}\`); recordScratchRefused("prebuild", "cap"); } return capped.flags;`. Expose the warning to the child builder: make `resolveRepoPrebuildFlags` return `{ ...flags, scratchWarning?: string }` and in `childSessionFor` push it to `opts.startupWarnings`. Pass `scratchCaps: resolveScratchCaps(process.env)` where `EngineHost` is constructed in `node.ts`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test apply-scratch-caps host resolve-repo-resources`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/engine packages/api/src/providers/node.ts
git commit -m "feat(api): apply scratch caps to repo-declared resources"
```

---

### Task 15: Wakeups seam and host injection

**Files:**
- Create: `packages/api/src/engine/wakeups-seam.ts`
- Modify: `packages/api/src/engine/host.ts` (all five builders: lines with `extractDocument: extractDocumentText`; `EngineHostOptions` gains `wakeupLimits: WakeupLimits`)
- Modify: `packages/api/src/providers/sandbox-backend.ts` (`resolveWakeupLimits(env)`)
- Modify: `packages/api/src/engine/prompt-rules.ts` (`codingSystemPrompt`)
- Modify: `packages/engine/src/thread.ts:5118` area (pass `wakeups: session.options.wakeups` into the ToolContext)
- Tests: `packages/api/src/engine/wakeups-seam.test.ts`, `packages/api/src/engine/host-builders-wakeups.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WakeupsSeamDeps { engineStore: SessionStore; limits: WakeupLimits; now?: () => number }
  export function buildWakeupsSeam(deps: WakeupsSeamDeps, sessionId: string, session: () => Session | undefined): WakeupsSeam;
  export function resolveWakeupLimits(env: NodeJS.ProcessEnv): WakeupLimits;  // VALET_LEASE_MAX_HOURS 72, VALET_TIMER_MAX_HOURS 720, VALET_WAKEUPS_PER_SESSION 20, VALET_WATCH_MAX_EVENTS_PER_HOUR 120; non-positive integers throw with the knob named
  ```
- Seam behavior:
  - `create(threadId, { kind: "process" | "watch" })`: `const sb = session()?.sandbox; if (!sb?.execJob) throw new Error("[bash_background] this sandbox backend cannot run background processes.")`; `const handle = await sb.execJob(command, { detached: true })`; lease `{ id: newLeaseId(), sessionId, sandboxId: session()?.attachment.sandboxId, ownerKind: kind, ownerId: wakeupId, reason, createdAt: now, deadlineAt: now + hours*3600_000 }`; wakeup `{ ..., status: "running", execId: handle.execId, leaseId }`. Create the lease first, then the wakeup (a crash between leaves a lease the watcher expires at its deadline; acceptable and logged).
  - `create(threadId, { kind: "timer" })`: wakeup `{ status: "pending", prompt, fireAt, reason: prompt.slice(0, 80) }`, no lease.
  - `hold`: lease with `ownerKind: "hold"`, no wakeup.
  - `cancel(id)`: if a wakeup: for process/watch `await sb?.cancelJob?.(execId)` best-effort, `transitionWakeup(id, ["running","pending"], "cancelled", { cause: "cancelled", endedAt: now }, now)`, release its lease with `"cancelled"`; if a lease id: `releaseLease(id, "cancelled", now)`. Returns `null` when neither matched.
  - `readLog(id, offset, bytes)`: `const poll = await sb.pollJob(execId, offset)`; `text = poll.output.slice(0, bytes)`; `nextOffset = offset + Buffer.byteLength(text)`; `eof = poll.status !== "running" && text.length === poll.output.length`.
  - `list`: `listWakeups(sessionId, ["pending","running"])` + `listActiveLeases(sessionId)`.

- [ ] **Step 1: Write the failing tests**

`wakeups-seam.test.ts` with `InMemorySessionStore` and a fake session whose `sandbox` has `execJob`/`pollJob`/`cancelJob` spies: creating a process writes a running wakeup and an active lease with matching ids and `deadlineAt = now + 48h`; creating a timer writes no lease; `cancel` on a process calls `cancelJob`, sets `cancelled`, releases the lease; `readLog` slices and computes `eof`; `create` without `execJob` throws the `[bash_background]` text.

`host-builders-wakeups.test.ts`: a grep test (INV-style, spec Global Constraints):

```ts
it("every session builder injects the wakeups seam", async () => {
  const src = await readFile(new URL("./host.ts", import.meta.url), "utf8");
  const builders = src.match(/extractDocument: extractDocumentText/g)?.length ?? 0;
  const seams = src.match(/\.\.\.this\.wakeupsOptions\(/g)?.length ?? 0;
  expect(builders).toBeGreaterThan(0);
  expect(seams).toBe(builders);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @valet/api test wakeups-seam host-builders-wakeups`

- [ ] **Step 3: Implement**

- `wakeups-seam.ts` per the behavior above.
- `host.ts`: `private wakeupsOptions(sessionId: string, session: () => Session | undefined): { wakeups: WakeupsSeam } { return { wakeups: buildWakeupsSeam({ engineStore: this.opts.engineStore, limits: this.opts.wakeupLimits }, sessionId, session) }; }` and spread `...this.wakeupsOptions(sessionId, () => builtSession)` in each of the five builders (each already has a lazy `builtSession`; where one does not, add it like the repo-instructions provider does).
- `thread.ts`: `wakeups: session.options.wakeups,` in the ToolContext literal.
- `prompt-rules.ts`: add a `BACKGROUND_WORK_RULES` constant included in `codingSystemPrompt`: "## Background work\n\nFor a command longer than an hour, run `bash` with `background: true`, a `deadline_hours`, and a `reason`. You receive a `process.exited` signal when it ends; do not poll it. Use `wake_at` to pause instead of `sleep`. `/scratch` is wiped when the sandbox stops; keep anything you need in /workspace or push it."
- `node.ts`: `wakeupLimits: resolveWakeupLimits(process.env)` into the `EngineHost` options.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @valet/api test wakeups-seam host-builders-wakeups prompt` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src packages/engine/src/thread.ts
git commit -m "feat(api): wakeups seam injected into every session builder"
```

---

### Task 16: `decideWakeup` pure kernel and vectors

**Files:**
- Create: `packages/api/src/engine/wake-watcher-decide.ts`
- Create: `packages/api/src/engine/wake-watcher.vectors.json`
- Test: `packages/api/src/engine/wake-watcher-decide.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WakeupProbe =
    | { kind: "poll"; status: "running" | "done" | "failed"; exitCode?: number; output: string; nextOffset: number }
    | { kind: "unavailable" }
    | { kind: "none" };
  export interface SignalDraft { signalType: string; body: string; attributes: Record<string, string>; dispatchId: string }
  export interface WakeupDecision { to: WakeupStatus; cause?: WakeupCause; patch: WakeupPatch; signals: SignalDraft[]; releaseLease?: LeaseReleaseCause; kill?: boolean }
  export function decideWakeup(now: number, row: Wakeup, probe: WakeupProbe, limits: Pick<WakeupLimits, "watchMaxEventsPerHour">): WakeupDecision | null;
  export const LOG_TAIL_BYTES = 4096;
  ```
- Rules (spec B5/B6):
  - `timer`: `fireAt <= now` → `{ to: "done", cause: "fired", patch: { cause: "fired", endedAt: now }, signals: [timer.fired] }`; else `null`.
  - `process`/`watch`, probe `unavailable` → `lost`, `cause: "sandbox_unavailable"`, `releaseLease: "owner_ended"`, terminal signal.
  - `deadlineAt <= now` → `expired`, `cause: "deadline"`, `kill: true`, `releaseLease: "deadline"`, terminal signal. The watcher acts on `kill` before the CAS.
  - poll `done`/`failed` with `exitCode` defined → `done`, `cause: "exit"`, `exitCode`, `releaseLease: "owner_ended"`.
  - poll `failed` with `exitCode` undefined → `lost`, `cause: "pid_missing"`.
  - poll `running`: `process` → `{ to: "running", patch: { logOffset: nextOffset, logTail: tail(row.logTail + output) }, signals: [] }` (null when nothing changed); `watch` → split `output` into complete lines (keep a trailing partial line out of the event and out of the offset advance), at most 200 lines per tick, `signals: [watch.event]` when lines > 0, `patch.eventCount += lines`; rate: `const hours = Math.max(1, (now - row.createdAt) / 3_600_000); if (row.eventCount + lines > limits.watchMaxEventsPerHour * hours)` → `expired`, `cause: "rate"`, `kill: true`, `releaseLease: "deadline"`, terminal signal whose body names the limit.
  - Terminal signal: type `process.exited` or `watch.exited`; body = last 4096 bytes of `row.logTail + output`; attributes: `wakeupId`, `kind`, `reason`, `cause`, `exitCode` (when exit), `durationSeconds` (`Math.round((now - row.createdAt)/1000)`), `logPath: /tmp/valet-jobs/<execId>.out`; `dispatchId: wakeup:<id>:terminal`. `watch.event` attributes: `wakeupId`, `kind`, `reason`, `lineCount`, `eventCount` (after increment); `dispatchId: wakeup:<id>:event:<eventCount>`. `timer.fired`: body `prompt`, attributes `wakeupId`, `kind`, `reason`, `scheduledAt` (ISO of fireAt), `firedAt` (ISO of now); `dispatchId: wakeup:<id>:terminal`.

- [ ] **Step 1: Write the vectors and the test**

`wake-watcher.vectors.json`: an array of `{ name, now, row, probe, limits, expected }` with the eight cases from the spec Testing section (use `createdAt: 0`, `now: 1000` style small numbers; `expected` is the full `WakeupDecision` or `null`). The test loads the JSON, runs `decideWakeup`, and `expect(result).toEqual(expected)` per vector. Add two more vectors: watch with a trailing partial line (offset advances only past the last `\n`), and process `running` with new output updates `logTail` only.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/api test wake-watcher-decide`

- [ ] **Step 3: Implement `wake-watcher-decide.ts`**

Pure; no imports of Date or I/O. `tail(s)` returns the last `LOG_TAIL_BYTES` bytes of a string by `Buffer.byteLength` accounting (slice by characters from the end until the byte length fits).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test wake-watcher-decide`
Expected: PASS for all vectors.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/engine/wake-watcher-decide.ts packages/api/src/engine/wake-watcher.vectors.json packages/api/src/engine/wake-watcher-decide.test.ts
git commit -m "feat(api): decideWakeup pure kernel with normative vectors"
```

---

### Task 17: WakeWatcher sweep

**Files:**
- Create: `packages/api/src/engine/wake-watcher.ts`
- Modify: `packages/api/src/providers/node.ts` (construct, export), `packages/api/src/main.ts` (start/stop next to `idleHibernationSweep`)
- Test: `packages/api/src/engine/wake-watcher.test.ts`

**Interfaces:**
- Consumes: Task 16 kernel; `SessionStore` wakeup/lease methods; `SandboxProvider.restore`, `setEvictionProtection`, `listEvictionProtected`; `EngineHost.sessionFor` + `loadSessionMeta` (the `ChildWatcher.attempt` pattern, `children.ts:640-672`); metrics (Task 9).
- Produces:
  ```ts
  export interface WakeWatcherDeps {
    db: AppDb;
    engineStore: SessionStore;
    engineHost: Pick<EngineHost, "sessionFor" | "liveSession">;
    provider: SandboxProvider;
    limits: WakeupLimits;
    sweepIntervalMs?: number;   // default 30_000
    now?: () => number;
  }
  export class WakeWatcher { constructor(deps); start(): void; stop(): void; sweep(now?: number): Promise<void>; }
  ```
- Per tick:
  1. `rows = listDueWakeups(now, 200)`.
  2. For each row: probe. `timer` → `{ kind: "none" }`. Else: `sb = this.sandboxFor(row)` (the live session's `attachment` sandbox when `liveSession(sessionId)` is cached and ready; else `provider.restore(sandboxId)` where `sandboxId` comes from the lease row); `probe = await sb.pollJob(execId, row.logOffset)` → `{ kind: "poll", ... }`; a `SandboxUnavailableError`, `SandboxSupersededError`, or a thrown "pod was recreated or removed" → `{ kind: "unavailable" }`; any other error → log and skip the row this tick.
  3. `decision = decideWakeup(now, row, probe, limits)`; null → continue.
  4. If `decision.kill`: best-effort `sb.cancelJob(execId)`.
  5. `updated = await transitionWakeup(row.id, [row.status], decision.to, decision.patch, now)`; null → continue (another process won).
  6. If `decision.releaseLease && updated.leaseId`: `releaseLease(leaseId, cause, now)`.
  7. For each signal: `deliverSignal(updated, signal)`; failure logs and continues (the dispatchId makes a retry on the next tick safe only for terminal rows that are re-delivered; so on delivery failure of a TERMINAL signal, write the failure to `console.error` and increment `recordWakeupEnded(kind, "delivery_failed")`? No: keep the cause union closed. Log only; the row is terminal and the loss is visible in logs. Note this in the spec Deviations.)
  8. `recordWakeupEnded(kind, cause)` on terminal transitions.
  - Lease expiry: `for (const lease of listAllActiveLeases()) if (lease.deadlineAt <= now && lease.ownerKind === "hold")` → `releaseLease(id, "deadline", now)` and deliver `lease.expired` to the session's main thread (`session.prompt(content, { dispatchId: lease:<id>:expired, queueMode: "followup" })`). Process/watch leases expire through their wakeup. Any lease active more than `2 * sweepIntervalMs` past deadline → `recordLeasesOverDeadline(count)` (gauge of the count this tick).
  - Eviction protection: `bySandbox = group active leases by sandboxId`; `for id of bySandbox: const r = await provider.setEvictionProtection?.(id, true); if (r?.changed && oldestLease.createdAt < now - 2*interval) unannotated++`; `for id of (await provider.listEvictionProtected?.() ?? []) if (!bySandbox.has(id)) await provider.setEvictionProtection?.(id, false)`; `recordLeasesUnannotated(unannotated)`; `recordLeasesActive` per owner kind; `recordLeaseNodeSeconds(ownerKind, interval/1000)` per active lease.
- `deliverSignal(row, draft)`: load the `agent_sessions` row, `session = await engineHost.sessionFor(row.sessionId, await loadSessionMeta(db, {...}))` exactly as `ChildWatcher.attempt` does, then `session.prompt({ kind: "signal", signalType, body, attributes, tagName: "wakeup" }, { threadId: row.threadId, dispatchId, queueMode: "followup" })`. If `prompt` throws because the thread id is unknown (check `Session.resolveTargetThread`'s behavior in `session.ts:903`; if it throws for a missing thread, catch and retry without `threadId`).

- [ ] **Step 1: Write the failing tests**

Use `InMemorySessionStore`, a fake provider with `restore` returning a fake sandbox whose `pollJob` is scripted per call, a fake `engineHost.sessionFor` returning `{ prompt: vi.fn() }`, a fixed `now`. Tests:

- process exits with code 0 → row `done/exit`, lease released `owner_ended`, exactly one `prompt` call with `signalType: "process.exited"`, `attributes.exitCode: "0"`, `threadId` from the row, `dispatchId: "wakeup:<id>:terminal"`.
- the same tick twice (simulate a second watcher) → one signal, one release (CAS).
- deadline passed → `cancelJob` called, `expired/deadline`, lease `deadline`.
- `pollJob` throws `SandboxUnavailableError` → `lost/sandbox_unavailable`.
- watch with 3 lines → `watch.event` with `lineCount: "3"`, row still `running`, `logOffset` advanced, lease still active.
- timer due → `timer.fired` with body = prompt, no lease touched, row `done/fired`.
- timer not due → nothing.
- hold lease past deadline → released `deadline`, `lease.expired` delivered.
- restart adoption: create the rows, construct a NEW watcher, sweep → same results as above (no in-memory state).
- eviction: with one active lease on `sb-1`, `setEvictionProtection("sb-1", true)` called; after release and `listEvictionProtected` returning `["sb-1"]`, `setEvictionProtection("sb-1", false)` called.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @valet/api test wake-watcher`

- [ ] **Step 3: Implement**

`wake-watcher.ts` with `startSweepTimer` from `../lib/sweep-timer.js` like the other sweeps. `node.ts`: `const wakeWatcher = new WakeWatcher({ db, engineStore, engineHost, provider: sandboxProvider, limits: resolveWakeupLimits(process.env) })`, export it in the providers object; `main.ts`: `providers.wakeWatcher.start()` after `idleHibernationSweep.start()` and the matching stop.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @valet/api test wake-watcher` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/engine/wake-watcher.ts packages/api/src/engine/wake-watcher.test.ts packages/api/src/providers/node.ts packages/api/src/main.ts
git commit -m "feat(api): WakeWatcher sweep delivers wakeup signals and holds leases"
```

---

### Task 18: Leases hold off idle hibernation and child settlement

**Files:**
- Modify: `packages/api/src/engine/host.ts` (`maybeSuspendIdleSession` ~834)
- Modify: `packages/api/src/engine/idle-hibernation-sweep.ts` (`maybeHibernate` ~105; `engineStore` dep gains `countActiveLeases`)
- Modify: `packages/api/src/orchestrator/children.ts` (`ChildWatcher.attempt`, after `awaitResult` ~672)
- Tests: `packages/api/src/engine/host.idle-sweep.test.ts`, `packages/api/src/engine/idle-hibernation-sweep.test.ts`, `packages/api/src/orchestrator/children.test.ts`

**Interfaces:**
- Consumes: `SessionStore.countActiveLeases` (Task 2).

- [ ] **Step 1: Write the failing tests**

- `host.idle-sweep.test.ts`: an idle, ready session with one active lease is NOT suspended; after `releaseLease` it is.
- `idle-hibernation-sweep.test.ts`: same for the DB sweep (fake `engineStore.countActiveLeases` returning 1 then 0).
- `children.test.ts`: a child whose submission settled while `countActiveLeases(child) === 1` does not produce `child.settled` until the count drops to 0 (use the watcher's `leasePollMs` override set to 1ms).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @valet/api test idle-sweep idle-hibernation-sweep children`

- [ ] **Step 3: Implement**

- `host.ts` `maybeSuspendIdleSession`: after the unsettled check: `if ((await this.opts.engineStore.countActiveLeases(sessionId)) > 0) return;` with the comment `// A lease (wakeups spec C3) keeps the sandbox out of idle suspension.`
- `idle-hibernation-sweep.ts` `maybeHibernate`: same line after the unsettled check; add `countActiveLeases(sessionId: string): Promise<number>` to the `engineStore` dep type.
- `children.ts` `ChildWatcher.attempt`: after `const result = await childSession.thread().awaitResult(watch.queueItemId);` add:

```ts
    // A child with an active lease is not settled (wakeups spec C4): its
    // background process still runs and its terminal signal still owes a
    // turn. Wait here; a lease always has a deadline, so this loop ends.
    while ((await this.deps.engineStore.countActiveLeases(watch.childSessionId)) > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.deps.leasePollMs ?? 30_000).unref());
    }
```

  Then re-run `awaitResult` on the latest submission: after the loop, re-read the child's unsettled submissions; if one exists (the signal turn), `awaitResult` it and loop again. Add `leasePollMs?: number` to `ChildrenDeps`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test idle-sweep idle-hibernation-sweep children`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): leases hold off idle hibernation and child settlement"
```

---

### Task 19: Attachment defers pod-replacing changes while leased

**Files:**
- Modify: `packages/engine/src/sandbox/attachment.ts` (the run-start reconcile ~1030-1090; `SandboxAttachment` options gain `isLeased?: () => Promise<boolean>`)
- Modify: `packages/api/src/engine/host.ts` (pass `isLeased: () => engineStore.countActiveLeases(sessionId).then((n) => n > 0)` where the attachment is constructed; `grep -n "new SandboxAttachment" packages/api/src/engine/host.ts packages/engine/src`)
- Test: `packages/engine/test/attachment-reconcile.test.ts` (extend)

**Interfaces:**
- Produces: when `isLeased()` resolves true and the desired spec would replace the pod (image differs, or an authoritative resource field differs from the applied state), the attachment logs `sandbox <id>: deferring image/resource change while a lease is active` and keeps the current pod. It applies the change at the next run-start window after the lease releases. Prep steps that do not replace the pod still run.

- [ ] **Step 1: Write the failing test**

In `attachment-reconcile.test.ts`, copy the existing "image drift recreates the sandbox" case; with `isLeased: async () => true` assert `provider.create` is NOT called with the new image and the attachment stays `ready`; with `isLeased: async () => false` the existing behavior holds.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/engine test attachment-reconcile`

- [ ] **Step 3: Implement**

Find the branch where `desired.image !== this.createOpts.image` or resources drift drives a replace; guard it with `if (await this.isLeased?.()) { console.log(...); } else { ...existing... }`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/engine test attachment-reconcile attachment-replace attachment-suspend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sandbox/attachment.ts packages/engine/test packages/api/src/engine/host.ts
git commit -m "feat(engine): keep a leased sandbox's pod through spec changes"
```

---

### Task 20: Chart values, env, RBAC, version

**Files:**
- Modify: `deploy/chart/valet/values.yaml` (sandbox block after `ephemeralStorageLimit`)
- Modify: `deploy/chart/valet/templates/configmap.yaml` (after `VALET_SANDBOX_WORKSPACE_MAX`)
- Modify: `deploy/chart/valet/templates/rbac.yaml:37-40` (`pods` verbs add `"patch"`)
- Modify: `deploy/chart/valet/Chart.yaml` (bump `version`)
- Test: `deploy/chart/valet/test/golden.sh` (run it; extend its greps if it asserts the sandbox env block)

- [ ] **Step 1: Add values**

```yaml
  # Node-local /scratch per sandbox (spec 2026-10-08 Part A). scratchMax "0"
  # disables scratch. scratchAgentMax bounds what a `task` child may request;
  # a repo's .valet/prebuild.yaml may declare up to scratchMax.
  scratchMax: "0"
  scratchAgentMax: "100Gi"
  # Wakeups and leases (spec Part D). A lease keeps a sandbox awake and
  # unevictable until its deadline; leaseMaxHours caps every deadline.
  leaseMaxHours: 72
  timerMaxHours: 720
  wakeupsPerSession: 20
  watchMaxEventsPerHour: 120
```

- [ ] **Step 2: Add env**

```yaml
  VALET_SANDBOX_SCRATCH_MAX: {{ .Values.sandbox.scratchMax | quote }}
  VALET_SANDBOX_SCRATCH_AGENT_MAX: {{ .Values.sandbox.scratchAgentMax | quote }}
  VALET_LEASE_MAX_HOURS: {{ .Values.sandbox.leaseMaxHours | quote }}
  VALET_TIMER_MAX_HOURS: {{ .Values.sandbox.timerMaxHours | quote }}
  VALET_WAKEUPS_PER_SESSION: {{ .Values.sandbox.wakeupsPerSession | quote }}
  VALET_WATCH_MAX_EVENTS_PER_HOUR: {{ .Values.sandbox.watchMaxEventsPerHour | quote }}
```

- [ ] **Step 3: RBAC and version**

`verbs: ["get", "list", "patch", "delete"]` with the comment line "`patch` sets the autoscaler safe-to-evict annotation on leased pods (wakeups spec C5)." Bump `Chart.yaml` `version` by one patch level (check the current value first; a number that passed yesterday can be taken today).

- [ ] **Step 4: Run the golden test**

Run: `bash deploy/chart/valet/test/golden.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/chart/valet
git commit -m "feat(chart): scratch, lease, and wakeup values; pods patch RBAC"
```

---

### Task 21: Integration test for the acceptance scenario

**Files:**
- Create: `packages/api/src/integration/wakeups-acceptance.test.ts`
- Read first: `packages/api/src/integration/_setup.ts` and one existing integration test that spawns a child (`grep -ln "childSpawner\|task" packages/api/src/integration/*.test.ts | head -2`).

**Interfaces:**
- Consumes: everything above. Uses the virtual sandbox provider the integration suite already offers (`grep -n "virtual" packages/api/src/integration/_setup.ts`); its sandbox must implement `execJob`/`pollJob`/`cancelJob` (check; if the virtual sandbox lacks them, add a scripted job table to it in this task).

- [ ] **Step 1: Write the test (spec acceptance steps 2, 4, 6, 8, 9, 10)**

With a fake clock injected into the WakeWatcher (`now`) and `sweepIntervalMs` large (call `sweep(now)` by hand):

1. Create a session; `bash { background: true, deadline_hours: 48, reason }` through the thread's tool path (or call the seam directly if the tool path needs a model: use `session.options.wakeups.create(...)`). Assert a running wakeup and an active lease; assert the virtual provider's `setEvictionProtection` spy got `(sandboxId, true)` after one sweep.
2. Rebuild the api providers (simulate restart: construct a new `WakeWatcher` on the same store); sweep; assert no signal and the lease still active.
3. Script the virtual job to exit 0; sweep; assert exactly one `process.exited` signal entry on the thread (`GET /api/sessions/:id/messages` or the store's entries) with `attributes.cause === "exit"`, the lease released, and `setEvictionProtection(sandboxId, false)` after the next sweep.
4. `wake_at { after_seconds: 7200, prompt: "Check the proof report" }`; assert a pending timer and `countActiveLeases === 0`.
5. Advance the clock 2h; sweep; assert a `timer.fired` entry whose body is `Check the proof report`.
6. `task { prompt, resources: { scratch: "200Gi" } }` with caps `{ max: "1Ti", agentMax: "100Gi" }`; assert the `[task_resources]` text and no new `agent_sessions` row.

- [ ] **Step 2: Run it**

Run: `pnpm --filter @valet/api test wakeups-acceptance`
Expected: PASS. Fix whatever it finds; every fix that changes a contract is also a spec erratum (Step 3).

- [ ] **Step 3: Spec errata**

Append to the spec's `## Deviations` section one bullet per divergence found during Tasks 1 to 21. Known at planning time:
- The REST session create route does not accept `resources` today (cpu/memory included); `scratch` on create is deferred to the plan that adds resources there. Spec A1 bullet 5 and Part D "create route" read accordingly.
- `local`/`virtual` backends emit the A5 warning and mount nothing; `/scratch` on a host filesystem is not a sandbox path.
- Docker keeps detached output in api memory (the existing job state), not on disk; acceptable for the dev backend.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/integration/wakeups-acceptance.test.ts docs/specs/2026-10-08-sandbox-scratch-wakeups-leases-design.md
git commit -m "test(api): wakeups acceptance scenario; spec errata"
```

---

### Task 22: Full validation

- [ ] **Step 1: Typecheck and unit suites**

Run: `pnpm typecheck && pnpm --filter @valet/engine test && pnpm --filter @valet/store-postgres test && pnpm --filter @valet/sandbox-kubernetes test && pnpm --filter @valet/sandbox-docker test && pnpm --filter @valet/api test`
Expected: all PASS. (Remember: `model-resolution`/`llm-providers` api tests fail when `ANTHROPIC_API_KEY` is exported; that is environmental.)

- [ ] **Step 2: Wipe dev data (migration edit)**

Run: `make dev-clean` in this worktree.

- [ ] **Step 3: e2e scorecard**

Run: `make e2e 2>&1 | tee /tmp/e2e-wakeups.log`
Expected: clean, or only rows you can name as pre-existing environmental failures (store-postgres local row, the two rancher-desktop sandbox-k8s rows per memory). Re-run any flaked row with `make e2e E2E_ARGS="--only <id>"` before treating it as real.

- [ ] **Step 4: Docker-backend smoke of a real background process**

With `make dev-local` running and `VALET_SANDBOX_SCRATCH_MAX=10Gi` in `.env`: open a session, ask the agent to run `bash { command: "sleep 90; echo done", background: true, deadline_hours: 1, reason: "smoke" }`, wait, confirm the `process.exited` signal renders in the thread and `wakeup_list` empties.

- [ ] **Step 5: Commit any fixes, then hand off**

Follow `superpowers:finishing-a-development-branch`.
