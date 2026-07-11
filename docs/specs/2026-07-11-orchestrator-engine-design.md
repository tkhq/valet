# Orchestrator on the Engine

> Defines the orchestrator as an application built on the portable runtime engine: identity, instant wake, channel bindings and tenancy resolution, thread policy, child sessions, mailbox-as-signals, task board, and the migration off the legacy DO.

## Scope

This spec covers:

- Orchestrator identity: user and org orchestrators, well-known session IDs
- Lifecycle on the engine: lazy creation, instant wake, sandbox-less default
- Channel bindings: the tenancy-resolution model the engine's ingress pipeline delegates to
- Routing policy: DMs vs shared surfaces, user/org arbitration, unbound events
- Thread policy: origins, keys, queue modes, archival and reactivation
- Mailbox and cross-orchestrator messaging as signals
- Task board integration
- Child sessions: spawning, attribution, limits, approval routing, result reporting
- Scheduled/automation dispatch into orchestrator threads
- Migration from the legacy SessionAgentDO orchestrator

### Boundary Rules

- This spec does NOT cover engine primitives (sessions, threads, submissions, gates, signals, event streams, sandbox attachment) — those belong to `docs/specs/2026-05-02-portable-runtime-engine-design.md`. This spec composes them.
- This spec does NOT cover memory internals (OKF format, FTS, snapshot assembly) — `docs/specs/2026-07-02-okf-memory-design.md`. This spec covers only how memory attaches to an engine-hosted orchestrator.
- This spec does NOT cover channel transport implementations (Slack/Telegram payload rendering, webhook verification) — those implement the engine's ChannelTransport contract. This spec owns the binding and routing policy above them.
- This spec does NOT cover workflow execution — `2026-07-11-workflow-run-host-design.md`. Scheduled triggers that target the orchestrator are covered here.

## Identity

Two orchestrator kinds, both full engine sessions with `purpose: 'orchestrator'`:

| | User orchestrator | Org orchestrator |
|---|---|---|
| Session ID | `orchestrator:{userId}` | `orchestrator:org:{orgId}` |
| Owner | one per user, per org membership | one per org, admin-configured |
| Identity row | `orchestrator_identities` `type: 'personal'` | `orchestrator_identities` `type: 'org'`, admin-set name/handle/avatar |
| Receives | DMs, personal mentions, personal schedules, mailbox signals addressed to the user | shared-surface events, unattributed events, org automation rules, org schedules |
| Memory | the user's memory store | an org-scoped memory store |

Session IDs are stable and permanent — one durable identity per orchestrator, never rotated. `orchestrator_identities` uniqueness holds on `(orgId, userId)` for personal and `(orgId)` for org; handles are unique per org.

The org orchestrator is the org's chief of staff. It exists so that shared surfaces have exactly one responder (see Routing) and unattributed events have a home. It is created on first admin configuration or first shared-surface binding, whichever comes first.

## Lifecycle

### Lazy creation

An orchestrator session is created on first demand — first channel binding, first web visit to the orchestrator UI, first scheduled dispatch. Creation is idempotent by well-known ID (`engine.createSession({ id })` returns the existing session). There is no onboarding step that must succeed before events can flow; an event arriving for a not-yet-created orchestrator creates it inline.

### Instant wake

The orchestrator has no user-visible wake state. An inbound event durably admits a submission; the engine host wakes in milliseconds and the turn starts immediately. The "is thinking" indicator appears on the originating channel as soon as admission succeeds.

The adapter host reconstructs `CreateSessionOptions` on wake from configuration, not from persisted creation options:

- **Persona and roles**: the orchestrator persona plus per-user identity, loaded as `RoleSpec`s.
- **Memory snapshot**: `systemContext` entry (pinned files + recent journals + neighbor tier), assembled at wake. Wake-time bootstrap also ensures today's journal exists and the link index is fresh.
- **Tools**: memory tools, channel tools, mailbox/task tools, the plugin action bridge, `task` — all engine-side ToolDefs configured via `toolConfig` (API base URL, credentials); nothing assumes a sandbox-local gateway.
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

This section fills the "application-owned" slot in the engine's ingress pipeline: `conversationKey → binding → { orgId, userId?, sessionId, threadKey }`.

### Binding model

