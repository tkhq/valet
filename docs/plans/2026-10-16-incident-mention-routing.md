# Incident Mention Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Slack mention in a channel that an assistant already watches lands in the watching thread, once, with no follow binding.

**Architecture:** Before delivering a `slack.app_mention`, the dispatcher looks up watching waiters by channel subject, filters by org and owner, and targets the newest one's thread explicitly; it then skips the follow binding.

**Tech Stack:** TypeScript, Hono api, `@valet/engine` store (`findEventWaiters`), vitest.

**Spec:** `docs/specs/2026-10-15-incident-mention-routing-design.md` (binding).

## Global Constraints

- Branch `feat/incident-mention-routing`, stacked on `feat/event-wakeups` (PR #932); PR base `feat/event-wakeups`.
- CLAUDE.md rules (type safety, ASD-STE100, commit trailers).

## Review Focus

1. Two teams watching the same channel: the mention goes only to the subscription owner's waiter (INV-M3).
2. A once-mode waiter on the channel: never chosen.
3. A waiter on a thread subject only: never chosen.
4. The routed delivery's dispatch id stays the subscription delivery's id (idempotent retries).
5. The mention's reply still posts in the mention's Slack thread.

---

### Task 1: Route and skip the follow (Parts A, B, C)

**Files:** `packages/api/src/events/dispatcher.ts` (the orchestrator branch near the `deliverToOrchestrator` call and the follow upsert), a small helper `packages/api/src/events/watching-waiter.ts`, tests in `packages/api/src/events/dispatcher.test.ts`, and Scenario E in `packages/api/src/integration/event-wakeups.test.ts`.

- [ ] Failing unit tests for Part A steps 1-5, Part B, and INV-M3; failing integration steps M1-M5.
- [ ] Implement `findWatchingWaiter(deps, orgId, owner, team, channel)`; pass `target: { sessionId, threadId }` when found; skip `upsertFollowedThread` when routed.
- [ ] Run `pnpm --filter @valet/api test dispatcher event-wakeups`, `pnpm typecheck`, `make e2e`.
- [ ] Commit `feat(api): route incident mentions to the watching thread` with a `Changelog:` line.
