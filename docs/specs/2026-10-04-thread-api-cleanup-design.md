# Thread API cleanup

## Routing and compatibility

Thread and session routes call the same operations directly, without another HTTP request or authentication pass. Both enforce ownership, thread visibility, and gate authority; thread URLs cannot resolve another thread's decisions. Workflow threads allow metadata and decision operations only.
The web uses thread URLs for explicit history, prompts, edits, channel activity, abort, and resume. Session URLs retain aggregate lists/decisions, default-thread submissions, and execution controls. Engine/cache keys remain session IDs; REST owns persisted history.
Keep CLI orchestrator aliases until the supported CLI floor uses workspace runtime URLs, and session aliases until external clients migrate. Upgrade restores missing legacy behavior columns and retains integration restrictions and stored target conversions. Replace repeat conversion scans only when old writers are prohibited; runtime status reconciliation remains necessary. No conversion deletes retained user data.
Helm uses Recreate without rolling-update settings so old writers stop before one-way repairs; allow a short outage.
Thread search rejects NUL characters. Proposal retries require matching normalized content and creator, and preserve enablement.

## Identity and audience

- Drafts are keyed by organization/user/session/thread. Ignore legacy drafts without provable authors. Account changes clear attachments and isolate late uploads/storage events; sign-out retains only the owner's persisted text. Identity verification hides composers initially/on focus; verified transient failures preserve them. Auth changes reload this and other tabs to discard stale identity and requests.
- Slack conversations/events and child work enforce outside-reader restrictions. Only the creator's own linked Slack message can retain that creator's account authority. Resolve workflow origin through child ancestry; missing/cyclic ancestry rejects starts. Unlinked Slack access remains deferred.
- Team API keys carry the team principal, never their creator. Shared schedules/non-mention events use their owning principal; creator is attribution. Personal automations retain their actor; verified Slack mentions retain linked sender/membership checks. Child steering persists the steering member as actor, with Valet as displayed sender, while retaining owner and spawn identity.
- Legacy Slack channel-only keys enforce current channel/DM/group-DM membership. Missing-thread attention cannot notify the team or DM members; truly workspace-wide events retain routing. Unresolved WebSocket thread frames fail closed and are checked again on the next frame.
- A supplied missing, archived, or invalid workflow origin rejects start/retry; event retries retain provenance. Ordinary unattended starts may omit origin. Chained runs inherit the parent run's stored origin under matching organization/owner; missing parents fail closed. Team Slack event chaining stays blocked until the child can carry channel audience.
- Run details, both run lists, and outcomes enforce persisted origin/event audiences, including private Slack channels and named approvers. Origin checks retain the session ID to follow private execution ancestry. Lists scan at most ten store pages; visible continuations never expose private run identifiers. An exhausted budget without visible rows returns an error. Outcome cursors encrypt hidden identifiers; recognizable Slack events missing channels fail closed.
- Missing source threads deny artifact/batch visibility and bearer-token disclosure. Team artifacts with source sessions but no thread are quarantined; truly originless publications remain supported. Legacy artifacts cannot inject comments into team runtimes. Missing-thread ordinary gates are omitted; named approvers retain exact gate-only access without read/cancel rights.
- Briefing collection and cache reads check persisted workflow/artifact/outcome origins independently of response links. Missing, foreign, archived, or private origins fail closed. Slack event-only sources recheck channel privacy; originless sources remain supported. See execution isolation for freshness and publication leases.

## Credentials and private execution

[Thread execution isolation](./2026-10-05-thread-execution-isolation-design.md) is the canonical contract for isolated sandboxes/memory, retained legacy history, artifact quarantine/cutover, and Slack inbox recovery. Do not copy private compaction summaries into shared journals; personal runtimes retain journal summaries. Isolation must not be weakened by treating private data as shared.

- Borrow grants require current actor/lender membership, matching organization/team, and random credential-share generation. Revocation/deletion/re-sharing cannot restore old grants; repeated existing shares preserve generation. Upgrade assigns generations and requires fresh consent for unversioned approvals.
- Named users approve only their own accounts. Ordinary authorless sessions, archived runtimes, and external/missing/removed actors cannot borrow. Verified unattended workspace assistants may request explicit lending approval when assistant/session/org/team match live records. Grants remain thread-scoped. Unattended team workflows may consume their approved run grant while the lender remains a member; team-owned connections need no personal lender gate.
- Legacy actor-mode sessions require a matching explicit turn actor; actorless command contexts use owner credentials. OpenAI tool reads enforce the same actor/grant checks; organization/environment LLM-provider precedence is unchanged.
- Shared app sandboxes resolve durable owner credentials, never first-waker identity. Without a thread-bound actor, no personal/member share is allowed. GitHub App and team credentials remain available; App-only repository bindings cannot select team tokens. Personal bindings fail visibly. Workflow sandboxes keep run-scoped approval.
- Sandbox memory uses durable app/run owner in the token organization; headers/query parameters cannot change scope. Missing/deleted owners and stale personal tokens fail closed. Private execution namespaces and terminal access follow the isolation contract.
- Authenticated tool discovery undergoes existing policy, named-lender approval, grant persistence, and audit before remote catalog access; metadata requests can transmit credentials. Execution still has its own policy check. Pending/denied/expired/failed approvals make no discovery call. Cache keys include service, actor, thread, and external status; `__valet_discovery__` is reserved.
- Repository definition edits revoke grants before and after storage, closing approvals racing the write.