```typescript
interface ChannelBinding {
  id: string;
  orgId: string;
  channelType: string;          // 'slack' | 'telegram' | ...
  conversationKey: string;      // transport codec output, e.g. slack:v1:{team}:{channel}[:{threadTs}]
  scope: 'user' | 'org';
  userId?: string;              // required when scope = 'user'
  sessionId: string;            // orchestrator:{userId} | orchestrator:org:{orgId} | a specific session
  threadKeyTemplate: string;    // how external threads map to engine thread keys
  queueMode: QueueMode;         // default 'steer'
  createdBy: 'user_link' | 'admin' | 'agent_outbound';
  createdAt: number;
}
```

Bindings are unique per `(channelType, conversationKey)` within an org. They are created by:

- **User linking** — a user connects a channel (Telegram `/start`, Slack account link): binds their DM conversation to their orchestrator.
- **Admin configuration** — an admin binds a shared surface (a Slack channel) to the org orchestrator.
- **Agent outbound** — when an orchestrator initiates a conversation on a channel, the send tool records the binding so replies route back.

**A conversation key is never a capability.** Resolution authorizes against the binding (and the actor's identity link) before admission; an event with no binding follows the unbound policy below.

### Identity links

`user_identity_links` maps `(provider, externalId) → userId`, unique per provider. Inbound actors resolve through this table; unresolved actors on personal surfaces receive an account-linking reply. Links are managed from the web UI and channel linking flows.

### Routing policy

The arbitration rule is structural, not heuristic — **surface type picks the orchestrator**:

1. **Direct/private surfaces** (Slack DM, Telegram private chat) → the linked user's orchestrator. Unlinked actor → account-linking reply, no admission.
2. **Shared surfaces** (channels, groups) → the **org orchestrator**, always. Personal orchestrators never respond on shared surfaces; this makes "which of N members' Jarvises answers?" unaskable. The org orchestrator may delegate: it sends a mailbox signal to a user's orchestrator (with the conversation context and reply target), and that user's orchestrator responds *through the org orchestrator's binding* with its own persona attribution.
3. **Unbound + unattributed** — shared-surface events with no binding are ignored (acknowledged, not admitted). Personal-surface events from unlinked users get the linking reply. Nothing is ever silently admitted without a binding.

Admission is always a `SignalContent` (`signalType: 'slack.message'` etc., sender identity and external IDs in attributes) with `dispatchId` = the provider's stable event ID.

### Replies and personas

Outbound replies flow through the bound transport with the orchestrator's persona (name/avatar) resolved per identity row. Reply targets come from the thread's origin channel; when a thread has no channel origin (web, automation), channel sends require an explicit target from the model. Delivery is fail-closed: a reply that cannot resolve its origin target surfaces in the web UI only, never broadcast to all bindings.

## Thread Policy

Orchestrator threads are engine threads with origin metadata:

- **Thread keys**: `slack:{team}:{channel}:{threadTs}`, `telegram:{chatId}`, `web:{n}`, `schedule:{triggerId}`, `mailbox:{senderSessionId}` — one engine thread per external conversation by default. Convergence (a Slack thread and web steering the same engine thread) is a deliberate per-binding choice, not an accident.
- **Origins** persist on thread metadata (`originType`, channel refs, trigger refs) and drive sidebar grouping and reply-target recovery.
- **Queue mode default is `steer`** for conversational threads: the newest human message supersedes an in-flight turn, matching how people actually use a chat assistant. Steer withdraws that turn's pending gates per the engine contract. Automation/schedule threads use `followup` (automation output must not be superseded by a later tick). `collect` is available per binding for high-burst surfaces.
- **Archival and reactivation**: threads archive on inactivity; an inbound event for an archived thread's conversation reactivates it. Archival summarizes into thread `summary` so `list_threads`/`thread_read` stay useful without unbounded context.
- Scheduled dispatches open fresh threads (`forceNewThread` semantics) with a preamble instructing memory-first orientation.

## Mailbox as Signals

The mailbox is a **convention over engine signals**, not a subsystem. A mailbox message is:

1. a durable row in `mailbox_messages` (the queryable inbox: threading, read state, notification preferences), written by the `mailbox_send` tool, plus
2. a `SignalContent` admission to the recipient orchestrator (`signalType: 'mailbox.message'`, sender/context in attributes, `dispatchId` = the mailbox row ID) when the recipient should act, routed to a `mailbox:{sender}` thread.

Addressing supports `to_user_id`, `to_session_id`, and `to_handle`. The recipient's notification preferences decide fan-out (web badge, channel forward, email) — that is delivery policy in the application layer, not engine behavior. `mailbox_check` reads the inbox; unread mail is also summarized into the wake-time memory snapshot context.

Cross-orchestrator communication (org → user delegation, child → parent reporting, user → user handoff) all use this one mechanism. There is no second messaging pathway.

## Task Board

Unchanged as a data model: `session_tasks` + `session_task_dependencies`, scoped by orchestrator session, with `task_create` / `task_list` / `task_update` / `my_tasks` tools and the existing routes. Two integration rules:

- Task assignment to a person emits a mailbox signal to their orchestrator.
- A task's `sessionId` assignment links it to a child session; child settlement (below) updates task status via the parent's handling of the result signal, not via automatic coupling.

## Child Sessions

- **Spawning** is the engine's `task` tool (child session with `purpose: 'child'`, `parentSessionId` = the orchestrator ID, `parentThreadId` = the spawning thread). Explicit params (repo, branch, model, persona) merge over defaults; the adapter injects repo credentials and git identity from the owning user's profile. Children cannot spawn (depth limit 1 for orchestrator children; the engine's task depth limit enforces it — not an env-var check).
- **Limits**: orchestrator children bypass the interactive active-session cap but get their own explicit concurrency limit (per-org configurable, default 10 active children per orchestrator). Unbounded spawning is a cost bug waiting to happen; the limit is enforced at spawn, with a structured tool error naming the running children.
- **Result reporting**: child completion emits a mailbox signal to the parent (`signalType: 'child.settled'`, child session ID + outcome + summary in attributes), admitted to the spawning thread. The parent reads details via cross-session `thread_read`. Interactive nudging of a running child is a prompt to the child's thread (`send_message` semantics), attributed to the orchestrator.
- **Approval routing**: a decision gate raised in a child session resolves its delivery targets **through the parent's thread origin** — the gate surfaces on the channel where the conversation that spawned the work lives, plus the web UI. Fail-closed: no origin target → web UI only, never broadcast. Gate refs and channel updates follow the engine's gate delivery contract; this spec only fixes *whose* bindings are consulted (the parent's).

## Scheduled and Automation Dispatch

Scheduled triggers and workflow `orchestrator` nodes dispatch through the same admission path as channels: a `SignalContent` (`signalType: 'schedule.tick'` / `'workflow.dispatch'`) with `dispatchId` = trigger/run-scoped ID, into an automation-origin thread, `followup` mode, optional per-dispatch model override. Workflow nodes then use `awaitResult` per the Workflow Caller Contract. The persona continues to recommend orchestrator-mediated automation over direct workflow execution for judgment-requiring tasks.

## Access Control and Teams

- A user orchestrator is visible and steerable only by its owner (plus org admins for audit-level read).
- The org orchestrator is readable by org members and steerable per org policy (default: admins steer, members converse via bound shared surfaces).
- Decision gates route to actors authorized for the resolution: child-session gates to the spawning user; org-orchestrator gates to admins (or the automation rule's designated approvers).
- Team scoping attaches to bindings and threads (a team-bound channel routes to the org orchestrator with team context in attributes) — teams do not get their own orchestrator kind in V1.

## Migration

The one-Jarvis rule: an orchestrator identity runs on exactly one stack at a time. Cutover is per-user and atomic at the binding layer:

1. Engine orchestrator session is created (same well-known ID, new `engine_*` state). Memory requires no migration — it is worker-owned D1 state reached over the API from either stack.
2. Binding resolution flips: the routing layer targets the engine session instead of the legacy DO. From this instant, new events admit to the engine.
3. The legacy DO drains: in-flight prompts finish, pending legacy approvals resolve through the legacy path, then the DO is stopped. A drain deadline (default 10 minutes) force-settles stragglers.
4. Legacy thread history is either bridged read-only (web UI reads old threads from legacy tables) or imported into `engine_entries` — decided per rollout stage; the engine never writes legacy tables.
5. Rollback before drain-complete is the reverse flip; after drain-complete, rollback is a fresh flip forward (the engine state is authoritative).

Org orchestrators have no legacy counterpart and launch engine-only.

## Open Items

- Org-orchestrator memory store scoping (org-owned OKF tree vs. shared namespace in the org) — needs the memory spec's input.
- Delegation UX: how the org orchestrator presents "answered on behalf of" attribution on shared surfaces.
- Whether `agent_outbound` bindings require user confirmation for new shared surfaces (spam/abuse control).
