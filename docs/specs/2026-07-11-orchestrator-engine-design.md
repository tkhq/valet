# Orchestrator on the Engine

> Defines the orchestrator as an application built on the portable runtime engine: principal-based identity (user/team/org), instant wake, channel bindings and tenancy resolution, memory scoping, thread policy, child sessions, notifications and attention routing, task board, and the migration off the legacy DO.

## Scope

This spec covers:

- Orchestrator identity: user, team, and org orchestrators as Principals, well-known session IDs
- Lifecycle on the engine: lazy creation, instant wake, sandbox-less default
- Channel bindings: the tenancy-resolution model the engine's ingress pipeline delegates to
- Routing policy: DMs vs team-bound surfaces vs org surfaces, unbound events
- Memory scoping: owner-tuple partitioning, cross-scope read union, write isolation
- Thread policy: origins, keys, queue modes, archival and reactivation
- Notifications and attention routing; cross-orchestrator messaging as signals
- Team credentials (sourced references)
- Task board integration
- Child sessions: spawning, attribution, ownership inheritance, limits, approval routing, result reporting
- Scheduled/automation dispatch into orchestrator threads
- Migration from the legacy SessionAgentDO orchestrator

### Boundary Rules

- This spec does NOT cover engine primitives (sessions, threads, submissions, gates, signals, event streams, sandbox attachment) — those belong to `docs/specs/2026-05-02-portable-runtime-engine-design.md`. This spec composes them.
- This spec does NOT cover memory internals (OKF format, FTS, snapshot assembly) — `docs/specs/2026-07-02-okf-memory-design.md`. This spec covers only how memory attaches to an engine-hosted orchestrator.
- This spec does NOT cover channel transport implementations (Slack/Telegram payload rendering, webhook verification) — those implement the engine's ChannelTransport contract. This spec owns the binding and routing policy above them.
- This spec does NOT cover workflow execution — `2026-07-11-workflow-run-host-design.md`. Scheduled triggers that target the orchestrator are covered here.

## Identity

Ownership everywhere is a **Principal** — `{ type: 'user' | 'team' | 'org'; id }`, serialized `${type}:${id}`. Orchestrator session IDs are `orchestrator:{type}:{id}`, produced and parsed only through the shared principal helpers (`orchestratorSessionId` / `parseOrchestratorSessionId`) — never ad-hoc prefix checks. Colon-free URL aliases exist per kind (`orchestrator`, `team-orchestrator-{teamId}`).

Session rows carry `owner: Principal` **plus an actor** (`userId` = the human whose action created or triggered the work). For team/org-owned sessions, owner says who the work belongs to; actor preserves per-human attribution on every prompt, memory write, and credential use.

Three orchestrator kinds, all full engine sessions with `purpose: 'orchestrator'`:

| | User orchestrator | Team orchestrator | Org orchestrator |
|---|---|---|---|
| Session ID | `orchestrator:user:{userId}` | `orchestrator:team:{teamId}` | `orchestrator:org:{orgId}` |
| Steered by | owner only | any team member; team admins get owner-level lifecycle | org admins; members converse via bound surfaces |
| Receives | DMs, personal schedules, signals addressed to the user | team channel bindings, team schedules, team workflow dispatch | org-wide surfaces, unattributed events, org automation |
| Memory scope | `user:{userId}` | `team:{teamId}` | `org:{orgId}` |
| Default queue mode | `steer` | `followup` | `followup` |

Session IDs are stable and permanent — one durable identity per orchestrator, never rotated. `orchestrator_identities` rows are unique on `(orgId, ownerType, ownerId)`; handles are unique per org. The orchestrator persona is owner-kind-aware: a team orchestrator's persona states that it serves multiple people and attributes statements to actors; it is not a personal persona with a different name.

**Teams** are the org's membership structure: `teams` (names unique per org) + `team_members` (`role: 'admin' | 'member'`), with atomic last-admin guards on role change and removal, creator auto-admitted as admin, and deletion blocked while team-owned workflows exist. Team membership is the sole access path to team-owned resources (sessions, memory, credentials, workflows).

