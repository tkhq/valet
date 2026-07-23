# Analytics Overview Redesign

## Motivation

The admin Analytics page is currently split into four tabs (Performance, Events, Value, Adoption) that don't tell one coherent story about product usage. Anthropic's own Claude enterprise analytics dashboard (who's using it → how they're using it → how agentic the work is → what it produces → what it costs) is a better shape for the same underlying questions, and this redesign adopts that structure using data Valet already collects.

The one section of that dashboard we explicitly do NOT copy is "Estimated time saved": it's computed from admin-supplied minutes-per-task assumptions, which is exactly the kind of fabricated efficiency number [PR #152](https://github.com/tkhq/valet/pull/152) just removed from the home dashboard (`estimatedLinesChanged = totalToolCalls * 15`) and deliberately left out of the workflow-autonomy metrics ("no pre-Valet baseline exists, so any such number would be fabricated"). No time-saved, hours-saved, or efficiency-gained figure appears anywhere in this design.

## Scope

**In scope (this spec):** Replace the "Adoption" tab with a new "Overview" tab assembling six sections, all backed by read-only aggregation over tables Valet already writes. No migration, no schema change, no new instrumentation.

**Out of scope, deferred to a future spec:** Skills usage/cost tracking. Valet's OpenCode skills (markdown files delivered to the sandbox) emit no event when loaded or used today — `tool_exec` events only capture the action-invocation framework's `service:action_id` tool calls, not skill loads. Confirmed by searching `analytics_events.tool_name` for skill-related values: only one incidental, unrelated hit (`linear:linear.list_agent_skills`, a Linear API action, not an OpenCode skill invocation). Shipping this requires a new event type and a write site inside the runner/OpenCode integration — separate work.

**Unchanged:** Performance tab and Events tab stay as they are. The Value tab stays as the destination for cost/spend detail; Overview's cost section is a summary that links to it, not a replacement.

## Data mapping

| Claude dashboard section | Valet data source | New or existing |
|---|---|---|
| Summary hero row | Active users (adoption-metrics), sessions + PRs merged (value-metrics), spend (value route) | Existing |
| "Who's using Valet" — active trend | `getActiveUsersByDay` | Existing |
| "Who's using Valet" — top users by spend | New: per-user cost, grouped from `analytics_events` token columns + model pricing | New query |
| "How are they using it" — adoption levels | New: `COUNT(*) FROM users` vs monthly/weekly/daily active counts | New query |
| "How are they using it" — stickiness by channel | New: DAU/MAU ratio per `channel`, reusing `getChannelBreadth`'s grouping | New query |
| "How are they using it" — connectors (users, reads, writes) | Extends `getServiceBreadth`: adds `COUNT(DISTINCT user_id)` and a read/write split via keyword match on `action_id` (`read_`/`get_`/`list_` vs `write_`/`update_`/`append_`/`create_`) | Extends existing |
| "How agentic is their work" | New: `tool_exec` count ÷ `turn_complete` count, per channel per day | New query |
| "What are the results" | PRs merged, sessions, file ops (`linesChanged`/`filesChanged` from #152), conversations (turn count) | Existing |
| "What it costs" | Value tab's existing spend-by-model + spend-trend, summarized | Existing (reused, not duplicated) |
| "Skills" | — | Deferred (Phase 2) |
| "Groups" (per-team spend) | — | Dropped: Valet has no team/group concept (single-org model) |
| "Estimated time saved" | — | Deliberately excluded (see Motivation) |
| "Usage limits" | — | Dropped: Valet has no per-user usage-cap concept today |

## Component structure

- `packages/client/src/components/analytics/overview-tab.tsx` — replaces `adoption-tab.tsx`, assembles the six sections below as sibling `Card`s (reusing the existing `Card`/`SimpleTable`/`Icon` primitives from the current Adoption tab).
- Backend: new query functions added to `packages/worker/src/lib/db/adoption-metrics.ts` (adoption levels, channel stickiness, actions-per-prompt, connector read/write split) and one new function in `value-metrics.ts` (per-user spend). Route: extend `GET /api/analytics/adoption` response shape (or add fields — exact shape decided in the implementation plan) rather than adding a new endpoint, since it's windowed the same way and gated by the same `adminMiddleware`.
- Human Intervention Rate hero card is removed. Its underlying data (median minutes blocked on a human decision) stays available in the existing Outcomes tables lower on the page — it's just no longer a hero metric.

## Sections in detail

### 1. Summary hero row
Four cards: Weekly Active Users, Sessions Started, PRs Merged, Total Spend — each with a delta badge against the prior window, matching the existing hero-card pattern (`HeroMetricCard`, `MetricHelp` tooltips explaining derivation).

### 2. "Who's using Valet"
- Active-users trend chart: daily active users, 30-day window (reuses `getActiveUsersByDay`).
- "Top users by spend" table: user, spend, session count — new query joining `analytics_events` (model + token columns) to model pricing, grouped by `user_id`, same cost formula the Value tab already uses at the aggregate level.

### 3. "How are they using it"
- Adoption-level bars: All members / Monthly active / Weekly active / Daily active, as a simple 4-bar comparison.
- Stickiness by channel: DAU/MAU ratio for `thread`, `slack`, `telegram`.
- Connectors table: service, distinct users, reads, writes — extends `getServiceBreadth`.

### 4. "How agentic is their work"
Hero card: org-wide "Actions Per Prompt" average (`tool_exec` count ÷ `turn_complete` count, current window). Trend chart below: one line per channel, daily.

### 5. "What are the results"
Stat row: PRs merged, sessions, file operations (lines/files changed), conversations (turn count). No time-saved or efficiency figure.

### 6. "What it costs"
Summary card: current-window total spend, spend-by-model breakdown — sourced from the same computation the Value tab uses (not duplicated query logic; the Overview route calls the same `computeValueWindow` helper and surfaces a subset), with a link to the full Value tab for the spend-concentration and MTD/QTD views.

## Testing

Unit tests for every new query function against the in-memory migrated SQLite fixture (same pattern as the existing `adoption-metrics.test.ts`), pinning: the read/write keyword classification on real `action_id` values seen in production data (e.g. `sheets.read_spreadsheet` vs `sheets.write_spreadsheet`, `updateSobjectRecord`), adoption-level bar counts against a fixture with a known mix of never-active/monthly-only/weekly/daily users, and actions-per-prompt division-by-zero handling when a channel has zero `turn_complete` events in the window.

## Open questions for the implementation plan

- Exact keyword list for the read/write action_id classifier (needs a full pass over the distinct `action_id` values across all plugins, not just the ones sampled during design).
- Whether "Top users by spend" needs any redaction/anonymization given it surfaces individual spend by name to any admin.
