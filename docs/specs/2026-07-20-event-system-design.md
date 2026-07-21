# Event System Design — GitHub & Linear Webhooks → Generic Events

**Date:** 2026-07-20
**Branch:** dev-v2
**Status:** Implemented on dev-v2 (branch docs/event-system-design)

## Goal

A generic event system for v2: GitHub and Linear webhooks flow in as normalized,
durable events, pre-configured by app installation (no per-event setup). Users
subscribe to events via triggers that can start workflows, prompt orchestrators,
signal waiting workflow runs, or be browsed in an API/UI feed.

## What existed before this work (dev-v2)

- **`TriggerDef` contract** (`packages/engine/src/valet-plugin.ts:37`):
  `verify()` over raw request bytes + `toSignal()`. Defined but not consumed by
  `packages/api`.
- **`plugin-github` implements it** (`packages/plugin-github/src/triggers.ts`):
  HMAC verification + webhook parsing ported from v1.
- **GitHub App webhook** (`packages/api/src/routes/github-app.ts`): public
  endpoint, HMAC-verified, but only handles `installation` /
  `installation_repositories` (syncs `github_installations`). All other event
  types are dropped.
- **Workflows** have `WorkflowTriggerPayload { type: 'manual' | 'schedule' | 'webhook' }`
  (`packages/workflow/src/dag/shape.ts:58`); nothing wires external webhooks in.
- **`plugin-linear`** is a stub (MCP actions only; no triggers, no webhooks).
- **ChannelHost** (`packages/api/src/channels/host.ts`) routes chat events to
  orchestrators — precedent for orchestrator delivery, but chat-message-shaped.

The core of this project is building the **host side** of the existing
`TriggerDef` contract, plus a Linear implementation.

## Architecture

```
GitHub App webhook ─┐
Linear webhook ─────┤→ Ingest (verify sig → resolve org → normalize) → events table
future plugins ─────┘                                                       │
                                            Dispatcher (1s poll + in-process ingest nudge)
                                                                            │
                                              match against event_subscriptions
                                                                            │
                                    ┌──────────────┬────────────────┬───────┴────────┐
                              start workflow   prompt orchestrator  workflow_signals  API/UI feed
```

Decisions (locked in during brainstorming):

- **Consumers:** all four — workflow triggers, orchestrator prompts,
  running-run signals, API/UI feed.
- **Linear setup:** Linear OAuth app; webhook created automatically via
  Linear's API on connect.
- **Filter model:** namespaced event key + structured declarative filters on
  catalog-declared fields.
- **Source contract:** plugin-level (`TriggerDef` evolution) — GitHub and
  Linear are the first two implementations; future sources plug in without
  touching core.
- **Delivery semantics:** persist first, return 204 fast, dispatch async with
  retries and per-delivery status.

## Plugin contract evolution

Extend `TriggerDef` (in `packages/engine/src/valet-plugin.ts`) rather than
adding a parallel interface:

```ts
interface TriggerDef {
  id: string;                    // "github.pull_request"
  service: string;
  description: string;
  verify(req: { headers: Record<string, string>; rawBody: Uint8Array },
         secrets: Record<string, string>): VerifiedEvent | null | Promise<VerifiedEvent | null>;
  toEvent(event: VerifiedEvent): NormalizedEvent;    // replaces toSignal
  catalog: EventCatalogEntry[];                      // subscribable keys + filter fields
}

interface NormalizedEvent {
  key: string;              // "github.pull_request.opened", "linear.issue.updated"
  dedupeKey: string;        // provider delivery id — unique per service
  occurredAt: string;
  actor?: { externalId: string; login?: string };   // enables identity_links attribution
  refs: Record<string, string>;   // scope refs: repo, installation_id, team_id, project_id
  summary: string;          // one-line human text (SignalContent body for orchestrator delivery)
  payload: unknown;         // raw provider payload
}

interface EventCatalogEntry {
  key: string;
  description: string;
  filters: { field: string; path: string; description: string }[];
  // e.g. field "repo" → path "repository.full_name"
}
```