The org orchestrator is the org's chief of staff — the responder for org-wide bound surfaces and the home for events attributable to no team or user. It is created on first admin configuration or first org-wide binding.

## Lifecycle

### Lazy creation

An orchestrator session is created on first demand — first channel binding, first web visit to the orchestrator UI, first scheduled dispatch. Creation is idempotent by well-known ID (`engine.createSession({ id })` returns the existing session). There is no onboarding step that must succeed before events can flow; an event arriving for a not-yet-created orchestrator creates it inline.

### Instant wake

The orchestrator has no user-visible wake state. An inbound event durably admits a submission; the engine host wakes in milliseconds and the turn starts immediately. The "is thinking" indicator appears on the originating channel as soon as admission succeeds.

The adapter host reconstructs `CreateSessionOptions` on wake from configuration, not from persisted creation options:

- **Persona and roles**: the orchestrator persona plus per-user identity, loaded as `RoleSpec`s.
- **Memory snapshot**: `systemContext` entry (pinned files + recent journals + neighbor tier), assembled at wake. Wake-time bootstrap also ensures today's journal exists and the link index is fresh.
- **Tools**: memory tools, channel tools, task tools, the plugin action bridge, `task` — all engine-side ToolDefs configured via `toolConfig` (API base URL, credentials); nothing assumes a sandbox-local gateway.
- **Sandbox**: a `SandboxCreateOpts` template, **not** a warm sandbox (below).

### Sandbox-less by default

The orchestrator runs with a **cold sandbox attachment as its steady state**. Its tool surface is API-shaped: memory, channels, mailbox, tasks, plugin actions, spawning. Repo work happens in child sessions; the orchestrator holds no clone. The sandbox warms only when a turn actually reaches for the filesystem (generating a file artifact to attach to a channel reply, browser/media work), via the engine's lazy attachment contract.

Consequences worth stating:

- Orchestrator response latency is engine-host wake latency on every channel, always. No snapshot restore sits between an inbound message and the first token.
- The orchestrator's sandbox idle policy can be aggressive (release quickly, `snapshot` per provider capability) because re-warming is invisible.
- Persona and skill content is delivered by the engine (roles/skills sources), not written into a sandbox filesystem at boot. The sandbox carries no orchestrator state; the workspace-survives invariant applies only to artifacts the orchestrator deliberately produced.

### Health

The engine's submission machinery replaces the orchestrator-specific reconcile/backoff apparatus. A crashed turn is reconciled by the submission decision tree; a stuck sandbox is a failed tool call plus background re-provision. The remaining application-level check is a reconcile sweep that verifies every `orchestrator_identities` row has a live session row, and re-creates lazily on drift.

## Channel Bindings and Routing

This section fills the "application-owned" slot in the engine's ingress pipeline: `conversationKey → binding → { owner, sessionId, threadKey }`.

### Binding model

```typescript
interface ChannelBinding {
  id: string;
  orgId: string;
  channelType: string;          // 'slack' | 'telegram' | ...
  conversationKey: string;      // transport codec output, e.g. slack:v1:{team}:{channel}[:{threadTs}]
  owner: Principal;             // user:{id} | team:{id} | org:{id}
  sessionId: string;            // orchestrator:{type}:{id} | a specific session
  threadKeyTemplate: string;    // how external threads map to engine thread keys
  queueMode: QueueMode;         // default per owner kind: user 'steer', team/org 'followup'
  triggerMode: 'mention' | 'all';  // shared surfaces: respond only when mentioned (or in an active thread) vs everything
  createdBy: 'user_link' | 'admin' | 'agent_outbound';
  createdAt: number;
}
```

Bindings are unique per `(channelType, conversationKey)` within an org — **one binding per external conversation is the hard rule that makes routing unambiguous**. They are created by:

- **User linking** — a user connects a channel (Telegram `/start`, Slack account link): binds their DM conversation to their orchestrator.
- **Team/admin configuration** — a team admin binds a shared surface (a Slack channel) to the team orchestrator; an org admin binds org-wide surfaces to the org orchestrator.
- **Agent outbound** — when an orchestrator initiates a conversation on a channel, the send tool records the binding so replies route back.