## Admission and recovery

Human text/file/image prompts fail visibly when credentials are missing or transport retries exhaust, return to idle, and do not inherit unattended retry delays. Initial prompts record admission durably. Workflow/child retries remain bounded. Steering/Stop are quiet interruptions: empty interrupted assistant rows stay hidden after reload, partial output remains visible. Interrupt/decision failures appear inline, retain inputs, and clear on retry through existing mutation helpers. The navigation brand has no decorative runtime presence subscription.

Slack acknowledges verification only after encrypted durable inbox admission. Startup/new deliveries drain pending requests; consumer failures retain them. Replay uses captured verification time and encrypted signing secret across replay-window expiry/rotation. DMs check admission before rebuilding attachments. Changed connected workspaces wait for restoration. Dispatch leases/deduplication and terminal retry recovery follow the isolation contract; diagnostic receipts remain best-effort.

## Current UI and approval contracts

Thread search matches literal title/message text within the current workspace and existing audience filters. It excludes tool output/reasoning, limits queries to 500 characters, and debounces requests by 250ms. Selection follows thread identity as results arrive.

Chat gates use the composer column and shared primitives. Pending actions disable duplicate submissions, errors retain input, and reasons remain wrapped. Ordinary workflow approval submits directly; workflow-wide permission keeps confirmation. Scope, named-lender, iteration, and authorization checks remain enforced. Question fields submit with Command/Control+Enter, excluding empty, pending, repeated, and composing input; plain Enter adds a newline.

Workflow approval commits its signal, grants, audit, and wake flag together. Only the unique signal winner writes grants. Conflicting decisions return already_resolved; grant failure rolls back everything. Shared-account grants remain run-scoped, and durable wake recovers after restart.

Workflow signals use collapsed operation rows with outcome/run link visible and full report on expansion. Recent results starts collapsed; questions, failures, and approvals remain visible. Conversation updates use Open thread; detected questions use Reply. Briefings without a next step avoid claiming no action is needed.

Automation creation/editing share event matching and filter validation. Deselecting events prunes unsupported filters; catalog loading preserves stored filters. Fixed channel scope or explicit Any channel is required for mention rules. Edits send changed fields only; rename and collision retry retain existing behavior.

## Background reconciliation

Thread list reads never start GitHub requests. A non-overlapping minute sweep claims at most five organization/URL groups stale for ten minutes, under a short organization lock. Credential/network work occurs after commit, with a 30-second request timeout. Failures consume the check window; verified webhooks take precedence. Shutdown stops and awaits the sweep.

Overheard digests group only matching origin thread, author ID, and external-sender authority (absent equals false). Crash repair settles saved constituents without mixing groups. Existing mixed digests are not rewritten.

Named approvers on private child sessions receive exact pending-gate decision access, subject to organization/team membership. Other gates, history, prompts, and metadata remain private; access ends after resolution. A thread URL never grants access to a gate in another thread. Workflow approval notifications follow origin ancestry; an unresolved audience reaches nobody else.

## Validation

Exercise both route families against retained history, thread-local decisions, private/team access, malformed origins, named gate-only approvals, credential revocation races, account switching, and recovery. Keep child-list and dismissal coverage in `routes/child-work.test.ts`, including parent visibility, retained history, and stable dismissal timestamps. Borrow-grant tests call the production authorization predicate. Retain unique API/client regression coverage and the final end-to-end scorecard. Removing obsolete aliases requires client-floor evidence; deployment requires the separate database-copy migration and artifact-cutover checks.

Team CLI runtime resolution returns a writable execution: human requests use their private helper; team keys use the shared default.
PR replies retain their exact source session/thread, recheck archive state, and suppress recorded own writes even when source routing is unavailable.
Team deletion locks execution allocation, marks every owned session deleted, and tears down roots, executions, children, grants, and sandbox tokens.
Deleted executions cannot reopen. Logical workspace assistants remain permanent; individual executions can be deleted by authorized callers.
Slack startup returns 503 until verification and durable admission are available. At most ten inbox rows drain concurrently; each renews its fenced lease.