`toSignal` was removed from the contract (it was never consumed by
`packages/api`): orchestrator delivery synthesizes `SignalContent` generically
from `key` + `summary` + `refs`. The catalog powers the subscription-builder
UI and filter validation.

## Data model

Three new tables plus a Linear installation mapping (Drizzle schema in
`packages/api/src/schema/`, migration in `packages/api/migrations/pg/`):

### `events` — durable log

| Column | Notes |
|---|---|
| `id` | pk |
| `org_id` | fk, indexed |
| `service` | `github`, `linear`, … |
| `event_key` | `github.pull_request.opened` |
| `dedupe_key` | unique per `(service, dedupe_key)` — idempotent redelivery |
| `actor` | jsonb |
| `refs` | jsonb |
| `summary` | text |
| `payload` | jsonb (raw provider payload) |
| `occurred_at`, `received_at` | timestamps |

A retention job (default 30 days) is a deferred follow-up; nothing prunes
`events` yet.

### `event_subscriptions`

| Column | Notes |
|---|---|
| `id` | pk |
| `org_id`, `owner_type`, `owner_id` | scoping |
| `name` | display name |
| `event_keys` | `text[]`; supports trailing-wildcard patterns (`github.pull_request.*`) |
| `filters` | jsonb: `{ field, op: eq\|in\|prefix\|contains, value }[]` over catalog fields |
| `target` | jsonb: `{ kind: "workflow" \| "orchestrator" \| "signal", ...ref }` |
| `enabled` | bool |
| `created_by`, timestamps | |

Workflow event-triggers are rows here too: saving a workflow definition with an
event trigger node creates/syncs a subscription row, so one matching engine
serves everything.

### `event_deliveries`

| Column | Notes |
|---|---|
| `id` | pk |
| `event_id`, `subscription_id` | fks |
| `status` | `pending` → `delivered` \| `failed` → `dead` |
| `attempts`, `next_attempt_at`, `last_error`, `delivered_at` | retry bookkeeping |

### `linear_installations`

`org_id, workspace_id, workspace_name, webhook_id, connected_by, timestamps` —
mirrors `github_installations`. The webhook signing secret is NOT a column
here: it lives in the org `linear` credential's `metadata.webhookSecret`,
the same way GitHub's `webhookSecret` lives in the `github_app` credential.

## Ingest

Public route `POST /webhooks/events/:service`, mounted pre-auth (like
`/webhooks/github-app`):

1. Read raw bytes, 1 MiB cap.
2. Resolve owning org before verification (secrets are per-org): Linear — peek
   `organizationId` from body → `linear_installations`; GitHub —
   `installation.id` → `github_installations`. Then run the plugin's
   `verify()` with that org's secret over the raw bytes.
3. `toEvent()` → insert into `events`. Duplicate `dedupe_key` → 204 no-op.
4. In the same transaction, match active subscriptions (indexed `org_id` +
   event-key match, filters evaluated in memory) and insert `event_deliveries`
   rows. Nudge the in-process dispatcher (`dispatcher.nudge()`); return 204.

Matching inside the ingest transaction means an accepted event either has its
delivery rows or doesn't exist — no persisted-but-never-matched window. Actual
delivery stays async.

**GitHub routing:** the existing `/webhooks/github-app` route keeps handling
`installation*` events (installations sync); all other event types it receives
are forwarded into the event pipeline. One GitHub webhook URL, two concerns.
Deferred follow-up: the App manifest must also declare `default_events`
(issues, pull_request, push, issue_comment, release, …) so installations
actually deliver them; existing installs need a one-time re-config note.
Until then, only the events GitHub already sends reach the pipeline.

## Dispatcher

In-process loop in the API server (matches how v2 runs background work),
implemented in `packages/api/src/events/dispatcher.ts`:

- 1s poll as a staleness floor; the ingest path nudges the dispatcher
  in-process (`nudge()`) so fresh deliveries dispatch immediately. The
  original sketch used `LISTEN/NOTIFY`, but the API is single-process — a
  direct in-process nudge is simpler and just as fast, and the poll sweeps
  retries and anything a crash left behind.
