# Web-first attention delivery

Date: 2026-10-20. Issue: TKAI-649.

## Routing

The attention router inserts the web notification immediately.
It stores personal delivery jobs in the same Postgres transaction.
Team home-channel posts remain immediate.
Transports without configured bot credentials do not queue personal jobs.
Jobs created before credential discovery are dropped if the transport is unconfigured.
Transient credential lookup failures keep their jobs recoverable.
Existing audience rules and team DM opt-in remain in force.

Web notifications are tier zero.
Each personal deliverer declares a stable `id`, an `order`, and a `grace` policy.
Deliverers with the same order share a tier and must use the same grace policy.
The router sorts deliverers by order.
A `when-web-active` tier adds the user's per-kind grace to the previous tier's deadline.
An `immediate` tier adds no delay.
The host registers one durable deliverer per messaging transport.
These deliverers share one order and one grace period.
Adding a push tier requires another deliverer, not a router branch.

If the user is inactive, every personal tier is due immediately.
If web delivery is disabled for the kind, every personal tier is due immediately.
Presence is sampled once when the router creates the jobs.
Later heartbeats do not extend a job's deadline.

## Presence

The signed-in web shell reports a separate random identifier for each tab.
Visible tabs report active after input and every 20 seconds while input remains recent.
Input remains recent for two minutes.
A visibility change reports the tab's current state immediately.
An idle tab reports inactive and stops active heartbeats.

`POST /api/notifications/presence` requires browser session authentication or the local development stub.
Personal API keys and CLI tokens cannot report presence.
Pointer movement and scrolling do not count as input.
The server uses the authenticated user's identifier, never a client-supplied user identifier.
Any active tab counts toward that user's presence.
A heartbeat expires after 45 seconds.
A hidden report clears only its own tab.

The API currently runs one replica.
Presence uses an in-memory map scoped to the API database handle.
Multiple replicas will require shared presence storage.
A restart clears presence but does not clear delivery jobs.

## Durable scheduling

`pending_channel_deliveries` stores the user, tier, optional web row, event, and deadline.
It also stores sending time, status, attempt count, provider refs, and last error.
The job identifier combines the existing notification dedupe key with the stable tier identifier.
Repeated producers cannot create another job for the same recipient and tier.
Events without a dedupe key remain one-shot events.

The existing event dispatcher drains due jobs every second.
After the transaction commits, the router starts an immediate drain without awaiting it.
Security handlers and workflow run drives wait for durable insertion, not personal provider calls.
Each transport has one independent batch in flight per API database handle.
Each batch runs at most four jobs concurrently and selects at most 20 jobs.
A slow Slack batch cannot hold Telegram's next batch.
The batch signal follows delivery, reconciliation, host preparation, gate settlement backfills, and provider HTTP requests.
After each awaited preparation step, the host checks the signal before it starts another provider call.
Provider clients check the signal before every post, update, history page, and retry, and pass it to fetch.
A request sent before cancellation can still land. Recovery reconciles that ambiguous send.
An abandoned worker cannot start another provider request after cancellation.
Dispatcher shutdown does not await personal provider calls.
Unfinished sends retain their durable leases for restart recovery.
Configured transports get a 30-second startup grace from the first dispatcher drain.
During that window, unready transports do not claim jobs or spend attempts.
After the window, an unready transport records failed attempts and uses the normal recovery backoff.
A failed startup therefore raises the recovery failure alert.
A drain request during an active batch sets one re-drain flag.
Each batch reselects all due rows for its tier. Requests do not carry replacement dependencies or selection filters.
Immediate IDs exist only to cover the short producer-before-parking window and are consumed per batch.
The next selection retains IDs and the latest requested time even when one job fails.
Claims, delivery failures, and retry bookkeeping errors stay inside each job handler.
One failed claim cannot reject the bounded mapper or release the tier while its sibling workers remain active.
The outbox retains authorization providers per database handle, independently of the queued requests.
An access-less producer cannot remove these providers when its request merges with a dispatcher request.
A later provider set retains the existing optional 1Password provider when the new set omits it.
These are live provider references, not cached membership or authorization results.
No in-process timeout owns a notification deadline.
A restart picks up pending jobs and stale sending jobs from Postgres.
An index over pending and sending deadlines bounds the due scan.
A notification index supports approval-copy lookups during bulk-read.
The app migration and schema repairs both create the outbox and preference column.

Before sending a deferred job, the drain checks:

1. The web row still exists and is unread, when the job references one.
2. The engine decision gate is pending, when the event carries one.
3. The workflow checkpoint still holds the same unanswered approval, when the event references one.
4. The recipient still belongs to the event's authorized audience.
   Delivery checks membership and thread visibility only for this job's recipient.
   Enqueue-time audience resolution still checks all recipients.
   Another member's failed or rate-limited lookup cannot block this recipient.
   A definite denial drops the job.
   Slack errors such as `channel_not_found`, `not_in_channel`, and `is_archived` are definite denials.
   Unknown channel privacy or a failed membership lookup retries without sending.
   Missing authorization providers for a restricted channel thread also retry; they never imply a permanent denial.
   Personal helper and workflow-editor ownership checks remain local.
   Attention checks never authorize with an expired public classification after a failed refresh.
   Their privacy cache is separate from ordinary readers, which retain the stale fallback.
   Loading a stored classification into memory does not extend its original freshness deadline.
5. The recipient still allows team DM copies, for team events.

The channel deliverer checks the current identity link's `notifyAttention` setting before sending.
Gate buttons and their authorization checks use the existing channel path.
Approver-only events keep their explicit recipient.
Org-admin audiences follow the same per-recipient presence policy as personal and team audiences.
One recipient's read state does not suppress another recipient's job.
The bell's bulk-read action clears updates and completed approval copies.
It retains approval copies only while a pending or sending job references a pending gate.
Legacy copies without a fallback job remain clearable.
Gate resolution and explicit per-row reads still mark approval notifications handled.

The immediate producer can run before a workflow finishes parking.
Its immediate drain trusts the current gate event only during the first five seconds after enqueue.
The age check runs when processing the claimed row, not when queuing the drain.
After that window, even queued immediate requests check durable gate state.
A later dispatcher pass always checks durable gate state.

## Delivery boundary

A conditional update moves each due job to `sending` and records `sending_at`.
It sets `first_sending_at` only when that field is null, using the prior `sending_at` for legacy rows.
Later claims never move that first unreconciled send time.
Reconciliation searches from that time minus the provider clock-skew window.
The same statement moves its next deadline forward by two minutes from the claim time, not the batch start.
The update repeats the due predicate to fence concurrent workers.
Only the winning worker sends.
Each completion also checks the attempt number, so a stale worker cannot overwrite recovery.
Each tier batch retains one 90-second cancellation deadline, shorter than its sending lease.
Storage reads do not accept cancellation, so the deadline still releases a worker blocked before HTTP preparation.
The signal aborts every surviving worker before the tier can start another batch.
A timeout logs the stalled batch and increments the recovery-failure counter.
It releases the in-memory tier lock while claimed jobs remain recoverable.
Abandoned workers cannot claim another row or start another provider call after the timeout.
A provider call already in flight can still finish; the attempt fence protects later recovery.

After the provider confirms, the worker records `sent` and the provider message refs.
Slack refs include the channel identifier and message timestamp.
Handled jobs record `dropped`.
Confirmed jobs are never selected again.

A crash can leave a job in `sending` after the provider accepted its message.
After two minutes, the dispatcher claims that job for recovery.
It calls the deliverer's optional `reconcile` hook before resending.
If reconciliation finds the message, the worker records its ref without sending again.
A miss, unsupported hook, or lookup failure causes a resend.
After a timeout, the worker tries reconciliation immediately, including errors wrapped by the channel host.
A confirmed gate card gets its callback refs before the worker records success.
A miss or failed lookup retains the normal durable recovery path.
An uncertain send may produce a duplicate.
This is intentional: a lost approval notification is worse than a duplicate.

Slack sends plain attention DMs and approval cards with message metadata:
`event_type: valet_attention` identifies summaries; `valet_attention_gate` identifies interactive cards.
Both metadata payloads contain only `delivery_id`, an opaque random token stored in the row's `delivery_token` column.
The producer generates a new UUID per inserted row. Replays retain the existing token.
Schema repairs give existing rows a random token.
Neither metadata payload contains a gate id, resume key, derived job id, or action arguments.
Direct calls without a durable row also generate a random token.
Its reconciliation hook reads recent DM history with metadata included.
The lookup checks at most five pages of 100 messages.
Each history request has a two-second timeout and does not retry rate limits.
Missing history permissions cause a resend, not a lost notification.
The card event type distinguishes an authorized card from a summary without exposing its gate id.
The host maps the row token back to its local gate event during reconciliation.
Reconciliation restores gate callbacks only for an actual gate card and a currently authorized recipient.
A plain summary never becomes a gate card during recovery.
A failed callback-ref save is logged but does not resend a confirmed message.
If a gate settles while its attention card posts, the host detaches the settlement edit and logs failures.
The confirmed delivery does not wait for this edit.
Slack settlement edits on this path use the attention deadline; ordinary edits keep their prior behavior.
Saving the same gate reference twice is idempotent.
Transports without history reconciliation still recover by resending.

