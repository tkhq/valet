# Thread API cleanup

Thread-addressed routes and session-addressed routes call the same operations directly.
The API does not construct a second HTTP request or run authentication twice.
Each operation receives its session and optional thread address explicitly.
Both address families retain session ownership, private-thread visibility, and approval authority checks.
A thread URL cannot resolve or withdraw another thread's decision.
Workflow runtime threads permit metadata and decision operations only.

The web client uses thread URLs for explicit thread history, prompts, edits, channel activity, abort, and resume.
Session-wide lists, default-thread submissions, execution controls, and aggregate decisions retain session addresses.
The engine and query cache still use session IDs internally.
REST remains authoritative for persisted history.

## Compatibility retirement

Installed CLI versions can still require the two orchestrator POST aliases.
These aliases share the workspace runtime handler. Remove them after the supported CLI floor uses workspace runtime URLs.
Session conversation aliases remain until external clients migrate to thread URLs.

The upgrade restores a missing legacy assistant behavior column before reading retained integration restrictions. Existing restrictions remain unchanged.

Stored assistant target conversions remain available during upgrades from older binaries.
They must not become unconditional data deletion or bypass runtime permission checks.
A recorded conversion boundary can replace repeat scans only after deployments prohibit old writers.
Runtime status reconciliation remains an invariant check, separate from obsolete JSON conversion.

## Validation

Exercise both address families against persisted history.
Verify thread-local gate resolution and withdrawal, private threads, team API keys, workflow decisions, and malformed addresses.
Run client URL tests, API integration tests, typecheck, and the repository end-to-end scorecard.

Thread search rejects NUL characters before querying Postgres. The response asks the caller to remove the character.

### Account-scoped composer drafts

Draft persistence is scoped by authenticated organization and user, then session and thread. The signed-in shell waits for that account namespace before mounting composers. Switching accounts empties in-memory attachments and restores only that account's text. Late upload callbacks and storage events with another account's key are ignored. Legacy drafts have no provable author and are not restored. Signing out clears the active in-memory namespace; the owner's text remains available on their next sign-in.

The shell hides composers during identity verification on mount and focus. Successful sign-in, sign-up, and sign-out reload the document and notify other tabs to reload, so cached identity and in-flight requests cannot survive an account change performed in the app.

### Review authorization boundaries

Slack event threads use the same outside-reader restrictions as Slack conversation threads, including child-work access. A team member's channel message cannot inherit the rule creator's personal credential authority; only the creator's own linked message runs without the external-sender restriction. Workflows started by child sessions resolve their origin through the parent chain to the governing assistant thread. Missing or cyclic child ancestry rejects the start instead of dropping its privacy scope.

The navigation brand shows the Valet name without a runtime presence dot. The header no longer subscribes to runtime presence solely for that decoration.

### Interaction recovery audit

Stop and Escape interrupt failures now appear inline in the composer instead of only in the console. Failed approval, question-answer, and dismissal requests show an inline alert; retry clears it and a failed answer retains its text. Existing mutation and error-display helpers remain the source of behavior. Targeted composer and decision-card regressions cover recovery without adding a second interaction state machine.

### Workflow run audience preservation

Both run lists apply the same authorization as run details, including private-thread origins, private Slack events, and named approvers. Visible pages advance through bounded store pages; outgoing cursors name only authorized runs, since the store cursor contains a run ID and timestamp. Private rows neither appear as summaries nor become public continuation cursors.

A supplied workflow origin that is missing, archived, or invalid now rejects a start or retry. The service no longer drops that audience boundary and starts a team-visible run with private input. Retries of event-triggered runs retain their event provenance so Slack channel visibility remains enforceable even without a thread origin. Callers can still start an ordinary unattended run by omitting an origin; doing so is distinct from retrying private input.

### Repository sync and deferred Slack access

Repository workflow updates revoke action grants both before and after changed definitions are stored, matching product edits. The second revocation removes an approval committed against the old definition between the first revocation and the write. The collector regression injects that interleaving and verifies no grant survives.

Removed the obsolete boot report claiming organization-audience Slack rules admit unlinked members. That access mode remains deferred; existing linked-account gate coverage remains.

