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
| Rework & escalation rate | sessions that errored or escalated ÷ ended sessions | `sessions`, `mailbox_messages` (type `escalation`) | **Undercounts.** Escalations are written automatically on session errors and explicitly when the agent sends an escalation-type mailbox message; a user who gives up quietly produces neither signal |
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

5. **Explicit `session_outcome` event** — emitted at terminal transitions with a reason
   (user closed / idle timeout / error / escalated). Hardens cost-per-task, separates
   "abandoned" from "done", and makes time-to-done trustworthy. Cheap: the DO already
   batch-flushes analytics events.
6. **Webhook delivery health** — receipt/processing outcome per webhook. Doubles as
   automation debugging and a freshness guarantee for the PR metrics (a stale merge rate
   should look stale, not wrong).
7. **Daily sandbox-seconds deltas** — exact windowed compute cost instead of proration.

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
