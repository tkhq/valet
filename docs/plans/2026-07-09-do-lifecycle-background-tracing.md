# Durable Object Lifecycle Background Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit independently flushed OpenTelemetry task spans for SessionAgentDO lifecycle work that runs outside an HTTP request.

**Architecture:** Extend the manual DO tracer with a standalone task-root API, then wrap session lifecycle background entrypoints with stable span names and safe attributes. Keep Modal, Runner, and OpenCode internals out of scope; traces stop at their Worker/DO boundary.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, OpenTelemetry API/SDK, Vitest.

---

### Task 1: Add standalone DO task tracing

**Files:**

- Modify: `packages/worker/src/lib/do-tracing.ts`
- Modify: `packages/worker/src/durable-objects/session-lifecycle.ts`
- Modify: `packages/worker/src/lib/do-tracing.test.ts`

- [ ] **Step 1: Write failing unit tests**

Add tests for a `traceTask()` method that creates a root from `ROOT_CONTEXT`,
applies supplied attributes, records only a fixed error class for a sensitive
mock backend body, and schedules an exporter flush through the DO context.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd packages/worker && pnpm vitest run src/lib/do-tracing.test.ts`

Expected: failure because `traceTask` does not exist.

- [ ] **Step 3: Implement the minimal tracer API**

Add `traceTask()` and its no-op implementation. Its callback result handle must
mark locally handled failure with a fixed error class; uncaught errors use the
fixed `unexpected` class. Reuse provider construction and flush behavior from
`traceFetch()` without inheriting an active parent context. Add the typed
`SessionLifecycle` result/error contract so child spans can record safe HTTP
results without inspecting raw backend errors.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd packages/worker && pnpm vitest run src/lib/do-tracing.test.ts`

Expected: PASS.

### Task 2: Instrument SessionAgentDO lifecycle tasks

**Files:**

- Modify: `packages/worker/src/durable-objects/session-agent.ts`
- Modify: `packages/worker/src/durable-objects/session-agent.test.ts`

- [ ] **Step 1: Write failing session-agent tests**

Add test coverage for the task scheduling helper and lifecycle span name/trigger
selection without making live Modal calls.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts`

Expected: failure because lifecycle tasks are not traced.

- [ ] **Step 3: Implement the minimal lifecycle wrappers**

Create a local helper that starts a task root with session/user attributes and
wrap `spawnSandbox`, `performHibernate`, `performWake`, and `performRecovery`.
Use fixed trigger/outcome/error-class enums and sanitize dynamic recovery
reasons. Wrap awaited termination in a child span at the stop, refresh,
snapshot-failure, and recovery-exhaustion call sites; do not change its timing.
Do not attach secrets, prompt content, Modal identifiers, or backend bodies.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts src/lib/do-tracing.test.ts && pnpm typecheck`

Expected: PASS.

### Task 3: Document and verify the slice

**Files:**

- Modify: `docs/observability.md`

- [ ] **Step 1: Update current coverage documentation**

Replace the stale statement that manual DO spans are future work with the
implemented HTTP and lifecycle-task coverage and clarify the Runner/sandbox
boundary.

- [ ] **Step 2: Run relevant verification**

Run: `cd packages/worker && pnpm vitest run src/lib/do-tracing.test.ts src/durable-objects/session-agent.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Run the Worker tracing smoke**

Run: `make otel-e2e`

Expected: PASS with enabled tracing, URL redaction, and disabled no-op checks.

- [ ] **Step 4: Commit and open a pull request**

Commit the implementation, tests, and documentation with a succinct subject;
push `codex/lifecycle-background-tracing` and create a PR targeting `main`.
