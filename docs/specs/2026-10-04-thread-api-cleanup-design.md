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

Private transcript authorization does not isolate a team runtime's sandbox or workspace memory. The engine passes the session sandbox and owner into each thread's tool context, and memory tools use that owner as their default scope. Files or memory written from a private thread can therefore enter shared workspace state. Do not declare the release privacy-complete until the product boundary is decided and enforced: isolate private execution/storage, or explicitly define and communicate workspace files and memory as shared. No weaker boundary has been accepted as part of these fixes.

Borrow approvals are reusable only by current members of the owning team in the grant organization. Chat, workflow, and sandbox Git readers check membership when consuming a grant. Missing actors and removed members cannot reuse it.
