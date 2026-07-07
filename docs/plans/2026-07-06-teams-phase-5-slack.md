# Teams Phase 5: Slack Shared Channels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Slack channel can be bound to a team orchestrator: non-DM events route through the binding (the binding is the router), team members' messages reach the team orchestrator with attribution per the binding's trigger mode, replies post under the orchestrator's identity, and team admins manage bindings from the Channels tab.

**Architecture:** Fill the reserved non-DM hooks in `routes/slack-events.ts` with the spec §4 flow: binding lookup by `(channelType, channelId)` → team-owned check → `user_identity_links` resolution → membership check (silent ignore otherwise) → trigger mode → dispatch to `orchestrator:team:{teamId}` with the member as actor/author. Outbound identity ports the existing `chat:write.customize` machinery to team orchestrator identities. Binding CRUD lives on `teamsRouter` (admin-gated), reusing the one-binding-per-channel unique index.

**Spec:** `docs/specs/2026-07-05-teams-design.md` §4, §8 phase 5.

## Global Constraints

- Baseline green (36 shared, 1276 worker); same env setup.
- **Silent ignores**: unbound channels, unmapped Slack users, and non-members produce `200 OK` with no reply — never authorization chatter in a busy channel.
- **`'all'` mode batches** through the binding's existing `collect_debounce_ms` (queueMode `collect`) so a burst of chatter is one evaluation; `'mention'` stays the default.
- **Loop safety**: the bot's own messages (and other bots) must be filtered before any dispatch — reuse/extend the existing DM-path guards.
- DMs are untouched: always the personal orchestrator.

## Decisions locked here

| Question | Decision |
|---|---|
| Migration | `0027`: `trigger_mode` ('mention' default) + `created_by` on `channel_bindings` (committed) |
| Mention semantics | Bot mention (`app_mention` / `<@BOT>` in text) or a reply in a thread the orchestrator is already active in (existing thread mapping ⇒ active) |
| Binding creation | `POST /api/teams/:id/channels` (team admin): `{ slackChannelId, triggerMode? }`; conflict with the `(channel_type, channel_id)` unique index → 409. `GET` (member) lists; `PATCH` updates trigger mode; `DELETE` unbinds |
| Channel picker | v1: admin pastes/types the Slack channel ID (or `#name` if a conversations.list helper already exists — use it, else defer picker) |
| Thread mappings | Team-owned rows (`owner` = team) keyed to the team orchestrator session; one session thread per Slack thread regardless of which member speaks |
| Outbound identity | Team-bound channel replies use the existing username/icon customize path with the team orchestrator's name/avatar |
| Bot-in-channel check | Not validated at bind time in v1 — a binding to a channel the bot isn't in simply never fires; the Channels tab notes the requirement |

## Tasks

1. **Migration 0027 + schema + shared types** — done (committed `127d7d36`).
2. **Non-DM routing** (`routes/slack-events.ts` + db helpers): implement the five-step flow at the reserved hooks; trigger-mode evaluation; team-owned thread mappings; dispatch with author attribution; tests (mocked db/services: unbound → ignore, unmapped → ignore, non-member → ignore, member + mention → dispatch, member + all-mode → dispatch via collect, bot message → ignore).
3. **Outbound identity + binding API**: port customize to team replies (resolve team orchestrator identity for the outbound post); `GET/POST/PATCH/DELETE /api/teams/:id/channels` with authz tests.
4. **Channels tab UI**: list bindings (channel, mode, created by), add-binding form (channel ID + trigger mode), mode toggle, unbind; client hooks.
5. **Specs + verification + push**: `integrations.md` (non-DM routing section — also correcting the stale "schema-only Slack" claim), teams design doc §4 implementation notes, `auth-access.md` routes; full suites + client build; PR update.
