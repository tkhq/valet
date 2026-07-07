# Teams Phase 6: Attention Router & Mailbox Retirement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One place answers "who should be told / who may act": a typed attention-router core with a per-kind audience policy, team-aware delivery (member notification queues + team-channel posts), and response-time eligibility on approvals. The agent-facing mailbox is removed without replacement; `mailbox_messages` becomes `notifications`.

**Architecture:** `services/attention-router.ts` holds the pure audience resolver (`(kind, owner, actor, policy) → tiers`) and delivery adapters (notification-queue rows per recipient via existing preferences; Slack team-channel posts via the existing transport + bot token). Emitters migrate incrementally: the DO's owner-notification writer becomes router-driven (fixing a real team gap — today it notifies only the actor), and team-session approval responses gain a membership re-check at response time. The full unification of every interactive-prompt path onto the router continues beyond v1; the registry is the extension point.

**Spec:** `docs/specs/2026-07-05-teams-design.md` §5 (mailbox retirement), §6, §8 phase 6.

## Global Constraints

- Baseline green (36 shared, 1287 worker). Same env setup.
- **Sandbox tool removal touches `docker/opencode/tools/`** → requires an `IMAGE_BUILD_VERSION` bump in `backend/images/base.py` and a modal deploy at release time (CLAUDE.md rule). Note it in the commit; do not deploy.
- Rename migration `0028`: `ALTER TABLE mailbox_messages RENAME TO notifications` (indexes follow the table in SQLite). All code references (schema, raw SQL, comments) update in the same commit.
- Response-time eligibility: a Slack interactive response against a **team-owned** session is honored only if the responder resolves to a Valet user who is currently a team member.

## Decisions locked here

| Question | Decision |
|---|---|
| Router shape | Pure `resolveAudience(event, policy)` returning ordered tiers; policy registry keyed by event kind with defaults (`approval`, `info`) — new kinds add a row |
| v1 emitters migrated | DO owner notifications (`info`), team informational fan-out (all members + bound team channel post), approval response eligibility (Slack interactive) |
| Deferred emitters | Full interactive-prompt *sending* unification (thread-origin routing already ≈ tier 1 — spec's phase-3 interim note stands); workflow gates arrive with phase 7 |
| Tier-2 timeout escalation | Deferred: v1 ships tier-1 + actor-less→tier-2 immediately; timed escalation needs a DO alarm and is noted as follow-up in the spec |
| Mailbox removal | `mailbox-send`/`mailbox-check` DO handlers, `services/session-mailbox.ts`, `docker/opencode/tools/mailbox_{send,check}.ts`, runner-protocol entries — deleted, no replacement |

## Tasks

1. **Migration 0028 rename + code sweep**: `mailbox_messages` → `notifications` (schema/notifications.ts table name, lib/db/notifications raw SQL, tests); verify chain applies.
2. **Mailbox removal**: DO handlers, service, sandbox tools, runner-protocol types, orchestrator persona/tool references; IMAGE_BUILD_VERSION bump note.
3. **Attention router core + tests**: types, policy registry, `resolveAudience` (matrix-tested: {approval, info} × {user, team} × {actor present/absent}); delivery adapters `deliverToUsers` (notification rows, preference-gated) and `deliverToTeamChannel` (Slack post via bound channel, best-effort).
4. **Emitter wiring**: DO owner notifications route by session owner (team → member fan-out + channel post); Slack interactive responses re-check team membership before applying to team-owned sessions; tests.
5. **Specs + verification + push**: orchestrator.md (mailbox/tools), real-time or sessions spec touchpoints, teams design §6 implementation notes, auth-access; suites + client build; PR update.
