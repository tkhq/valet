# Task Tool Scopes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Limit task tools and give workflow troubleshooting a repeatable evidence and repair procedure.

**Architecture:** Shared scope helpers intersect allowlists. The engine applies scopes per session, submission, and thread. The API carries ceilings into children and workflow runs.

**Tech Stack:** TypeScript, TypeBox, Hono, existing metadata stores, Vitest.

**Spec:** docs/specs/2026-10-15-task-tool-scopes-design.md

## Global Constraints

- New branches use `xbalbinus/*`.
- Keep upstream PR prose focused on the product.
- Preserve tenant authorization and existing action approvals.
- Use existing metadata columns. Add no schema migration.
- Preserve behavior when no scope is set.

## Review Focus

- Two concurrent threads in one cached team session keep separate focus.
- Restored children retain the parent ceiling.
- A stale or guessed tool call cannot bypass filtering.
- Nested workflow runs and sandbox scripts cannot escape the starting scope.
- Validation distinguishes missing evidence, unavailable data, and a successful side effect.

## Tasks

- [x] Add scope parsing, matching, and intersection. Test explicit empty scopes, wildcards, invalid persisted values, and incompatible intersections.
- [x] Enforce scopes in engine visibility, execution, and discovery. Test pinned calls, dynamic actions, same-batch focus changes, and restore.
- [x] Add workflow focus profiles and child inheritance. Test personal and team owners with concurrent threads.
- [x] Carry scopes through workflow runs, agent nodes, nested runs, and sandbox actions. Test restart and no-side-effect refusals.
- [x] Update workflow prompts and skills. Add a troubleshooting reference with evidence, clarification, repair, and validation steps.
- [x] Run targeted checks, full E2E, and an independent readonly review. Fix concrete findings.
- [ ] File the product PR, deploy a branch preserving current customizations, and run live personal and team checks.


## Execution record

- Shared parsing, engine enforcement, focus profiles, inheritance, prompts, and skills are implemented.
- Independent review found scope loss in child steering, combined queues, image permission caches, and completion signals. Regression checks cover these paths.
- Dynamic team discovery retains its account approval. Canonical action IDs retain service aliases.
- PostgreSQL thread saves now persist focus changes. The shared store contract reproduced the former failure.
- Checks: 193 focused engine tests, 258 focused API tests, 122 inheritance tests, and 161 store tests passed.
- Full E2E: 20 suites passed, one integration socket failure, and 16 environment skips. The complete integration suite passed on rerun.
- Live checks passed diagnosis, repair, preview, and run output for personal/team assistants with Haiku 4.5 and Opus 5.5. Restricted tasks refused writes. Both assistants asked for missing staff-meeting details without edits or runs.
- Live team continuations exposed missing member authority for private run reads. The regression failed before the fix and passed after it. Other members and machine turns remain denied.
- Live repair exposed an unsupported patch format accepted as an unchanged save. Strict patch parameters now reject it. Schema-recovery advice explicitly requests schemas.
- The follow-up API checks passed 927 tests. Deployment and live rechecks of these final fixes remain pending.