**A conversation key is never a capability.** Resolution authorizes against the binding (and the actor's identity link) before admission; an event with no binding follows the unbound policy below.

### Identity links

`user_identity_links` maps `(provider, externalId) → userId`, unique per provider. Inbound actors resolve through this table; unresolved actors on personal surfaces receive an account-linking reply. Links are managed from the web UI and channel linking flows.

### Routing policy

The arbitration rule is structural, not heuristic — **the binding's owner picks the orchestrator**; there is no fallback ranking:

1. **Direct/private surfaces** (Slack DM, Telegram private chat) → the linked user's orchestrator. Unlinked actor → account-linking reply, no admission. Personal orchestrators exist on DM/web surfaces only — never on shared ones, which makes "which of N members' Jarvises answers?" unaskable.
2. **Team-bound shared surfaces** → the team orchestrator, gated in order: (a) actor resolves via identity link — unmapped actors are ignored silently; (b) actor is a current team member — non-members are ignored silently; (c) `triggerMode` passes (`mention` requires a bot mention or an actively mapped thread; `all` admits everything). The admitting member becomes the actor/author on the signal.
3. **Org-bound surfaces** → the org orchestrator, same gates with org membership. The org orchestrator may delegate to a user's orchestrator via a signal (conversation context + reply target); the user's orchestrator replies *through the org binding* with delegation attribution.
4. **Unbound** — shared-surface events with no binding are acknowledged and ignored. Nothing is ever admitted without a binding.

Admission is always a `SignalContent` (`signalType: 'slack.message'` etc., sender identity and external IDs in attributes) with `dispatchId` = the provider's stable event ID. Duplicate provider event shapes (e.g. Slack sending both `app_mention` and `message.*` for one utterance) are deduplicated at parse time with one canonical shape.

### Replies and personas

Outbound replies flow through the bound transport with the orchestrator's persona (name/avatar) resolved per identity row. Reply targets come from the thread's origin channel; when a thread has no channel origin (web, automation), channel sends require an explicit target from the model. Delivery is fail-closed: a reply that cannot resolve its origin target surfaces in the web UI only, never broadcast to all bindings.

## Thread Policy

Orchestrator threads are engine threads with origin metadata:

- **Thread keys**: `slack:{team}:{channel}:{threadTs}`, `telegram:{chatId}`, `web:{n}`, `schedule:{triggerId}`, `signal:{senderSessionId}` — one engine thread per external conversation by default; on team-bound surfaces every member's activity in one external thread lands in the single mapped engine thread. Convergence (a Slack thread and web steering the same engine thread) is a deliberate per-binding choice, not an accident.
- **Origins** persist on thread metadata (`originType`, channel refs, trigger refs) and drive sidebar grouping and reply-target recovery.
- **Queue mode defaults follow the owner kind**: `steer` for personal conversational threads (the newest message from the one human supersedes an in-flight turn); `followup` for team- and org-owned threads (one member must not steer another member's in-flight run) and for automation/schedule threads (automation output must not be superseded by a later tick). Steer withdraws the superseded turn's pending gates per the engine contract. `collect` is available per binding for high-burst surfaces. Author-aware steer on team threads (a member may steer their *own* in-flight turn) is a post-V1 refinement.
- **Archival and reactivation**: threads archive on inactivity; an inbound event for an archived thread's conversation reactivates it. Archival summarizes into thread `summary` so `list_threads`/`thread_read` stay useful without unbounded context.
- Scheduled dispatches open fresh threads (`forceNewThread` semantics) with a preamble instructing memory-first orientation.

## Memory Scoping

Memory is one store partitioned by owner principal — **`(owner_type, owner_id)` is the scoping tuple** on `orchestrator_memory_files` (and its FTS and link companions), with path uniqueness per owner tuple. `user_id` on a memory row is **actor provenance**, not scope: team-scope writes record which member's action produced them.

Scoping rules (normative):

- **Each orchestrator writes only its own scope.** A personal orchestrator writes `user:{userId}`; a team orchestrator writes `team:{teamId}`. Writes never cross scopes — a personal orchestrator cannot write team memory, and a team orchestrator cannot write a member's personal memory.
- **Personal orchestrators read a union**: their own scope plus every team the user currently belongs to. Cross-scope results surface under a **virtual `team:{teamId}/…` path prefix** — a read-time projection, never stored (colons are invalid in stored paths). Reading a `team:{id}/…` path re-checks membership at query time.
- **Team orchestrators read only their own scope.** A team orchestrator never sees members' personal memory. Org orchestrators likewise read only `org:{orgId}`.
- **Membership resolves per query, not per snapshot.** Leaving a team drops read access instantly. Wake-time memory snapshots cover only the owner's own scope; cross-team knowledge arrives through explicit `mem_search`/`mem_read`, keeping snapshots small and scope changes immediate.
- The OKF `sensitivity` field governs export bundles (`include=shareable`); it does not create additional cross-scope read paths in V1. Owner-tuple partitioning + read-union is the entire sharing model.

> **Schema reconciliation note:** owner-tuple partitioning and the OKF metadata columns (`sensitivity`, `origin`, `expires`, pinning) were developed on separate branches touching the same table. The merged schema carries both; the memory design spec (`2026-07-02-okf-memory-design.md`) must be updated with the owner-tuple key when the teams work lands.

## Notifications and Attention Routing

The legacy mailbox is retired as a peer-to-peer subsystem. Two mechanisms replace it, split by direction:

**Agent-to-orchestrator messaging is engine signals.** Cross-orchestrator communication (org → user delegation, child → parent result reporting, task assignment, user → user handoff) is a `SignalContent` admission to the recipient orchestrator (`signalType: 'orchestrator.message'`, `'child.settled'`, `'task.assigned'`, …; sender and context in attributes; `dispatchId` unique per message), routed to an appropriately keyed thread. There is no second agent messaging pathway and no polling inbox tool.

**Agent-to-human notification is the attention router.** Typed events `{ kind: 'notification' | 'question' | 'escalation' | 'approval', urgency, owner: Principal, actorUserId?, sessionId? }` flow through a per-kind policy registry that resolves an audience (`queueUserIds` + whether to post to the bound team channel). Delivery is preference-gated per user (`user_notification_preferences`: web/slack/email per kind) against a `notifications` queue table; urgent kinds (question/escalation/approval) additionally post to the owner's bound channel. Audience resolution is a pure function over membership resolved once by the caller — delivery code never queries membership. Timed escalation tiers (re-route unacknowledged urgent items) are a post-V1 addition and slot into the same policy registry.

## Task Board

Unchanged as a data model: `session_tasks` + `session_task_dependencies`, scoped by orchestrator session, with `task_create` / `task_list` / `task_update` / `my_tasks` tools and the existing routes. Because the board is keyed by orchestrator session ID, a team orchestrator's board is shared across all members for free. Two integration rules:

- Task assignment to a person emits a `task.assigned` signal to their orchestrator and an attention-router notification to the human.
- A task's `sessionId` assignment links it to a child session; child settlement (below) updates task status via the parent's handling of the result signal, not via automatic coupling.

## Child Sessions

- **Spawning** is the engine's `task` tool (child session with `purpose: 'child'`, `parentSessionId` = the orchestrator ID, `parentThreadId` = the spawning thread). Explicit params (repo, branch, model, persona) merge over defaults. Children cannot spawn (depth limit 1 for orchestrator children; the engine's task depth limit enforces it — not an env-var check).
- **Ownership inheritance**: a child inherits its parent's owner principal — a team orchestrator's children are team-owned (all members can watch, join, and act on prompts), with the spawning member as actor. The adapter injects repo credentials via the owner's credential resolution (team children use the team's sourced credential, never a bystander member's personal token) and git identity from the actor's profile.
- **Limits**: orchestrator children bypass the interactive active-session cap but get their own explicit concurrency limit (per-org configurable, default 10 active children per orchestrator). Unbounded spawning is a cost bug waiting to happen; the limit is enforced at spawn, with a structured tool error naming the running children.
- **Result reporting**: child completion emits a `child.settled` signal to the parent (child session ID + outcome + summary in attributes), admitted to the spawning thread. The parent reads details via cross-session `thread_read`. Interactive nudging of a running child is a prompt to the child's thread, attributed to the orchestrator.
- **Approval routing**: a decision gate raised in a child session resolves its delivery targets **through the parent's thread origin** — the gate surfaces on the channel where the conversation that spawned the work lives, plus the web UI. Fail-closed: no origin target → web UI only, never broadcast. Gate refs and channel updates follow the engine's gate delivery contract; this spec only fixes *whose* bindings are consulted (the parent's).

## Scheduled and Automation Dispatch

Scheduled triggers and workflow `orchestrator` nodes dispatch through the same admission path as channels: a `SignalContent` (`signalType: 'schedule.tick'` / `'workflow.dispatch'`) with `dispatchId` = trigger/run-scoped ID, into an automation-origin thread, `followup` mode, optional per-dispatch model override. Workflow nodes then use `awaitResult` per the Workflow Caller Contract. The persona continues to recommend orchestrator-mediated automation over direct workflow execution for judgment-requiring tasks.

## Team Credentials

Team-owned sessions resolve credentials by **reference, not copy**: a team credential row records `sourcedFromUserId` and resolution delegates to that member's live credential. Token refresh rotates only the member's row (lineage never splits); a revoked or broken reference resolves to *nothing* — team sessions **fail visibly rather than borrow** another member's token, and there is no fallback to the actor's personal credentials. Sharing and re-sourcing are explicit member actions. In the engine's terms this is a `CredentialStore` owner type `team` whose implementation is a reference-resolving wrapper.

## Access Control

Membership is the only access path to team-owned resources — no creator shortcut, no participant grants, no org-visible fallback:

- **Team sessions**: current membership grants `collaborator` (view + prompt); team `admin` grants `owner` (hibernate/delete/restart/bindings). Non-members receive not-found, indistinguishable from a nonexistent session.
- **Eligibility is re-checked at action time**, not delivery time: a decision-gate resolution or prompt from a forwarded card is validated against *current* membership at click. Removal from a team breaks the member's sourced credentials and evicts them from live team-session connections immediately.
- **User orchestrators** are visible and steerable only by their owner. **Org orchestrators** are readable by members, steerable by admins.
- Decision gates route to actors authorized to resolve them: child-session gates to the parent's audience (team members for team-owned parents, the owner for personal), org-orchestrator gates to admins or an automation rule's designated approvers.
- Bulk operations are scoped to `owner_type = 'user'` so departed members can never mass-affect team resources.

## Migration

The one-Jarvis rule: an orchestrator identity runs on exactly one stack at a time. Cutover is per-principal and atomic at the binding layer:

0. Session IDs migrate to principal form (`orchestrator:{userId}` → `orchestrator:user:{userId}`) as part of the teams schema migration, before any engine cutover — the engine only ever sees principal-form IDs.
1. Engine orchestrator session is created (same well-known ID, new `engine_*` state). Memory requires no migration — it is worker-owned D1 state reached over the API from either stack.
2. Binding resolution flips: the routing layer targets the engine session instead of the legacy DO. From this instant, new events admit to the engine.
3. The legacy DO drains: in-flight prompts finish, pending legacy approvals resolve through the legacy path, then the DO is stopped. A drain deadline (default 10 minutes) force-settles stragglers.
4. Legacy thread history is either bridged read-only (web UI reads old threads from legacy tables) or imported into `engine_entries` — decided per rollout stage; the engine never writes legacy tables.
5. Rollback before drain-complete is the reverse flip; after drain-complete, rollback is a fresh flip forward (the engine state is authoritative).

Org orchestrators have no legacy counterpart and launch engine-only.

## Open Items

- Delegation UX: how the org orchestrator presents "answered on behalf of" attribution on shared surfaces.
- Whether `agent_outbound` bindings require user confirmation for new shared surfaces (spam/abuse control).
- Author-aware steer on team threads (a member steering their own in-flight turn without affecting others').
- Whether org memory participates in personal orchestrators' read union the way team memory does, or stays org-orchestrator-private.