### Open shared-runtime privacy boundary

Team runtimes do not copy compaction summaries into shared journals. Summaries remain in their original thread history. Personal runtimes retain journal summaries.
This prevents automatic publication of private summaries. It does not isolate sandbox files or explicit memory writes, which remain release blockers.

Private transcript authorization does not isolate a team runtime's sandbox or workspace memory. The engine passes the session sandbox and owner into each thread's tool context, and memory tools use that owner as their default scope. Files or memory written from a private thread can therefore enter shared workspace state. The release default is to preserve private execution and storage boundaries. Shared files and memory must not silently receive private-thread data. Isolation remains a release blocker until implemented and verified; this no longer awaits a product decision.

Borrow approvals are reusable only by current members of the owning team in the grant organization. Chat, workflow, and sandbox Git readers check membership when consuming a grant. Missing actors and removed members cannot reuse it.

Team API-key prompts carry the team principal, not the administrator who created the key. Authorless team turns use the team identity for policy and credential reads. Workflow and child turns retain their explicit delegated actor. Team API keys and authorless team signals cannot receive personal-account approval gates. Machine principals use team connections instead of personal accounts.

WebSocket frames with unresolved thread metadata fail closed and are checked again on the next frame. Run lists inspect at most ten store pages per request. A partial page continues from its last visible row. If no visible row exists within that budget, the request returns an explicit error instead of exposing a private cursor or reporting empty history.

The API Helm deployment uses Recreate and clears rolling-update settings. The old API stops before the new process applies one-way schema repairs. This upgrade requires a short service interruption.

Proposal retries must match the stored normalized configuration and creator. Reusing a key for different subscription or schedule content returns an error. Identical retries preserve the existing enablement state.

Human-authored chat turns fail visibly when provider credentials are unavailable or a transient provider failure exhausts transport retries. They do not inherit background orchestrator retry delays. Workflow and child retries remain bounded. Steering and Stop do not emit provider-error banners. Empty interrupted assistant rows stay hidden after reload; partial answers remain visible.

Named account approvers can answer only their exact gate on a private run. They cannot read or cancel that run or answer unrelated gates. Unattended team workflows can consume an approved account grant only for their stored team and while the lending member remains on that team.

Team-key workflow starts use the team actor, never the key creator. Account checks preserve mounted composers after a verified identity on transient failures. Initial checks, account changes, and authentication failures still hide the previous account.

Session creation with an initial prompt records admission durably. A missing credential settles that human prompt as failed and returns the session to idle. Tests assert this terminal state rather than racing the initial working badge.

### Deleted-thread approval visibility

The decisions inbox excludes ordinary gates whose thread no longer exists.
A missing thread cannot establish audience access, even when its session belongs to the viewer's team.
Named account approvers retain their separate gate-only access.

### Authenticated tool discovery

Tool discovery requires the same member-account approval as execution.
An authenticated MCP tools request can transmit a credential, even when it only returns metadata.
Runtime and workflow credential readers therefore apply current borrow grants to discovery reads, including reads for another service.
External senders cannot use a teammate's borrow grant to discover tools.

Release follow-up: interactive dynamic-only MCP services need approval before discovery can obtain another member's credential.
Their current action gate follows discovery, so it cannot grant the initial access.
Keep discovery denied until that approval path is implemented; do not restore unconditional borrowing.

### Child steering identity

Each child follow-up persists the steering member as its execution actor.
The displayed sender is Valet because the agent composes the follow-up text.
Shared-account reads use that actor instead of the original spawner, including children with legacy actor credential mode.
The child retains its team owner and the original spawn identity.

### Shared automation identity

Team and organization schedules and non-mention events execute as their owning principal.
The saved creator remains audit attribution, not personal credential authority.
The same rule applies when a teammate edits or manually fires a shared schedule.
Personal automations retain their existing actor. Verified Slack mentions retain the linked sender and existing membership checks.
Shared workflows require an approved grant before borrowing a member's account.

### Legacy and missing thread audiences

