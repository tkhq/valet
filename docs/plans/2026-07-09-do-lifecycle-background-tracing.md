# Durable Object Lifecycle Background Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit independently rooted, batched OpenTelemetry spans for SessionAgentDO lifecycle work that runs after a request returns.

**Architecture:** Extend the existing cached DO tracer with `traceTask()`, which uses `ROOT_CONTEXT` and the existing batch processor. Schedule named lifecycle roots in SessionAgentDO and flush once after each task. Keep sandbox, Runner, and OpenCode internals out of scope.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, OpenTelemetry API/SDK, Vitest.

---

### Task 1: Add a cached DO task-root API

**Files:**

- Modify: `packages/worker/src/lib/do-tracing.ts`
- Modify: `packages/worker/src/lib/do-tracing.test.ts`

- [x] **Step 1: Write failing tests**

Add tests proving a task root does not inherit an active request span, an
uncaught task error is marked without exporting its message, and disabled
tracing remains a no-op.

- [x] **Step 2: Implement and verify the API**

Add `traceTask()` and a test-provider seam. Reuse the cached provider and
batch processor; do not create or flush a provider per task.

### Task 2: Schedule lifecycle operation roots

**Files:**

- Create: `packages/worker/src/durable-objects/lifecycle-tracing.ts`
- Create: `packages/worker/src/durable-objects/lifecycle-tracing.test.ts`
- Modify: `packages/worker/src/durable-objects/session-agent.ts`
- Modify: `packages/worker/src/durable-objects/session-agent.test.ts`

- [x] **Step 1: Write failing tests**

Cover stable lifecycle attributes, recovery-reason sanitization, and initial
background spawn scheduling.

- [x] **Step 2: Implement and verify wrappers**

Schedule named root spans for spawn, hibernate, restore, and recovery. Preserve
termination as a child span and flush once at lifecycle-task completion.

### Task 3: Document and validate

**Files:**

- Modify: `docs/observability.md`

- [x] **Step 1: Update coverage documentation**

Describe manual DO HTTP/WebSocket/alarm tracing plus lifecycle task roots and
their Worker/DO boundary.

- [x] **Step 2: Run verification**

Run focused Vitest files, `pnpm typecheck`, and `make otel-e2e`.

- [ ] **Step 3: Commit and open a pull request**

Commit implementation, tests, and documentation; push
`codex/lifecycle-background-tracing`; create a PR targeting `main`.
