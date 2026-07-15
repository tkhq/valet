# Value Metrics — what we can track vs. what we'd want to track

**Status**: proposal for review · **Companion PR**: #94 (Value tab, first pass)

Today the admin analytics dashboard measures activity: sessions, messages, tokens, hours.
Those answer "is Valet busy?" — not "is Valet moving work forward?" This doc inventories
outcome metrics in three buckets: shipped in PR #94, computable today but not yet exposed,
and metrics that need new signals. Grades are honest: a metric only earns **solid** if the
underlying signal is written reliably on every relevant path.

## 1. Shipped in PR #94

| Metric | Formula | Source | Trust |
|---|---|---|---|
| Cost / resolved task | (billable tokens × models.dev price + prorated sandbox seconds × Modal rate) ÷ (completed production workflow runs + interactive sessions ended without error) | `analytics_events`, `sessions`, `workflow_executions` | **Proxy.** Numerator solid. Denominator counts "session settled error-free" as resolved — includes abandoned sessions, misses tasks-within-sessions |
| Accepted output rate | human-approved ÷ (human-approved + human-denied) permission prompts | `action_invocations` (only rows with `resolved_by`) | **Solid but narrow.** Only measures gated actions (~risky subset), not routine output |
| Session error rate | sessions that errored ÷ ended sessions | `sessions` (live `status` + `error_message`, recomputed per query — a hibernated session that wakes leaves the ended pool until it settles again) | **Undercounts rework.** Only hard errors count: the escalation half was retired with the agent mailbox (Teams #84 removes `mailbox_send` and renames `mailbox_messages` → `notifications`); re-source explicit escalations from the attention router's `notifications` once it lands. A user who gives up quietly still produces no signal |
| Median time to done | median(created→last activity) over resolved sessions | `sessions` timestamps | **Proxy.** Wall-clock span includes sandbox boot and waiting-for-human time; workflow-run median (started→completed) is exact |
| Agent PR merge rate | merged ÷ (merged + closed unmerged), agent-authored PRs | `session_git_state` (stamping fixed in #94) | **Collects forward** from ship date (a pre-ship PR can appear once it receives a post-ship webhook event); freshness depends on GitHub webhook delivery |
| Non-frontier token share | (efficient + standard tokens) ÷ (all tier-classified tokens) | `analytics_events` per model | **Solid.** Name-pattern tiers need occasional upkeep; unknowns excluded and surfaced |
| Session sources | ended sessions segmented by what they started from (PR / issue / branch / manual / none) | `session_git_state.source_type` | **Solid** where git context exists |

## 2. Computable today, not yet exposed (zero new instrumentation)

1. **Task-board resolution** — `session_tasks` already records per-task status
   (completed / failed / blocked) for orchestrator-managed work. This is the missing unit
   between "one message" and "one whole session": true task-granularity resolution, plus a
   blocked-task queue that doubles as a follow-up list. Coverage caveat: only work the
   orchestrator tracks as tasks.
2. **AI-generated lines of code** — the Runner already reports per-file additions/deletions
   into `session_files_changed`. Worth exposing as a *scale denominator* (defects per KLOC,
   review burden per KLOC) — on its own it's the classic activity-metric trap the executive
   checklist warns about (left column: "AI-generated code volume").
3. **Cost outliers** — per-session cost from existing token telemetry, surfaced as
   "top 10 most expensive sessions this window" with links. Answers the most common cost
   question ("what burned $40 yesterday, and did it produce anything?") better than any
   aggregate.
4. **Per-user value splits** — every PR #94 metric can be grouped by `user_id` (the
   session owner — multiplayer sessions attribute to the owner, not the actor) today;
   per-team waits on the Teams model (#84).

## 3. One small emit away

5. **Explicit `session_outcome` event** — ✅ **shipped.** Emitted as a `session.outcome`
   analytics event at every terminal transition in the SessionAgent DO, with
   `properties.reason ∈ { terminated, hibernated, error, recovery_exhausted }` and an
   optional `error_code` on the `error`/`recovery_exhausted` paths. Hardens cost-per-task,
   separates "abandoned" from "done", and makes time-to-done trustworthy. The DO-emitted
   outcomes are persisted the moment they fire: `emitSessionOutcome` writes the event to the
   DO-local buffer and then `await`s a `flushAnalyticsEvents()` to D1, so a terminal session that
   never runs another flush doesn't leave the row at `flushed = 0`.
   **Plus a GitHub-webhook-driven terminal outcome:** `properties.reason = 'pr_merged'`
   (`{ repo, prNumber }`), written when a `pull_request` webhook reports a merge for a session
   that **authored** that PR (matched on `session_git_state`; never for `source_pr` matches).
   This is the ultimate "shipped value" signal, so it is sourced from the webhook rather than
   the agent's own actions. It is written **out-of-band** — straight to `analytics_events` via
   `batchInsertAnalyticsEvents`, **not** by waking the DO — because the session is usually
   terminated/hibernated/gone by the time the PR merges. The event id is deterministic
   (`{sessionId}:pr_merged:{prNumber}`) so GitHub redeliveries dedupe via `INSERT OR IGNORE`.
   Cheap: the DO already batch-flushes analytics events, so the terminal-transition variants
   ride the existing flush.
   **Consumer semantics:** `hibernated` recurs across a single session's life (hibernate →
   wake → run → hibernate again is normal), so a session can have several `session.outcome`
   rows. Consumers must take the **last** outcome per session (by `created_at` / event id):
   a subsequent `terminated` or `error` supersedes everything before it. `hibernated` is
   **not** self-superseding — no outcome is emitted when a hibernated session wakes and runs,
   so a live, actively-running woken session still reads last-outcome=`hibernated`. Consumers
   that need liveness must join `sessions.status`, not infer it from the last outcome.
   `recovery_exhausted` is a distinct terminal reason even though it routes through the same
   `handleStop` termination path as `terminated`. `pr_merged` is asynchronous to the DO
   lifecycle and can arrive after any terminal outcome — it is a positive-value marker, not
   part of the supersession chain.
6. **Webhook delivery health** — receipt/processing outcome per webhook. Doubles as
   automation debugging and a freshness guarantee for the PR metrics (a stale merge rate
   should look stale, not wrong).
7. **Daily sandbox-seconds deltas** — exact windowed compute cost instead of proration.

**Also shipped alongside `session_outcome`: plugin action-outcome signals.** GitHub and
Slack plugin executors now emit low-cardinality analytics events on their success paths
(ids/enums/numbers only) via the `ctx.analytics` emitter already threaded through
`ActionSource.execute`:

- `github.pr_created` `{ repo, number, draft }`, `github.pr_merged` `{ repo, number }`,
  `github.issue_created` `{ repo, number }`
- `slack.message_sent` / `slack.message_updated` / `slack.message_deleted` `{ channel }`

Note the two `pr_merged` signals are distinct and complementary: `github.pr_merged` above
fires when the **agent** merges through the plugin, whereas the `session.outcome{pr_merged}`
in item 5 is **webhook-sourced** and fires whenever the PR merges (agent or human) — the
latter is the trustworthy shipped-value indicator; the former only corroborates it.

These are behavior-signal *foundations*, not a leadership chart — see §5's
"External-action volume" note: the raw signal is worth having (it corroborates the
webhook-sourced PR merge rate and gives the reaction-feedback work in §4 a message anchor),
but a "side effects by service" volume chart was deliberately cut and is not reintroduced
here. Linear is intentionally **not** instrumented: its actions run through the generic
remote-MCP passthrough (`McpActionSource`), which has no per-action success branch or typed
result to source `{ team }` from — see the deferral note in the PR description.

## 4. Bigger lifts, in rough priority order

8. **True accepted-output rate** — per-message feedback. The high-volume path is Slack:
   ingest 👍/👎 reactions on Valet's own replies (zero user behavior change); a web thumbs
   UI can follow. New `message_feedback` table + Slack event subscription.
9. **Review burden + defect rate** — ingest `pull_request_review` events (review rounds,
   requested changes per agent PR) and track reverts/hotfixes touching agent-authored code
   within 14/30 days. Extends the existing PR webhook handler.
10. **Surviving-LOC rate** — % of agent-written lines still present N days after merge
    (scheduled git-blame job). The honest version of "AI wrote X lines": how much *stayed*.
11. **Cycle-time comparison via Linear** — stamp session↔issue linkage at spawn, then
    compare cycle time for issues with vs. without a linked Valet session. A real control
    group; no fabricated pre-Valet baseline.

## 5. Deliberately not tracking (and why)

- **External-action volume** ("side effects by service") — shipped in an early #94
  iteration, cut on review: it counts actions taken, which is activity dressed up as
  outcome, and invites gaming. The governance angle (were risky actions human-gated?) is
  better served by policy audit tooling than a leadership dashboard.
- **Token trend as its own chart series** — tokens ≈ LLM cost at a different scale; the
  billing chart now plots cost only and keeps tokens in the hover detail.
- **Revenue per AI-assisted employee** — needs org-level revenue attribution that doesn't
  exist; parking it avoids inventing a number nobody can defend.
- **CSAT / repeat contact** — Valet is internal today; formal CSAT is a design
  conversation, not instrumentation.

## Recommended sequence

(1) `session_outcome` + webhook health — they make the shipped metrics trustworthy.
(2) Task-board resolution + cost outliers — pure exposure, one PR each.
(3) Slack-reaction feedback — unlocks the metric leadership will actually quote.
(4) PR review ingestion → review burden + defect rate.
