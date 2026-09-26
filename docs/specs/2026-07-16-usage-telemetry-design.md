# Usage + Telemetry Design — tokens, performance, events, value

**Date:** 2026-07-16
**Status:** Draft
**Scope:** Org-level usage and telemetry for v2: a `turn_usage` engine event, a telemetry projection fed off the engine event bus, retention controls, and four org-admin tabs — Usage (tokens/cost), Performance (latency percentiles incl. sandbox provision/wake), Events (filterable feed), and Value (outcomes per dollar). Successor to the legacy `analytics_events` system, re-based on engine v2's event stream.

## Context

- The engine bus (`EngineEvent`, `packages/engine/src/types.ts:676-746`) already emits the lifecycle: `message_*`, `tool_start/end`, `turn_end`, `submission_settled`, `submission_stuck`, `sandbox_status` (with epoch), `decision_gate*`, `task_start/end`, `model_switched`. **But no event carries token usage** — per-turn usage (incl. pi-ai's cost breakdown) is captured in `thread.ts:2349-2363` into `lastAssistantUsage` and used only for compaction thresholds.
- Host code can subscribe across all sessions with `eventStream.subscribe({ eventTypes })` — exactly how the attention router is wired (`packages/api/src/orchestrator/attention-wiring.ts`).
- The durable engine event log is pruned per settled submission after 7 days (`host.ts` `EVENT_RETENTION_MS`) — it is a working log, not an analytics store.
- v2 has no `analytics_events`, no usage routes, no usage UI. Legacy reference: `packages/worker/src/routes/analytics.ts` + `schema/analytics.ts` on `main`.

## Decisions (locked)

1. **One new engine event: `turn_usage` (additive; the only engine change).** Emitted in the `turn_end` handler where `lastAssistantUsage` is already captured: `{ type: "turn_usage", model, usage: { input, output, cacheRead, cacheWrite, total }, cost?: { input, output, cacheRead, cacheWrite, total }, turnDurationMs, queueItemId }`. Cost comes from pi-ai's per-model pricing when the model is known to its registry; absent otherwise (never guessed). Appended durably like other bus events (per-submission pruning applies — fine, because the projection consumes it live with backfill via `read`).

2. **Projection, not a second source of truth: `telemetry_events` table in the api.** One global subscriber (registered at boot beside `wireAttentionRouter`, same never-throw discipline) projects selected bus events into flat rows: `{ id, orgId, userId, sessionId, threadId, eventType, occurredAt, model?, channel?, tokens{4}?, costUsd?, durationMs?, outcome?, service?, actionId?, error?, properties (JSON, size-capped) }`.
   - Projected: `turn_usage`, `submission_settled` (outcome + queue-wait computed from the submission's created→claimed timestamps), `sandbox_status` transitions (provision and wake durations derived per epoch: provisioning→ready deltas; wake distinguished from cold provision once the hibernation spec ships its `suspended` state — the projector records both under distinct eventTypes from day one), `decision_gate` opened/resolved (approval latency), `tool_end` where `isError`, `task_end`, `model_switched`.
   - **Deliberately lossy-tolerant:** subscriber gap (restart) is healed by a startup backfill sweep over `eventStream.read` for sessions active in the last 7 days, keyed idempotently by (sessionId, event offset) — beyond that window, gaps are accepted. It's analytics, not the ledger.
   - Channel dimension: thread-key prefix (`web:`, `telegram:`) — free once channels exist.

3. **Rollups are query-time, not stored.** Time-windowed aggregates (by org/user/session/model/day) are SQL over `telemetry_events` with the right indexes ((orgId, occurredAt), (orgId, eventType, occurredAt), (sessionId)). Postgres handles this fine at our scale; materialized rollups are a later optimization, not a table we design now.

4. **Retention: admin-configurable, default 90 days.** `orgs` gains a telemetry-retention setting (30/90/365/custom days); the host's existing periodic sweep deletes `telemetry_events` older than the window. Distinct from the engine log's 7-day submission pruning — the projection is precisely what outlives it.

5. **Four tabs, settings → Organization → Usage (admin-gated):**
   - **Usage:** tokens + cost by model / user / session over a selectable window; totals and top-N tables; cost rows absent (not zero) where pricing was unknown. Includes sandbox active-time (and sandbox cost when compute rates are configured — decision 6), combined into the hero total like v1.
   - **Performance:** p50/p95 turn duration, queue wait, sandbox provision time, sandbox wake time (the hibernation/warm-pool payoff meter), decision-gate approval latency, error rate. Percentiles computed in SQL (`percentile_cont`).
   - **Events:** cursor-paginated feed with eventType/user/session/time filters; row expand shows properties. The debugging surface.
   - **Value:** outcomes per dollar. Numerator (each shown separately, plus a combined count): submissions settled successfully, tasks completed (`task_end`), workflow runs succeeded, and artifact-shaped action invocations (joined from `action_invocations` by created-side actions — PRs/issues/messages; the join lands once the policies+audit spec ships, tab degrades gracefully without it). Denominator: cost (or tokens where cost unknown). **Explicitly labeled proxy metrics** in the UI copy — the tab is designed to absorb better outcome signals (user feedback, gate approval ratios) later without schema change (`outcome` + `properties` already carry them).
   - Routes: `GET /api/org/usage`, `/api/org/usage/performance`, `/api/org/usage/events`, `/api/org/usage/value` (admin), all window-parameterized.

6. **Sandbox compute cost (v1 parity, generalized).** The projector already derives sandbox lifecycle from `sandbox_status` events; it additionally accrues **sandbox active-seconds** per session (ready→released/idle/destroyed spans). Pricing them is deployment-specific: `orgs` telemetry settings gain optional compute rates (`cpuPerCoreSecondUsd`, `memPerGiBSecondUsd`, plus default cores/GiB used when a session has no explicit resources) — **unset by default** (self-hosted k8s has no universal price), in which case the Usage tab shows sandbox active-time without a dollar figure. When set, sandbox cost joins LLM cost in totals and the Value tab's denominator, mirroring v1's combined hero number.

7. **Session-level mini-surface (non-admin, cheap win):** the session view shows its own turn count / tokens / cost from the same table, access-gated by session access — same query, session-scoped.

## Reference: how v1 did cost (worker on `main`)

For continuity, v1's model — and what carries over:

- **LLM pricing came from models.dev** (`packages/worker/src/services/model-catalog.ts`): the external `api.json` catalog fetched per provider, cached in D1 with a 1h TTL, producing a pricing map keyed `provider/modelId` with `inputCostPerMillion`/`outputCostPerMillion`. `computeCost` in `routes/usage.ts` = `(inputTokens×in + outputTokens×out)/1e6`, returning null (not zero) when pricing was unknown. **Cache-read/cache-write tokens were not priced.** v2 instead takes pricing from pi-ai's bundled model registry (and the LLM-providers spec's catalog for custom providers) — no external fetch, and cache tokens ARE priced since pi-ai's cost breakdown includes them. The null-not-zero rule is kept.
- **Sandbox cost was Modal-specific** (`packages/worker/src/services/sandbox-pricing.ts`): hardcoded per-second rates (`CPU $0.00003942/core-sec`, `mem $0.00000672/GiB-sec`, defaults 1.5 cores / 1 GiB) × sandbox active-seconds, combined with LLM cost into the usage page's hero total and broken down by day/user. v2 generalizes this as decision 6: active-seconds are always tracked; rates are org-configurable instead of hardcoded because k8s/self-hosted deployments have no universal price.

## Exit criteria (the dogfood)

Run a handful of sessions (some web, one long-running with a >60s job, one erroring tool call, one gated approval). Usage tab shows per-model tokens and non-zero cost matching pi-ai pricing; Performance shows plausible p50s including sandbox provision time; Events feed filters by type and session; Value shows settled-successful counts per dollar. Restart the api mid-stream → no duplicate rows (idempotent projection), backfill covers the gap. Set retention to 30 days with older seeded rows → sweep removes them. A non-admin member sees only their session mini-surface, not the org tabs.

## Testing

- **Engine:** `turn_usage` emitted with the captured usage on normal turns, absent on turns with no assistant usage; event shape pinned; existing event consumers unaffected (fleet green).
- **Projector unit:** each projected event type → row mapping (golden); idempotency on duplicate delivery (offset key); queue-wait/provision-duration derivations from synthetic event sequences; never-throw wrapper.
- **Backfill:** kill subscriber, emit events, restart → rows appear once.
- **Query/route:** aggregate correctness on seeded fixtures (tokens sum, percentile sanity, value counts), window bounds, admin gating, retention sweep.
- **Store contracts untouched** — this adds an api-side table + a bus consumer; the engine store/event-stream contracts don't change (one added event type is additive to the union).

## Non-goals

- Billing/invoicing, quotas, or budget alerts (the data supports them later; no enforcement now).
- Materialized rollup tables (decision 3).
- Per-turn cost attribution for BYO-key orgs beyond labeling (cost is compute price, not what Valet charges — copy makes that clear).
- OpenTelemetry/external export (possible later sink for the same projector).
- Backfilling telemetry for sessions that predate the feature.
- User-level privacy controls beyond admin-gating (single-org trust model today).

## Daily active agents (2026-09-10)

`GET /api/usage/daily-agents?scope=org&window=30d` returns daily activity for collection outside Valet. It uses the existing usage scope checks. Org reads require an org admin; team reads require membership. The response contains aggregate counts, not session IDs.

An active agent is a distinct engine session with positive recorded token usage on a UTC calendar day. Repeated turns and threads count once per session per day. Children and workflow agents count separately from their parent assistant. Kinds are `assistant`, `child`, `workflow`, and `session`. Idle sessions, page views, zero-token entries, and external proxy calls do not count. Unpriced usage counts.

Each row contains `dayMs`, `teamId`, `teamName`, `kind`, and `activeAgents`. Team attribution uses the session or workflow owner from `cost_entries`, never the actor's team memberships. A null team ID means no team owner. Names reflect current team names. Sum the kinds for a team's daily total; do not sum daily counts to compute monthly unique agents.

Windows include the current partial UTC day and the preceding calendar days: `24h`, `7d`, `30d`, or `90d`. Missing day/group rows mean zero. This endpoint reads retained usage and ownership rows. Deletion can remove historical observations, and removing child-watch metadata can change classification. Collect completed-day snapshots externally if history must survive cleanup. No per-agent Prometheus labels or new telemetry writes are added.

## Team member daily active agents (2026-09-10)

The team Usage page adds **Avg daily active agents** to **By member**. The breakdown API returns `byUser[].avgDailyActiveAgents` and `dailyAgentWindow` only when the caller administers the team. Existing membership and org checks apply.

An active agent is a distinct engine session with positive recorded token usage on a UTC day. Children and workflow node sessions, including separate iteration sessions, count individually. Repeated turns and threads count once per session, actor, and day. Unpriced turns count. Idle sessions, zero-token entries, and proxy requests do not count.

The average divides session-days by all calendar days in the selected window: 1, 7, 30, or 90. This includes days without activity and the current partial UTC day. The `24h` selection means today for this metric. Spend retains its existing rolling window.

Team ownership comes from `cost_entries`, never the actor's memberships. Member activity uses the recorded queue prompt author, then the child's spawning actor. Ordinary sessions without either stamp use the existing session user. Shared assistants without an actor and team workflows without an actor appear under **Team / shared**. Activity can differ from billing attribution in the adjacent spend columns. A shared session used by two members counts once for each member that day; summing member averages is not a unique team total.

This adapts PR635's retained-usage session counting without adding another UI query, telemetry writes, or agent metric labels. Deleted usage and ownership rows remove history. Removing queue or child metadata can change attribution. These are retained-data observations, not permanent audit records.


## Active agents headline (2026-09-11)

The usage breakdown includes `activeAgents` for personal, team, and org scope.
It counts distinct engine session IDs with positive-token cost entries from
`now - windowMs` through `now`, including both boundaries. Unpriced usage counts.
Assistants, orchestrators, children, and workflow agent sessions use the same rule.
Repeated turns, threads, actors, and days do not increase a session's count.
Sessions without token usage in the window, zero-token entries, and proxy requests do not count.

The query uses the existing cost view and usage scope predicates. Team members
can see the aggregate count without per-member rows or session identifiers.
The headline uses the selected rolling window. The By member daily average
keeps its calendar-day definition; its values are not summed for this headline.
The five headline cards wrap from one to two to five columns as width permits.
Retained usage and ownership determine the count; this does not add permanent history.

## Usage reporting periods (2026-09-22)

The Usage page keeps the 24h, 7d, and 30d rolling lookbacks. It also accepts a
UTC calendar month or a custom start and end date. Custom dates are inclusive
in the UI. The API converts them to a half-open interval from the start day's
UTC midnight through the midnight after the end date. A completed month uses
its exact UTC month boundaries. The current month ends after the current UTC
day.

The API rejects invalid dates, reversed ranges, future dates, and custom ranges
longer than 366 days. All aggregate, drill-down, activity, and CSV queries use
the same lower and upper bounds. SQL applies direct comparisons to
`created_at`; it does not transform the indexed predicate or load raw turns for
aggregation. CSV filenames include the selected month or custom range.

## Finance CSV identity and work context (2026-09-24)

The usage CSV keeps its existing columns and adds `employee_name`,
`employee_email`, `repository`, `channel_type`, and `channel_id`. `user_id`
remains the stable identity column. Missing users and rows without a user keep
blank human identity fields. A plain team member cannot read any employee
identity fields.

Employee identity is a current join to the user table. It is not a historical
snapshot. Repository values come from durable session repository bindings and
use semicolons when a session has multiple bindings. Channel type and ID come
from the queue item linked to the billable engine entry. Queue items and usage
entries have the same session lifecycle. Historical rows without a linked queue
item or channel stay blank. Proxy rows also have blank work context. The export
does not infer a project or accounting category.

## Usage CSV export modes (2026-09-25)

`GET /api/usage/export.csv` accepts `granularity=day|hour|turn`. The default is
`day`. The route rejects any other value before it sends CSV data.

Daily and hourly exports aggregate the ledger in SQL. Each row uses a UTC
bucket start and groups by use case, recorded provider, model, owner type,
owner ID, and user identity. Provider is blank for engine entries because the
engine ledger does not record it. Proxy rows use their recorded provider kind.
The export includes turns, unpriced turns, each token type, total tokens, and
the sum of priced cost. These sums use the same predicates as the Usage
breakdown and reconcile for the same period and scope. Aggregate rows do not
include session, repository, or channel fields.

A plain team member gets no user identity dimensions. The SQL omits user ID,
name, and email from the group, so multiple members merge into one row when
the remaining dimensions match. Team admins and org admins keep the current
identity join. CSV formula neutralization applies to all text dimensions.

The `turn` mode keeps the itemized columns and descending time order. It has
no row cap. The API reads keyset pages of 5,000 rows in the stable descending
order `(created_at, use_case, entry_id)`. It never uses `OFFSET`. Repository
bindings are aggregated once for each page instead of once for each row. The
response stream holds at most one page of rows in application memory.

The route completes authentication, scope, period, and granularity checks
before it sends the CSV header. The web client also runs a validation request
before it starts the native browser download. The download does not use a
JavaScript response buffer or timeout. If a page query fails after streaming
starts, the API errors the stream and closes the connection as failed. It does
not end a truncated CSV as a successful file.

## Tool work and query cost (2026-09-25)

The usage page compares settled assistant tool calls with model tokens. It counts stored assistant `tool_call` parts with `completed` or `error` status. A handled failure can count, so this is an activity measure. It counts completed or failed workflow tool nodes with an execution duration as model-free actions. It excludes session action audit rows to avoid counting a model-directed call twice.

The page shows model-directed calls per million model tokens and lists model-free actions separately. A zero-token use case has no rate. Unpriced turns still add tokens. These measures do not establish task quality or business value. The store does not record whether tool-result bytes entered a model prompt, so result size cannot establish tokens saved.

`GET /api/usage/tool-efficiency` uses the same personal, organization, team, and date-range rules as the cost breakdown. It starts after the breakdown response. Assistant calls use entry time. Workflow actions use execution start time, with creation time as a fallback for old audit rows.

The cost breakdown computes use-case, model, day, member, and total aggregates with one `GROUPING SETS` query over `cost_entries`. A scratch PGlite sample of 30,000 rows reduced the earlier five-query aggregate from about 0.9 seconds to about 0.23 seconds. Production latency and the tool-parts query still need measurement before adding an index.

## Confirmed outcomes (2026-09-25)

`GET /api/usage/outcomes` uses the same scope and period checks as the breakdown. It counts successful GitHub PR creation, submitted PR reviews, Slack channel messages, and Slack DMs from `action_invocations`. A completed audit row counts only when its plugin result reports `success: true`. Pending reviews and failed actions do not count. The Slack rows describe delivery actions; they do not claim a message was a report.

The terminal path counts a `bash` call only when the engine stored a recognized outcome in the tool result. A direct `gh pr create` needs exit code zero and a PR URL. A direct `gh pr review` needs exit code zero and a submission flag. Compound shell commands are excluded. Old terminal transcripts have no outcome marker, so this path starts counting when the marker ships.

The tool-call queries replace serialized NUL escapes before they parse stored parts. This lets a binary tool result leave call counts available. Workflow session actions resolve the parent run from the `wf:<run>:<node>` session ID. Review counts use the successful result state, because the audit can cap long request parameters. Member spend rows sort by descending cost.

An outcome belongs to its session or workflow run. For each parent, the endpoint divides priced model spend in the selected period evenly across that parent's counted outcomes. Each outcome type gets its share. Spend from parents with no counted outcomes stays unallocated. The UI calls this allocated model spend, not marginal cost or ROI. Unpriced turns make the estimate a floor. Audit writes are best effort, so outcome counts can be incomplete.