A transient or unknown provider failure retains `sending` and its error for the next recovery attempt.
Definite per-recipient rejections instead mark the job `dropped` on the first attempt.
Slack rejects recipient-specific `user_not_found`, `cannot_dm_bot`, and DM `channel_not_found`.
Slack `account_inactive` describes the token user or workspace, not the recipient.
It remains retryable and contributes to the recovery-failure alert.
Telegram rejects a 403 response that states the user blocked the bot or is deactivated.
Plugins normalize these replies to `ChannelDeliveryRejectedError`.
Mixed permanent and transient failures keep retrying.
The rejection counter exports as `valet_attention_delivery_rejected_total`, with bounded `channel` and `reason` labels.
Rejected rows do not increment the recovery-failure counter and do not enter the oldest-job gauge.
Failed sends use exponential backoff from two minutes to 30 minutes.
Fresh deliveries sort ahead of retrying jobs.
There is no retry limit or age cutoff for an unhandled notification.
This preserves blocking approvals across long channel outages.
The failure counter labels recovery failures with `retry=true`.
The provisioned attention recovery alert reports those failures for operator action.
The `valet_attention_oldest_job_age` gauge measures overdue time from the earliest pending or sending `deliver_after` in Postgres.
It clamps future deadlines to zero, excluding intentional grace periods and scheduled retry waits.
Its `s` unit exports as `valet_attention_oldest_job_age_seconds`.
An alert warns when a job is more than 30 minutes overdue, even if a transport has never become ready.
The active-row due-time index bounds this query.
Existing branch databases get their initial enqueue timestamp when the schema repair adds the column.
Every retry repeats the read, gate, audience, and preference checks.
Local read markers, terminal gates, team-DM preferences, and disabled identity links drop the job before remote audience checks.
A remote Slack outage cannot keep a locally handled job active.

Only attention Slack posts, settlement edits, DM opens, and delivery-time audience checks use a ten-second deadline.
That deadline includes rate-limit waits and response body reads.
Reconciliation keeps its two-second per-history-request deadline.
Shared Slack API callers, uploads, downloads, and connection requests retain their prior timeout behavior.
Only attention Telegram messages, gate cards, and settlement text edits have a ten-second request timeout.
Ordinary sends, photos, documents, and downloads retain their prior timeout behavior.
Telegram long polls retain a 40-second bound and the caller's cancellation signal.

Completed job keys and confirmed refs remain stored to prevent producer replay.
Terminal jobs replace the event payload with JSON null and clear their last error.
The schema permits JSON null, not SQL NULL, for these tombstones.
The delivery path has no legacy-payload cleanup query.
Only earlier builds of this branch wrote those legacy rows.
An active row with a JSON-null event is logged and dropped independently of other jobs.

## Preferences

`user_notification_preferences.channel_grace_seconds` stores an optional per-kind delay.
A null value uses 120 seconds for approval, question, escalation, and review.
General notifications use 300 seconds.
Zero disables the grace.

The existing preferences GET route returns the effective delay.
The PUT route accepts an integer from zero through 86400 seconds.
Null resets the delay to its default.
Omitting the field preserves its value.
The notification settings page offers immediate delivery and several short delays.
The delay control uses the effective GET value and is disabled when web delivery is off.
Preference edits affect new jobs only.
Already queued jobs retain their original deadline.

## Validation

Tests cover tab expiry, multiple tabs, heartbeat timing, hidden reports, and authenticated user scope.
Routing tests cover active users, inactive users, disabled web delivery, custom grace, and ordered tiers.
Outbox tests cover handled rows, terminal gates, pending gates, deduplication, concurrent claims, and restart recovery.
Existing channel suites cover gate controls and current identity-link preferences.
Regression tests cover nonblocking routing, independent transport batches, bounded concurrency, and claim-time leases.
They cover bounded startup deferral, session and local-stub presence, terminal-payload scrubbing, and transient audience failures.
They also cover queue-age metrics and alerts, re-draining, permanent Slack denial, long rate-limit waits, and attention-only deadlines.
Recovery tests distinguish summaries from cards and tolerate failed callback-ref saves.

Regression tests cover summary metadata secrecy, stable row tokens, terminal provider rejection, earliest-send recovery, and ordinary Telegram operations over ten seconds.


## Integration with dev-v2

The branch merges dev-v2 without rewriting notification commits or their review history.
Slack exports retain both terminal access-error classification and event channel-name enrichment.
The joined-channel directory retains private-channel metadata alongside attention cancellation and reconciliation.
The attention outbox repairs create the table before adding columns, then create indexes after their columns exist.
