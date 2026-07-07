# Teams Phase 7: Credentials & Workflows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zapier-style sourced connections (a team credential backed by a member's tokens, broken on revoke/leave, re-sourceable), team-only credential resolution for team-owned sessions, team-owned workflows (member-visible, member-approvable, runs spawn team-owned sessions), and the Integrations tab. This completes the teams design.

**Architecture:** `credentials` already speaks `owner_type`/`owner_id`; migration 0029 adds `sourced_from_user_id` + `status`. A `services/team-credentials.ts` copies the sourcing member's encrypted row to team ownership (upsert = re-source) and flips status to `broken` on member removal or personal disconnect. Env assembly takes an owner `Principal` (user behavior unchanged; team owners resolve team rows only — no personal fallback). Workflow access relaxes its single chokepoint (`assertWorkflowAccess`) to admit current team members for team-owned workflows; the session-node executor threads the workflow's owner onto spawned sessions, which flows credentials/access automatically through the phase 3–6 machinery.

**Spec:** `docs/specs/2026-07-05-teams-design.md` §5, §8 phase 7.

## Global Constraints

- Baseline green (36 shared, 1291 worker); same env setup.
- **No personal fallback for team sessions** — a team session never borrows a credential nobody chose to share. Broken/absent team credentials fail visibly (status on the tab; missing env in sessions), never silently borrow the actor's.
- `getCredential` resolution ignores `status='broken'` rows (one filter in `getCredentialRow` — personal rows are deleted on revoke, so this is team-only in practice).
- Refresh flows persist onto whichever row they resolved (already owner-generic) — a team row refreshes independently of the sourcing member's personal row after the copy.

## Decisions locked here

| Question | Decision |
|---|---|
| Sharing rights | Any member may share/re-source **their own** connection to the team; unshare = team admin or the sourcing member |
| Break triggers | Member removed from team, or sourcing member disconnects the personal integration for that provider → matching team rows flip `broken` |
| Re-source semantics | Upsert on the owner-unique index: sharing again (by anyone) replaces the row and resets status |
| Team workflow access | v1: current members get viewer+editor on team-owned workflows (collaborative; matches "whole team can watch"); org admins unchanged |
| Ownership transfer | `PATCH /api/workflows/:id/owner { teamId | null }` — caller must be the workflow's owner (user) and a member of the target team |
| Workflow-run sessions | Session-node executor passes the workflow's owner onto `createSession`; team-owned runs get team credentials + membership-gated access for free |
| Session-backed workflow approvals | `canActOnSessionPrompt` replaces the owner-equality check (any current member for team sessions) |
| spawnChild git token | Team-owned children inject the team's github credential when present; otherwise none (org-app fallback still applies downstream). The phase 3 actor-credential interim ends |
| Workflow team UI | Deferred — transfer via API; the Integrations tab is the phase 7 UI |
| Legacy `enqueueWorkflowApprovalNotificationIfMissing` | Dead code (no live call sites; superseded by the attention router) — deleted |

## Tasks

1. **Migration 0029 + schema** — done (`18323c93`); add the missing `idx_workflows_owner` index while the migration is unshipped.
2. **Team credential service + resolution**: `services/team-credentials.ts` (share/list/unshare/mark-broken with sourcing-user display); `getCredentialRow` skips broken; `assembleCredentialEnv`/`assembleRepoEnv` take an owner Principal; orchestrator restart drops the team skip; `spawnChild` team github; break hooks in member-removal + integration-disconnect routes; `GET/POST/DELETE /api/teams/:id/integrations`; tests (share/re-source/break lifecycle on a real DB; route authz).
3. **Team workflows**: `assertWorkflowAccess` + `listWorkflows`/`getWorkflowByIdOrSlug` admit team members; ownership-transfer endpoint; session-node executor threads owner; session-backed approval check → `canActOnSessionPrompt`; delete dead notification helper; tests.
4. **Integrations tab**: hooks + lean tab (provider cards with status/sourced-by, share-my-connection from the member's own active integrations, re-source, unshare).
5. **Specs + verification + push**: final spec upkeep (`integrations.md`, `workflows.md`, `auth-access.md`, design doc §5 notes + status flip to "implemented"), full suites + client build, PR update.