Legacy Slack channel-only keys use the same channel membership checks as current thread keys, including DMs and group DMs.
Attention events referencing a missing team thread do not notify the team or send member DMs.
A missing audience cannot establish sharing permission. Workspace-wide events with no thread reference retain their existing routing.

### Shared sandbox Git credentials

A shared app session resolves Git credentials as its stored team or organization owner.
Its sandbox token names the first waker, not the actor of each later command.
Without a thread-bound actor, shared app sandboxes cannot use member shares or personal credentials.
Team-owned credentials and GitHub App installations remain available. Workflow sandboxes retain their run-scoped approval checks.

Shared sandbox repository bindings retain their restrictions: App-only bindings never select team tokens; personal-account bindings fail visibly because a shared runtime has no trustworthy current member.

### Briefing source origins

Team briefing generation and cache validation inspect persisted workflow and artifact origins, independently of optional links in the response. Missing, archived, private, or foreign workspace origins fail closed. Originless sources remain supported. Slack event-only runs are rechecked against current channel privacy on cache reads. Missing referenced outcome threads cannot become shared evidence.

### Workflow chaining audience

Workflow tool and session execution IDs are not conversation origins. Agent-started chained runs inherit the parent run's stored origin, scoped to its organization and execution owner, and validate it through the normal active-origin check. Missing parents and unavailable private origins fail closed. Originless scheduled runs can chain. Team Slack event runs remain blocked from agent-started chaining until the child can carry the channel audience independently; they must not silently become team-public.

### OpenAI tool member shares

The runtime OpenAI tool credential resolver uses the same current actor and borrow-grant checks as other tool services. A member may use their own shared account; another member requires an approved grant. External, missing, and removed actors cannot borrow. Organization LLM-provider and environment key precedence remain unchanged, and no chat-model provider configuration is changed.

### Missing source visibility

Batch source visibility defaults to denial when the referenced engine thread cannot be resolved. Artifact lists and other batch consumers must not infer a public audience from a missing source key or return its bearer token. A team artifact with a source session but no source thread also fails closed; truly originless publications remain supported. Existing resolvable public and private threads retain their normal audience checks.

### Sandbox memory ownership

Sandbox memory resolves the durable app-session or workflow-run owner in the token organization. The frozen first-waker actor never chooses the corpus. Shared runtimes use their workspace corpus, including machine-first wakes. Missing/deleted owners and stale personal-owner tokens fail closed; request headers and query parameters cannot change the scope. This does not establish private execution namespaces, which remain a release blocker. Terminal access is not widened to solve machine-first ownership.

### Dynamic tool discovery approval

Team runtime discovery goes through the existing tool policy, named-lender approval, grant persistence, and audit pipeline before calling a remote tool catalog. Discovery is a low-risk service action; executing the selected remote action still undergoes its own policy check. Pending, denied, expired, or failed approvals do not make a discovery request. Dynamic catalog caches are scoped by service, actor, thread, and external-sender status. The internal __valet_discovery__ action name is reserved so its approval cannot collide with a remote tool.

The outcomes route checks each team workflow result against its persisted event audience, even when no origin thread exists. Private Slack results require current channel access. Missing or foreign runs fail closed. The bounded page uses one run lookup and reuses the existing event visibility policy.
Team outcome continuation cursors encrypt hidden row identifiers with the instance key. Recognizable Slack events with no source channel fail closed across run visibility checks.

Borrow approvals bind to a random credential-share generation, for both conversation and workflow scopes. Revocation, account deletion, and re-sharing cannot restore old approvals. Repeated sharing of an existing share preserves its generation. Upgrade assigns generations to existing shares; previous unversioned borrow approvals require fresh approval. Team-owned connections remain available to unattended automation without a personal-account lender gate.

Slack acknowledges verified requests only after an encrypted durable inbox insert succeeds. The event dispatcher drains pending requests at startup and on new deliveries. Failed consumers retain the request for retry; successful processing removes it. Claims use the existing dispatch lease pattern. Diagnostic receipts can remain best-effort. Replay uses the captured verification time and encrypted signing secret, so accepted requests survive the network replay window and secret rotation. Direct messages check durable admission before reconstructing attachments. A request whose connected workspace changed waits for that workspace to be restored.
