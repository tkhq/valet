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
- Run details, both run lists, and outcomes enforce persisted origin/event audiences, including private Slack channels and named approvers. Lists scan at most ten store pages; visible continuations never expose private run identifiers. An exhausted budget without visible rows returns an error. Outcome cursors encrypt hidden identifiers; recognizable Slack events missing channels fail closed.
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

## Validation

Exercise both route families against retained history, thread-local decisions, private/team access, malformed origins, named gate-only approvals, credential revocation races, account switching, and recovery. Retain unique API/client regression coverage and the final end-to-end scorecard. Removing obsolete aliases requires client-floor evidence; deployment requires the separate database-copy migration and artifact-cutover checks.
