# Teams & Team Orchestrators — Design

**Date:** 2026-07-05
**Status:** Implemented (phases 1–7, PR #84). Per-phase implementation notes are inline; deferred follow-ups are listed in each phase's notes and Out of scope.

## Summary

Introduce teams as a first-class concept in Valet: named groups of users inside an org that own resources — most importantly a **team orchestrator** that every team member can interact with wherever orchestrators appear (web UI, Slack). To get there, generalize resource ownership from "always a user" into a **principal** model (`user` | `team` | `org`), refactoring existing user-scoped surfaces up front (approach B — full generalization, full data migration, no permanent dual-format code paths).

## Current-state findings (what the code actually says)

These drove the design and correct some stale docs:

- **The org orchestrator does not exist in code.** No `orchestrator:org:{orgId}` string appears anywhere; `orchestrator_identities.type` only ever holds `'personal'`. It exists only in `docs/specs/orchestrator.md` prose.
- **There is no org membership table.** The system is effectively single-tenant: `org_id` is hardcoded `'default'` everywhere. Teams introduce Valet's first real membership relation.
- **Orchestrator sessions are hard-blocked from all non-owners** in `assertSessionAccess` (`packages/worker/src/lib/db/sessions.ts:969-1006`). A team orchestrator is inherently multi-user; this gate is the single most important piece to redesign.
- **Ownership is baked in as `userId` everywhere:** session IDs (`orchestrator:${userId}`, parsed via ~8 scattered `startsWith('orchestrator:')` checks), memory tables, scope keys (`user:{id}:...` in `packages/shared/src/scope-key.ts`), channel bindings, workspace volume names.
- **Some surfaces already anticipate this:** `credentials` has generic `owner_type`/`owner_id`; `slack-events.ts:182-216` reserves hook points for non-DM routing; messages already carry `author_id`/`author_name`; the task board is keyed by orchestrator session ID (not user ID).
- **Slack outbound identity customization (`chat:write.customize`) is already implemented** and gets ported to team orchestrator replies.

## Decisions

| Question | Decision |
|---|---|
| Team model | Subdivision of an org (org = future root principal) |
| Team-owned resources (v1) | Sessions + memory, channel bindings, integrations/credentials, workflows/tasks |
| Roles | `team_members.role` text column (`admin`/`member`), minimal enforcement in v1, schema-ready for RBAC |
| Team creation | Any user can create a team; creator becomes team admin; global org admins can manage any team |
| Slack access | Team members only — unmapped or non-member Slack users are silently ignored |
| Slack trigger | Configurable per binding: `mention` (default) or `all` (passive listening / interjection) |
| Slack routing | The channel binding is the router; `@valet` in a bound channel unambiguously means that channel's orchestrator. Plain-text handle parsing is explicitly out of v1 |
| Memory | Team scope is new; personal orchestrators get read-only union over their teams' memory; writes never cross scopes |
| Credentials | Zapier-style sourced connections: team credential backed by the sourcing member's tokens |
| Architecture | Approach B: generalized principal refactor first, teams built on it |
| Migration | Full migration — rewrite live data to canonical form, drop all legacy-format handling. Hard cutover for workspace volumes: renamed orchestrator sessions get fresh volumes (no preserved names, no fallback column) |
| Org orchestrator | Slot reserved (`ownerType: 'org'` works everywhere), not built in this project |
| Concurrency | Team orchestrator prompts are queued between authors; steer semantics only within one author's consecutive prompts |
| Approvals & notifications | Central attention router: typed events, per-kind audience policy (actor → team channel/admins → fail closed), response-time eligibility, first eligible responder wins |
| Team deletion | Explicit cascade (sessions terminated, bindings/credentials/memory/identity deleted, handle freed); blocked while team-owned workflows exist |
| Mailbox | Agent-to-agent messaging removed entirely (no replacement — covered by direct human access, memory read-union, and the router); `mailbox_messages` kept solely as the router's notification queue, renamed `notifications` in phase 6 |
| Task board | Kept and promoted: tools unchanged, board becomes a visible tab on team + personal orchestrator pages |

## 1. The principal model

A **principal** is anything that can own resources.

```ts
// packages/shared/src/principal.ts
type PrincipalType = 'user' | 'team' | 'org';
interface Principal { type: PrincipalType; id: string; }
formatPrincipal(p: Principal): string   // "user:abc", "team:xyz", "org:default"
parsePrincipal(s: string): Principal    // throws on malformed input
```

Two representations, used consistently:

**In D1:** paired `owner_type` + `owner_id` columns (composite-indexed), matching the existing `credentials` convention. Applied to: `orchestrator_identities`, `sessions`, `orchestrator_memory_files`, `memory_links` (+ FTS), `channel_bindings`, `channel_thread_mappings`, and `workflows`. The mailbox table needs no owner columns — it survives only as the per-user notification queue (§5, §6).

**In string keys:** the canonical `{type}:{id}` form wherever a key must carry its owner:

- **Session IDs:** `orchestrator:user:{userId}`, `orchestrator:team:{teamId}`; `orchestrator:org:{orgId}` reserved. A structured `parseOrchestratorSessionId()` in shared replaces every `startsWith('orchestrator:')` check — those sites currently assume "orchestrator ⇒ single private user", which is the assumption being deleted. Call sites to convert: `durable-objects/session-agent.ts` (5 sites), `services/sessions.ts`, `services/session-cross.ts`, `lib/db/sessions.ts`.
- **Scope keys:** every builder in `scope-key.ts` takes a `Principal` instead of a `userId`, producing `user:{id}:slack:...` / `team:{id}:slack:...`. The legacy format already starts with `user:{userId}:`, so existing scope keys are already canonical — no data rewrite.

**Sessions keep the actor.** `sessions.user_id` is redefined as *creator/actor* (who spawned or triggered the session); `owner_type`/`owner_id` say who owns it. Personal sessions: both point at the same user. Team sessions: owner = team, actor = the member who caused it. Message-level attribution (`author_id`/`author_name`) is unchanged.

### Migration (one wave, no dual formats)

- Backfill `owner_type='user'`, `owner_id=user_id` on all generalized tables.
- Rewrite orchestrator session IDs `orchestrator:{userId}` → `orchestrator:user:{userId}` in `sessions` and all referents: `channel_bindings.session_id`, `session_tasks.session_id`, `sessions.parent_session_id`, the `mailbox_messages` session columns, and the rest of the referent list enumerated in the phase 1 plan.
- **DO identity:** SessionAgent DO instances derive from `idFromName(sessionId)`, so renamed orchestrator sessions get fresh DOs. Acceptable: orchestrators are built to restart and durable state lives in D1, not DO storage.
- **Workspace volumes: hard cutover.** Volume names stay derived from the session ID (one mechanism, no stored-name column, no fallback). The backend's legacy rotation-stripping in `workspace_volume_name` is removed so canonical IDs derive per-session-unique names (`orchestrator:user:{id}` → `workspace-orchestrator-user-{id}`; teams get `workspace-orchestrator-team-{teamId}` for free). Renamed orchestrator sessions therefore start with **fresh workspace volumes** — memory lives in D1 so nothing durable is lost; old volumes are orphaned in Modal and can be garbage-collected later.
- Memory FTS owner filtering lands in phase 4 (team memory), when queries first need it.
- Migration is verified against a copy of dev data (row counts + referential spot-checks) before deploy.

## 2. Teams, membership, and the team orchestrator

### Schema

```sql
teams:        id, org_id (default 'default'), name, description, avatar,
              created_by, created_at, updated_at
team_members: team_id, user_id, role, added_by, created_at
              UNIQUE(team_id, user_id)
```

`role` is a plain text column, `'admin' | 'member'` in v1. This is the RBAC door: adding roles later is a value change, not a schema change. V1 enforcement:

- Any user can create a team; creator becomes its first `admin`.
- Team admins manage membership, settings, channel bindings, integrations, and the team orchestrator lifecycle.
- Global org admins (`users.role = 'admin'`) can manage any team.

Routes at `/api/teams` (CRUD) and `/api/teams/:id/members`, following the standard route → db-helper → shared-types → query-key-factory pattern. Implementation notes (phase 2): team names are unique per org (duplicate → 409); the last-admin guard lives in the db layer so no route can bypass it; `GET /api/teams/directory` exposes a minimal user directory (id/name/email/avatar) to all authed users for the member picker — acceptable because the org is single-tenant and every user is an org member.

### Team orchestrator

- `orchestrator_identities` gains owner columns (existing rows backfilled as user-owned). Unique index becomes `(org_id, owner_type, owner_id)`; `(org_id, handle)` remains — handles stay unique per org (identity and display, e.g. Slack outbound identity).
- Onboarding mirrors the personal flow — name, handle, persona, custom instructions — triggered by a team admin from the team page. **Phase 3 v1 notes:** avatar upload is deferred (the R2 avatar route is user-keyed); restart of an existing identity is member-allowed (recovery, not configuration — the reconcile cron does the same with no user); children spawned by the team orchestrator currently inject the *acting member's* git credentials (they chose to spawn), replaced by team-sourced resolution in phase 7.
- Session ID `orchestrator:team:{teamId}`, `is_orchestrator=1`, `purpose='orchestrator'`, owner = team, actor = whoever triggered the (re)start.
- Auto-restart (cron `autoRestartDeadOrchestrators` + client hook) queries by owner principal + `is_orchestrator` instead of `user_id` + `is_orchestrator`.
- Same persona-file builder (`lib/orchestrator-persona.ts`), parameterized by principal, with one addition: the team persona states that it serves multiple people and that prompts carry author attribution — so it can say "Alice asked me to…" when Bob checks in.
- **Child sessions inherit team ownership**: sessions the team orchestrator spawns are team-owned, so every member can open, watch, and join them.
- **Multi-author concurrency: queued between authors, never cross-steered.** Personal sessions default to `queueMode: 'steer'` — your new prompt redirects your own in-flight run. That is wrong across people: Bob's message must not interrupt Alice's task mid-flight. Team orchestrator sessions default to queued turn-taking: prompts from a *different* author than the in-flight run are queued (with author attribution preserved, so the orchestrator answers each person in context); consecutive prompts from the *same* author keep steer semantics. Queue depth and mode become visible in the team chat UI ("2 queued — Bob, Carol"). **Phase 3 v1 implementation:** team orchestrators run `queueMode: 'followup'` — *all* prompts queue, including same-author follow-ups; the author-aware steer refinement is a follow-up inside the prompt queue.
- **Task board: kept, and promoted from stub to surface.** It is keyed by orchestrator session ID, so a shared team board falls out of the schema for free — and teams is what finally justifies it: the board becomes a visible tab on the team page ("what is the bot working on / what's queued"), read-only for members with the existing `task_*` tools unchanged on the agent side. The personal orchestrator page gets the same view.

### Team deletion

Deletion is team-admin (or org-admin) only, requires typed confirmation in the UI, and cascades explicitly — no silent orphans:

- **Workflows first — deletion is blocked while team-owned workflows exist.** Delete or transfer them beforehand. Blocking beats guessing: silently disabling automation someone relies on is worse than a clear error naming what's in the way.
- **Sessions:** all team-owned sessions (orchestrator + children) are stopped and marked terminated; rows are retained for history, and task-board rows stay with the terminated orchestrator session.
- **Channel bindings:** deleted — the bound Slack channel goes quiet immediately.
- **Credentials:** team-owned credential rows are deleted. Underlying tokens are untouched (they belong to the sourcing members' personal connections).
- **Memory:** team memory files and links are deleted; the UI offers a markdown export before confirming.
- **Identity:** the orchestrator identity and its auto-managed persona are deleted and the handle is freed. The workspace volume is orphaned (same GC story as the migration).
- **Membership:** `team_members` rows and the `teams` row are deleted last. IDs are UUIDs and never reused.

### Access control

Replace the orchestrator hard block in `assertSessionAccess` with a principal-based rule:

- **User-owned session** → exactly today's behavior (owner full access; personal orchestrators and workflow sessions blocked for non-owners; participants and org-visibility fallback for regular sessions).
- **Team-owned session** → require team membership. Members map to `collaborator` (view + prompt); team admins map to `owner`-level (hibernate, delete, restart, bindings). Non-members get `NotFoundError`, indistinguishable from a missing session.
- **Membership revocation reaches live connections.** Access is checked at WebSocket connect, so a removed member with an open connection would otherwise keep streaming until they disconnect. Removing a member notifies the team's session DOs to drop that user's connections (memory read-union and approval eligibility already re-check per operation; this closes the last gap).
- **The org-visibility fallback never applies to team-owned sessions.** Today's `org_visible`/`org_joinable` fallback at the bottom of `assertSessionAccess` must be reached only for user-owned regular sessions — if the team branch fell through to it, an `org_joinable` default would grant every org user access to every team's sessions and erase the membership boundary. Team membership is the *only* path into a team-owned session.
- Workflow-purpose sessions that are team-owned follow the team rule; user-owned ones keep the hard block.

## 3. Memory

- `orchestrator_memory_files` and `memory_links` get owner columns; unique constraint becomes `(owner_type, owner_id, path)`; all indexes lead with the owner pair. FTS gains the owner pair as unindexed columns for filtering.
- `loadMemorySnapshot` takes a `Principal`. The team orchestrator reads/writes its own team scope through the unchanged `mem_*` tools.
- **Personal read-union:** a personal orchestrator's `mem_search` / `mem_read` / link traversal queries `owner IN (user:me, team:A, team:B, …)` for the user's teams. Results are tagged with their source scope (e.g. `team:platform/` path prefix in listings) so provenance is visible.
- **Writes never cross scopes.** Personal orchestrators write only their own scope; team memory is written only by the team orchestrator. The team orchestrator does **not** read members' personal memory (would leak private context to the team).
- **Membership resolves at query time**, not in snapshots: session-start snapshots cover only the orchestrator's own scope; team scopes are unioned per query. Leaving a team instantly removes read access; no data to untangle.
- **UI:** memory browser and graph get a scope switcher (Personal / each team). Team members read team memory; admins can edit/delete via UI.
- **Phase 4 implementation notes:** `orchestrator_memory_files.user_id` became creator/actor provenance (NOT NULL FK — team rows carry the acting user); migration 0026 dropped the `(user_id, path)` unique index in favor of the owner tuple. Cross-scope addressing uses a virtual `team:{teamId}/…` prefix in listings/search/read (never stored; path normalization strips colons). The team page ships a lean Memory tab (list/view for members, edit/delete for admins); explorer/graph parity follows the okf-memory branch merge.

## 4. Channels and Slack

### Bindings

- `channel_bindings` and `channel_thread_mappings` get owner columns (backfilled user-owned) plus `created_by` for audit.
- New `trigger_mode` column: `'mention' | 'all'`, default `'mention'` for channel bindings. DM bindings ignore it (DMs are inherently all-messages).
- One binding per external channel remains a hard rule (existing unique index on `(channel_type, channel_id)`) — this is what makes routing unambiguous.

### Routing model: the binding is the router

Slack only fires real mentions for actual Slack apps; there is one Valet app per workspace, so `@valet` is the only real handle. Synthetic per-orchestrator handles are not possible without one Slack app per orchestrator. The design therefore routes by **channel binding**, not by handle:

- `@valet` inside a channel bound to a team means that team's orchestrator — the channel context disambiguates; users never name the orchestrator.
- `'mention'` mode answers *whether* to respond (bot mentioned, or reply in a thread the orchestrator is active in); the binding answers *which* orchestrator.
- `'all'` mode enables passive listening: the orchestrator sees every channel message from mapped team members and may interject — safe for routing precisely because there is no ambiguity, but **not free**: every message becomes an orchestrator evaluation, so cost scales with channel chatter. The binding UI labels the mode accordingly, `'mention'` stays the default, and messages are batched through the existing collect-debounce (`collect_debounce_ms`) so a burst of chatter is one evaluation, not ten.
- **Plain-text handle parsing (`@valet ask @handle …`) is explicitly out of v1.** It is the only path to multiple orchestrators per channel and can be added later without schema changes.

### Non-DM event flow (fills the reserved hooks in `slack-events.ts:182-216`)

1. Non-DM event arrives → look up binding by `(channelType, channelId)`.
2. No binding → ignore (today's behavior).
3. Binding found, team-owned → resolve Slack user via `user_identity_links`.
4. Unmapped user or non-team-member → **ignore silently** (never spam a busy channel with authorization errors).
5. Member confirmed → apply `trigger_mode` → route to `orchestrator:team:{teamId}` with the member as actor/author.

DMs are unchanged: always the personal orchestrator.

### Outbound identity

Replies to team-bound channels use `chat:write.customize` (already implemented — port it) to post under the team orchestrator's name and avatar. One Slack app, per-channel apparent identity.

**Phase 5 implementation notes:** binding creation takes a pasted Slack channel ID (a `conversations.list` picker is a follow-up); bot-in-channel is not validated at bind time (an unbindable channel simply never fires, noted in the UI); the acting member's `↳` attribution on team replies is a later refinement (team name/avatar only in v1); team thread mappings are keyed `team:{teamId}` so all members share one session thread per Slack thread.

### Threads and other channels

Thread replies reuse the existing slack-threads machinery; the thread mapping is team-owned, so all members' activity in a thread lands in one session thread instead of fragmenting per user (the failure mode the 2026-03-11 multi-orchestrator design doc identified). The binding model is channel-agnostic; v1 ships Slack, Telegram group bindings follow on the same plumbing.

## 5. Integrations & credentials, workflows, mailbox retirement

### Sourced connections (Zapier model)

- Team connection = credential row with `owner = team:{id}` plus new column `sourced_from_user_id`.
- A member connects an integration via the normal personal flow, then **shares it to the team** (or connects directly from the team page, which does both at once). The tokens remain the sourcing member's; team sessions act as that member against the external service. **Eyes open:** external systems attribute actions to the sourcing member (e.g. GitHub commits authored as them) even when a different member prompted the run — inherent to shared connections; the session log always retains the true actor.
- **Lifecycle is explicit:** if the sourcing user revokes the integration or leaves the team, the team credential flips to `broken` status — surfaced on the team page and to the orchestrator as a clear error. Any other member can re-source it. No silent failures, no orphaned tokens.
- **Resolution order:** team-owned sessions resolve team-owned credentials only; there is no fallback to members' personal credentials — a team session never borrows a credential nobody chose to share. `env-assembly` takes the session's owner principal instead of hardcoding `'user'`.
- **Phase 7 implementation notes:** migration 0029 adds `sourced_from_user_id` + `status` to `credentials`; a shared team credential is a **reference** to the sourcing member's live credential (`getCredential('team', …)` delegates to the member — no token copy, so refresh rotates only the member's row and the lineage never splits); re-sourcing resets `broken`; break triggers are member removal, personal disconnect, and the member's credential dying on refresh; resolution skips broken rows globally; `assembleRepoEnv` keeps the acting user for git identity while tokens follow the owner; `spawnChild` injects the team github credential for team children (the phase 3 actor-credential interim is over). Routes: `GET|POST /api/teams/:id/integrations` (member), `DELETE …/:provider` (team admin or the sourcing member).

### Workflows

`workflows` get owner columns. Team-owned workflow runs execute as team-owned sessions (whole team can watch) and use team credentials. Approval gates route through the attention router (§6): the triggering actor first when there is one, the team channel + admins otherwise; any team member is eligible to respond in v1 (the role column leaves room for admin-only approvals later).

**Phase 7 implementation notes:** team-workflow access is enforced at the db layer (`workflowAccessibleBy`: owner OR current member of the owning team — one condition shared by list/fetch/access, query-time membership); ownership moves via `PATCH /api/workflows/:id/owner { teamId | null }` (workflow owner only, must be a member of the target team); the session-node executor threads the workflow's owner onto spawned sessions, which pulls team credentials and membership-gated access automatically; approval responses ride the phase 6 `canActOnSessionPrompt`/DO checks. v1 gives members collaborative (viewer+editor) access; there is no team-workflow management UI yet — transfer is API-only.

### Mailbox retirement

The mailbox was an early-iteration stub doing two unrelated jobs; one is removed, the other absorbed:

- **Agent-to-agent messaging is removed — without replacement.** `mailbox_send`/`mailbox_check` tools and inbox semantics go away in phase 6. Every flow teams actually needs is covered elsewhere: humans address any orchestrator directly (team page, bound Slack channel); shared context flows through the memory read-union (§3); agent→human goes through the attention router (§6); orchestrator→child uses the existing parent-child machinery. What messaging would add — cross-orchestrator delegation — is speculative, was never used in its mailbox form, and two always-addressable agents that can prompt each other is a runaway-loop hazard that would demand hop limits and loop detection to ship safely. If a concrete need appears, direct dispatch by handle is a small additive feature (handles are unique, identities cover teams, prompt dispatch exists); see Out of scope.
- **The `mailbox_messages` table survives with one job:** it is the notification queue behind the attention router (§6) — the DO already writes preference-gated owner notifications into it. Rename to `notifications` when the router lands (phase 6).

## 6. Attention routing: approvals & notifications

Anything that needs a human — an approval gate, an error, a finished task — currently decides ad-hoc who to tell: session owner, thread-origin channel, or (pre-fix) a broadcast to all bindings. None of those answers survive multi-member ownership. This design centralizes the decision in a **notification router** with three separated stages; approvals become a special case of notification rather than a parallel system.

**1. Typed attention events.** Emitters produce `{ kind, urgency, owner: Principal, actorUserId?, sessionId?, threadId?, payload, response? }`. `response` is present for approvals: the allowed options, single-approver semantics, a timeout, and a fail-closed default. Existing emitters — scoped action approvals, workflow `step.waitForEvent` gates, interactive prompts, session errors — migrate onto this envelope.

**2. Audience resolution — the router core.** A pure function `(kind, owner, actor, roles) → ordered audience tiers`, driven by a per-kind policy registry:

- **User-owned anything** → tier 1 = the owner. Today's behavior, unchanged.
- **Team-owned approval** → tier 1 = the actor whose prompt caused the run (they have the context). Tier 2, after timeout — or immediately when there is no actor (scheduled/webhook trigger) — = the team's bound channel + team admins. Tier 3 = fail closed: deny and surface the denial in the session (extends the fail-closed philosophy of the 2026-03-17 approval-routing work).
- **Team-owned informational** (task finished, session error) → the bound team channel; members individually per their preferences.

New event kinds add a policy row, not a new routing code path. Membership and role knowledge lives *only* here — delivery code never queries it.

**3. Delivery.** Per-recipient fan-out through the existing `user_notification_preferences` table (web/slack/email toggles per message type), plus principal-level delivery: a team-bound channel gets an interactive approval card (existing Slack interactive-prompt machinery, posted under the team orchestrator's identity via `chat:write.customize`). The current thread-origin-channel logic becomes one delivery strategy *inside* this stage rather than being the routing decision itself.

**Response handling.** First eligible responder wins; the decision records who responded (audit trail); other recipients' cards update to "approved by Alice". Eligibility is enforced at **response time** (membership + role re-check), not just at delivery time — a forwarded Slack card must not confer approval rights, and someone removed from the team between delivery and click must be rejected.

**Phase 6 implementation notes:** shipped — the router core (`services/attention-router.ts`: typed events, per-kind policy registry, pure `resolveAudience`, preference-gated queue delivery, team-channel posts for question/escalation/approval), owner-routed DO notifications, response-time membership checks on all three resolve paths (Slack interactive, DO `/prompt-resolved`, invocation approve/deny), the mailbox retirement (tools/service/protocol deleted; `emit_notification` narrowed to no-addressing and routed through the router; table renamed `notifications`, migration 0028). Deferred: timed tier-2 escalation (needs a DO alarm) and unifying the interactive-prompt *sending* paths onto the router — thread-origin routing remains ≈ tier 1.

Why this scales with feature surface area: one place answers "who should know / who may act" as new tools, gates, and channels arrive; approvals, prompts, and notifications share one delivery layer instead of triplicating channel integrations; and principals slot in naturally — an org orchestrator later is just another owner type in the resolver, and per-team routing overrides later are a policy-registry column, not a rewrite.

## 7. UI

New **Teams** area in the sidebar:

- **Team list / create team.**
- **Team page** tabs:
  - **Chat** — the team orchestrator via the existing orchestrator chat surface (multiplayer presence already exists for regular sessions and now applies here).
  - **Board** — the orchestrator's task board (`session_tasks`), read-only for members: current work, queued items, and which child session each task runs in.
  - **Members** — invite from org users, roles.
  - **Memory** — existing browser + graph with the scope switcher.
  - **Channels** — Slack bindings + trigger mode.
  - **Integrations** — shared connections, sourcing status, re-source action.
  - **Settings** — identity (name/handle/avatar/instructions), danger zone.
- **Existing surfaces pick teams up passively:** the session list shows team-owned sessions you can access (badged with the team); the orchestrator switcher offers Personal + each team.

## 8. Rollout phases

Each phase is independently shippable and typecheck/test-gated:

1. **Principal foundations** — `principal.ts`, `parseOrchestratorSessionId()`, scope-key generalization, the migration wave (owner backfills, session ID rewrite), backend volume-derivation fix. Behavior-identical except orchestrator workspaces start fresh; it is the risky phase, so it ships alone.
2. **Teams core** — tables, CRUD routes, membership, team UI shell.
3. **Team orchestrator** — identity onboarding, lifecycle/auto-restart, `assertSessionAccess` rework, team-owned child sessions, web chat. **Interim approval routing (until phase 6):** team-session approvals ride the existing thread-origin/caller machinery, which reaches the acting member's surface — equivalent to the router's tier 1. Actor-less team runs don't exist before phase 7, so no tier 2 is needed yet; anything that can't resolve an origin fails closed loudly, per the existing behavior.
4. **Team memory** — team scope, personal read-union, UI scope switcher.
5. **Slack channels** — shared-channel routing, trigger modes, outbound identity port, binding management UI.
6. **Attention router & mailbox retirement** — typed events, per-kind audience policy registry, delivery via preferences + team channel cards, response-time eligibility; existing approval/prompt emitters migrate onto it. `mailbox_send`/`mailbox_check` tools removed (no replacement), `mailbox_messages` renamed to `notifications`. (After Slack because team-channel delivery needs bindings.)
7. **Credentials & workflows** — sourced connections, resolution order, team workflows with router-driven approval gates.

## 9. Testing

- Unit: `parsePrincipal`, `parseOrchestratorSessionId`, scope-key builders (round-trip + malformed input).
- Migration: run against a copy of dev data; verify row counts and referential integrity (bindings → sessions, tasks → orchestrator sessions) before/after.
- Access control: matrix tests for `assertSessionAccess` — {member, team admin, org admin, non-member} × {team orchestrator, team child session, user orchestrator, workflow session}.
- Slack routing: non-DM path — unbound channel, unmapped user, non-member, `mention` vs `all`, thread continuation.
- Memory: union reads return correctly tagged scopes; writes never land outside the writer's own scope.
- Attention router: audience resolution matrix ({approval, informational} × {user-owned, team-owned} × {actor present, absent}); response-time eligibility rejection (non-member click, member removed after delivery); fail-closed timeout path.
- Team deletion: cascade order, workflow-block error, handle freed and re-registrable.
- Existing integration targets (`make test`, `make test-workflow`) extend rather than fork.

## 10. Spec upkeep

Per repo convention, the affected subsystem specs are updated in the same commits as their phases: `orchestrator.md` (identity model, session IDs, team lifecycle — and correcting the org-orchestrator-exists claim), `auth-access.md` (teams, membership, access rules), `integrations.md` (bindings, trigger modes, non-DM Slack routing — and correcting the "schema-only Slack" claim), `sessions.md` (ownership vs actor, team access).

## Out of scope

- **Org orchestrator** — the principal model reserves `org` everywhere; building it becomes a small follow-up (root-team semantics, unattributed-event routing, admin config).
- **Plain-text handle parsing in Slack** — only needed for multiple orchestrators per channel.
- **Telegram group bindings** — same plumbing, ships after Slack.
- **Cross-orchestrator messaging** — removed with the mailbox, no replacement. If a concrete delegation need appears, direct dispatch by handle is cheap to add — but it must ship with hop limits and loop detection: two always-addressable agents that can prompt each other is a token-burning runaway loop waiting to happen.
- **Fine-grained RBAC** — the role column is the door; v1 enforces only admin/member.
- **Cross-org teams** — teams live inside one org.