- Claim due deliveries with a single-statement CAS lease (the codebase's
  established row-claim pattern, cf. `pg-store.ts` `claimRun`), not
  `FOR UPDATE SKIP LOCKED` (a bare `FOR UPDATE` outside a transaction
  releases its locks at statement end): one atomic `UPDATE ... RETURNING`
  pushes `next_attempt_at` forward by a 60s lease, with the due conditions
  repeated on the OUTER `WHERE` as the cross-process fence — a raced
  loser's EvalPlanQual recheck sees the winner's bumped `next_attempt_at`
  and skips the row. A crash mid-delivery leaves the row pending; it
  becomes due again when the lease lapses.
- Per target kind:
  - **workflow** — `workflowRunHost.start()` with
    `WorkflowTriggerPayload { type: 'event', triggerId: subscription.id, data: normalizedEvent }`.
    Add `'event'` to the trigger union in `packages/workflow/src/dag/shape.ts`.
  - **orchestrator** — prompt the owner's orchestrator with `SignalContent`
    (`signalType: event.key`, `body`: summary + payload excerpt,
    `attributes`: refs) — same delivery path ChannelHost uses.
  - **signal** — insert into `workflow_signals` for runs waiting on
    `event:{key}` conditions.
- Retries: backoff 30s → 2m → 10m → 30m, then `dead`. `last_error` recorded;
  dead deliveries visible in the UI feed.

## Linear installation flow

New `linear-connect` routes (mirroring `github-connect` / `github-app`):

1. Admin OAuth authorize → callback stores an org-level `linear` credential
   (workspace access token) in `credentials`.
2. On callback, call Linear GraphQL `webhookCreate` (resource types: Issue,
   Comment, Project, Cycle, IssueLabel, Reaction) pointing at
   `{API_PUBLIC_URL}/webhooks/events/linear`; generate + store the signing
   secret; record `linear_installations`.
3. Verification: `Linear-Signature` header (HMAC-SHA256 over raw body) +
   `webhookTimestamp` replay check, implemented in `plugin-linear`'s new
   `triggers.ts` (`verify` + `toEvent` + catalog: `linear.issue.create`,
   `linear.issue.update`, `linear.comment.create`, `linear.project.update`, …
   — keys use Linear's own action verbs, `create`/`update`/`remove`).
4. Disconnect: `webhookDelete` via API; remove installation + credential rows.

## API surface

- `GET /api/events` — org event feed (filter by service/key/time);
  `GET /api/events/:id` includes its deliveries (debugging "why didn't my
  trigger fire").
- `GET /api/events/catalog` — merged catalog from loaded plugins; drives the
  subscription-builder UI.
- `POST/GET/PATCH/DELETE /api/event-subscriptions` — CRUD; validates event
  keys and filter fields against the catalog.
- Workflow editor: an "event" trigger node type whose save/update syncs an
  `event_subscriptions` row.

## Error handling

- Rejected/unverifiable webhooks → `event_drop_log` with reason
  (`bad_signature`, `unknown_org`, `oversized`), throttled logging (existing
  GitHub-route pattern).
- Delivery failures never lose events: the event row persists; the delivery
  row records attempts and last error and lands in `dead` after backoff is
  exhausted.

## Testing

- Unit: `verify()` with signed fixtures (pattern in `github-app.test.ts`),
  `toEvent()` normalization, filter-matching engine as a pure function.
- Route: ingest → event + delivery rows in one transaction; duplicate delivery
  id is a no-op; bad signature → drop log.
- Dispatcher: retry/backoff, `SKIP LOCKED` claiming, each target kind against
  fakes.
- E2e: create subscription → POST signed webhook → workflow run started with
  the event payload.

## Out of scope

Deferred follow-ups (designed above, not yet built): the `events` retention
job and the GitHub App manifest `default_events` declaration.

- SSE/WebSocket streaming of the event feed (poll the API for now).
- Sources beyond GitHub and Linear (the contract supports them; none built).
- Per-event user-level webhook config — installation-level only.
- Outbound webhooks (Valet emitting events to external URLs).
