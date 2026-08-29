# Channel reply routing, identity, and routing wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A channel-originated message an assistant answers returns to the same Slack thread; the assistant knows its team by name and who it is talking to; one wizard builds any routing rule with provider-populated, name-not-id filters.

**Architecture:** An optional `ChannelOrigin` (a Slack thread key) rides each submission and its persisted assistant entry. The dispatcher stamps it for channel-originated orchestrator deliveries and replaces the raw-JSON body with readable text. The outbound bridge posts the final turn to the origin thread as a safety net; a `reply_to_origin` action is the primary contract, with per-submission no-double-post. Filter fields declare a plugin-resolved `options` source served by one generic endpoint.

**Tech Stack:** TypeScript, `@valet/engine`, Hono (`packages/api`), React 19 + TanStack (`packages/web`), Drizzle + PGlite/node-postgres, Vitest.

**Spec:** `docs/specs/2026-08-28-channel-reply-routing-design.md`

## Global Constraints

- Base branch `dev-v2`. Build on `#441` (sender attribution: `formatSenderLine`, `submission.ts:103`) and `#443`/TKAI-247 (Slack event triggers, `filter-editor.tsx`, match-gated ingest).
- Type safety per CLAUDE.md: no `any`, no `as unknown as T`, no `@ts-expect-error`. Narrow instead.
- Pre-1.0 migrations edit `0000_app.sql` / engine raw SQL in place; app-table adds need a `SCHEMA_REPAIRS` entry (`lib/drizzle.ts`); `rm -rf ~/.valet/pg` after an engine/app DDL edit. Prefer `jsonb`-internal fields (no DDL) where the spec allows.
- Prose (action descriptions, wizard copy, errors) follows ASD-STE100; every user-facing error names the corrective action.
- Tool-call round-trip rule: any change to what the engine writes / the wire ships / REST reads / the frontend renders must be verified end to end.
- Validation: `pnpm typecheck`, targeted `pnpm --filter <pkg> test`, then a full `make e2e` scorecard before "done".
- Terminology: "start-ref"/`startRef`; "working directory" for the in-sandbox path; "workspace" only for the nav switcher scope.

## File structure

**Part 1 — replies + identity**
- `packages/engine/src/types.ts` — add `ChannelOrigin`; add `origin?` to `SignalContent` and to the persisted signal on `MessageEntry`.
- `packages/engine/src/submission.ts` — render `origin` into the signal envelope; helper to read a turn's origin from entries.
- `packages/engine/src/thread.ts` — thread `origin` from `submitPrompt` options onto the queue item and the persisted assistant entry.
- `packages/engine/src/valet-plugin.ts` — add `threadKeyFromEvent?` to the `ChannelTransport` contract.
- `packages/plugin-slack/src/transport/transport.ts` — implement `threadKeyFromEvent` (`slack:{channel}:{thread_ts ?? ts}`).
- `packages/api/src/events/dispatcher.ts` — stamp `origin`, set signal author from `event.actor`, replace the raw-JSON body.
- `packages/api/src/events/orchestrator-target.ts` — pass `origin` through `submitPrompt`.
- `packages/api/src/channels/host.ts` — auto-reply reads per-submission `origin` when the thread key does not map; drop-log a failed post.
- `packages/api/src/orchestrator/persona.ts` + `packages/api/src/engine/host.ts` — resolve team name, inject into the persona.
- `packages/plugin-slack/src/actions/actions.ts` — `reply_to_origin` action.
- No-double-post state: a per-submission flag the action sets and the bridge reads (engine turn context).

**Part 2 — provider-resolved filters + wizard**
- `packages/engine/src/valet-plugin.ts` — `EventCatalogEntry` filter field gains `options?: { source; dependsOn? }`; a `FilterOptionResolver` contract on the plugin.
- `packages/plugin-slack/src/*`, `packages/plugin-github/src/*`, `packages/plugin-linear/src/*` — register option resolvers.
- `packages/api/src/routes/events.ts` — `GET /api/events/filter-options`; per-org TTL cache.
- `packages/api/src/events/match.ts` — add the `regex` op; `slack.message`/`slack.app_mention` gain a `text` filter field (`triggers.ts`).
- `packages/api/src/wire/types.ts` — filter `label?`; the `regex` op in the union.
- `packages/web/src/components/events/filter-editor.tsx` — option-source pickers, `dependsOn` gating, free-text fallback.
- `packages/web/src/components/events/automation-wizard.tsx` (new) — When → Match → Then → Review; the old dialogs redirect to it.

---

## Part 1 — reliable replies and identity

### Task 1: `ChannelOrigin` on the signal and the persisted entry

**Files:**
- Modify: `packages/engine/src/types.ts` (`SignalContent` ~235; `MessageEntry.signal` ~414)
- Modify: `packages/engine/src/thread.ts` (submitPrompt → queue item → assistant entry)
- Test: `packages/engine/src/thread.test.ts` (or the existing signal round-trip suite)

**Interfaces:**
- Produces: `interface ChannelOrigin { channelType: string; threadKey: string }`; `SignalContent.origin?: ChannelOrigin`; `MessageEntry.signal.origin?: ChannelOrigin`.

- [ ] **Step 1 — failing test.** Submit a signal with `origin: { channelType: "slack", threadKey: "slack:C1:1.2" }` on a thread; read the persisted assistant entry back; assert `entry.signal?.origin` deep-equals the input. This exercises engine-write → store round-trip (CLAUDE.md hop 1).
- [ ] **Step 2 — run, expect FAIL** (`origin` not carried). `pnpm --filter @valet/engine test thread`.
- [ ] **Step 3 — implement.** Add `ChannelOrigin` and the two `origin?` fields to `types.ts`. In `thread.ts`, copy `content.origin` (for a `SignalContent`) onto the queue item and persist it on the assistant `MessageEntry.signal`. Follow the existing `tagName`/`senderSessionId` threading.
- [ ] **Step 4 — run, expect PASS.** Also run `pnpm --filter @valet/store-postgres test` (persisted signal shape).
- [ ] **Step 5 — commit** `feat(engine): carry channel origin on signals and entries`.

### Task 2: render origin in the signal envelope

**Files:**
- Modify: `packages/engine/src/submission.ts` (`renderSignalEnvelope` ~69)
- Test: `packages/engine/src/submission.test.ts`

**Interfaces:**
- Consumes: `SignalContent.origin` (Task 1).
- Produces: the envelope carries a human `origin` attribute (e.g. `origin="slack #C1"`); a pure `originFromEntries(entries, queueItemId): ChannelOrigin | undefined` reader.

- [ ] **Step 1 — failing test.** `renderSignalEnvelope({ tagName: "signal", signalType: "slack.app_mention", origin: {...} }, body)` includes an `origin=` attribute, XML-escaped, sorted with the others.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** When `signal.origin` is set, add `attrs.origin = "<channelType> <threadKey>"` before sorting (keys already validated). Add `originFromEntries` mirroring `resolveSubmissionText`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(engine): render channel origin in the signal envelope`.

### Task 3: Slack `threadKeyFromEvent`

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts` (`ChannelTransport`)
- Modify: `packages/plugin-slack/src/transport/transport.ts`
- Test: `packages/plugin-slack/src/transport/transport.test.ts`

**Interfaces:**
- Produces: `ChannelTransport.threadKeyFromEvent?(eventKey: string, payload: unknown): string | null`. Slack returns `slack:{channel}:{thread_ts ?? ts}` for `slack.message` / `slack.app_mention`; `null` for events with no conversation (`team_join`).

- [ ] **Step 1 — failing test.** For an `app_mention` payload `{ channel: "C1", ts: "1.2" }` → `"slack:C1:1.2"`; with `thread_ts: "0.9"` → `"slack:C1:0.9"`; for `team_join` → `null`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Add the optional method to the contract; implement on `SlackTransport`, reading `payload.channel` / `payload.item.channel` per event and `thread_ts ?? ts`. Reuse the existing key-format constant.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(slack): derive a thread key from an event payload`.

### Task 4: dispatcher stamps origin + readable body + author

**Files:**
- Modify: `packages/api/src/events/dispatcher.ts` (orchestrator branch ~163-176)
- Modify: `packages/api/src/events/orchestrator-target.ts` (pass `origin` to `submitPrompt`)
- Test: `packages/api/src/events/dispatcher.test.ts`

**Interfaces:**
- Consumes: `threadKeyFromEvent` (Task 3), `ChannelOrigin` (Task 1).
- Produces: an orchestrator `SignalContent` with `origin`, an author, and a body that is `summary` + message text — never `JSON.stringify(payload)`.

- [ ] **Step 1 — failing test.** Dispatch a `slack.app_mention` event to an orchestrator target; assert the delivered signal has `origin.threadKey === "slack:C1:1.2"`, `body` contains the message text and NOT a `{`/`}` JSON dump, and an author derived from `event.actor`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Resolve the transport for `event.service`; if it has `threadKeyFromEvent`, build `origin`. Set `signal.origin`, `signal.author` (from `event.actor`, resolving the external id to a name when a `user_identity_link` exists — reuse the channel host's resolver), and `body = renderEventBody(event)` (summary + `payload.text`, bounded). Thread `origin` through `deliverToOrchestrator` → `orchestrator-target` → `submitPrompt`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `fix(events): readable prompt + channel origin for assistant deliveries`.

### Task 5: auto-reply the final turn to origin

**Files:**
- Modify: `packages/api/src/channels/host.ts` (`deliverAssistantMessage` ~474; `handleOutboundEvent` ~419)
- Test: `packages/api/src/channels/host.test.ts`

**Interfaces:**
- Consumes: `originFromEntries` (Task 2), `channelThreadFor` / `conversationKeyFromThreadKey` (existing).
- Produces: an `end_turn` on a submission carrying `origin` posts to the origin conversation even when the thread key does not map.

- [ ] **Step 1 — failing test.** A `message_end` on the `"events"` thread whose finishing entry carries `origin` calls `transport.send(<conversationKey from origin.threadKey>, ...)`. Also assert a send failure writes an `event_drop_log` row, not a throw.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** In `deliverAssistantMessage`, after the existing `channelThreadFor(thread.key)`: if that is `null` (or the thread is `"events"`) but the finishing entry has `origin`, resolve `origin.threadKey → conversationKey` via the transport and post there. Keep the `end_turn`/`isStreamed` guards. Wrap the send; on failure `dropLog(orgId, "channel_reply_failed", conversationKey, err)`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(channels): auto-reply the final turn to its channel origin`.

### Task 6: `reply_to_origin` action + no-double-post

**Files:**
- Modify: `packages/plugin-slack/src/actions/actions.ts`
- Modify: `packages/api/src/channels/host.ts` (suppress auto-reply when the turn already replied to origin)
- Modify: `packages/api/src/orchestrator/persona.ts` (instruct the assistant)
- Test: `packages/plugin-slack/src/actions/actions.test.ts`, `packages/api/src/channels/host.test.ts`

**Interfaces:**
- Consumes: the current submission's `origin`.
- Produces: `reply_to_origin({ text })` posts to the submission origin with no channel argument, and marks the turn "replied to origin"; the bridge skips auto-reply when the mark is set.

- [ ] **Step 1 — failing test (action).** With an active submission carrying `origin`, `reply_to_origin({ text: "hi" })` calls `transport.send` on the origin conversation. Without an origin, it returns a corrective error ("No channel to reply to. This message did not come from a channel.").
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement action.** Read `origin` from the turn context; resolve to a conversationKey; post; set the turn's `repliedToOrigin` flag.
- [ ] **Step 4 — failing test (suppression).** A `message_end` whose turn set `repliedToOrigin` does NOT call the auto-reply `transport.send`.
- [ ] **Step 5 — implement suppression** in `deliverAssistantMessage`; add the persona line: "If a message came from a channel, reply with reply_to_origin."
- [ ] **Step 6 — run both, expect PASS.**
- [ ] **Step 7 — commit** `feat(slack): reply_to_origin action with no-double-post`.

### Task 7: team name in the persona

**Files:**
- Modify: `packages/api/src/orchestrator/persona.ts` (`orchestratorPersona` ~153; team body ~127)
- Modify: `packages/api/src/engine/host.ts` (`buildAssistantSession` ~1368-1472)
- Test: `packages/api/src/orchestrator/persona.test.ts`, an `engine/host` test

**Interfaces:**
- Produces: `orchestratorPersona(owner: Principal, displayName?: string)`; the team body names the team; no path emits `team_<uuid>` into model-visible text.

- [ ] **Step 1 — failing test.** `orchestratorPersona({ type: "team", id: "team_x" }, "Platform")` contains "Platform" and NOT "team_x".
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Add the optional `displayName`; when present in the team/org body, name it ("You are the shared assistant for the **{name}** team"). In `buildAssistantSession`, when `principal.type === "team"`, `select name from teams where id = principal.id` and pass it. Fallback to a neutral phrase (never the raw id) when absent.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `fix(orchestrator): name the team in the shared-assistant persona`.

### Task 8: Part 1 end-to-end + validation gate

- [ ] Add an api integration test: a `slack.app_mention` webhook → subscription → assistant turn → exactly one Slack post on `slack:C1:1.2`, body readable, persona names the team.
- [ ] `pnpm typecheck`; the CLAUDE.md round-trip suites (`engine happy-path`, `engine in-memory-store`, `store-postgres`, api integration).
- [ ] Full `make e2e 2>&1 | tee /tmp/e2e-part1.log`; clean scorecard (name any pre-existing red row).
- [ ] **Checkpoint:** open the PR onto `dev-v2` for Part 1, or continue to Part 2 in-branch (operator's call at execution time).

---

## Part 2 — provider-resolved filters and the wizard

### Task 9: `regex` op + `text` filter field

**Files:**
- Modify: `packages/api/src/events/match.ts` (`SubscriptionFilter` op union ~37; `filtersMatch` switch ~54)
- Modify: `packages/api/src/wire/types.ts` (`EventSubscriptionFilterWire.op`)
- Modify: `packages/plugin-slack/src/triggers.ts` (`slack.message` / `slack.app_mention` gain `{ field: "text", path: "text" }`)
- Test: `packages/api/src/events/match.test.ts`, `packages/plugin-slack/src/triggers.test.ts`

**Interfaces:**
- Produces: op `"regex"`; a bad pattern fails the filter closed (no throw); a `text` field on the two message events.

- [ ] **Step 1 — failing test.** `filtersMatch` with `{ field:"text", op:"regex", value:"^/deploy" }` matches `"/deploy now"`, rejects `"hello"`, and returns `false` (not throw) for `value:"("`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Add `"regex"` to the op unions; in the switch, `try { new RegExp(value).test(actual) } catch { return false }`. Add the `text` catalog field.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(events): regex filter op and a text field on slack messages`.

### Task 10: filter `label` passthrough

**Files:**
- Modify: `packages/api/src/wire/types.ts` (`EventSubscriptionFilterWire.label?`)
- Modify: `packages/api/src/routes/events.ts` (subscription validator preserves `label`)
- Test: `packages/api/src/routes/events.test.ts`

**Interfaces:**
- Produces: a filter may carry `label?: string`; it round-trips create→read; matching ignores it.

- [ ] **Step 1 — failing test.** POST a subscription with a filter `{ field:"user", op:"eq", value:"U1", label:"Alice" }`; GET it back; `label === "Alice"`; a match against payload `user:"U1"` still succeeds.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Add `label?` to the wire type; the validator copies it through unchanged; `filtersMatch` already ignores unknown fields.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(events): carry a display label on a subscription filter`.

### Task 11: option-source contract + resolvers

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts` (`EventCatalogEntry` filter `options?: { source: string; dependsOn?: string[] }`; a `FilterOptionResolver` map on the plugin)
- Modify: `packages/plugin-slack/src/plugin.ts` (`slack.users`, `slack.channels`)
- Modify: `packages/plugin-github/src/plugin.ts` (`github.repos`, `github.branches` with `dependsOn: ["repo"]`)
- Modify: `packages/plugin-linear/src/plugin.ts` (`linear.teams`)
- Test: each plugin's test

**Interfaces:**
- Produces: `type FilterOption = { id: string; label: string; hint?: string }`; `type FilterOptionResolver = (ctx: { orgId; q?; deps: Record<string,string>; creds }) => Promise<FilterOption[]>`; plugins export `filterOptionResolvers: Record<string, FilterOptionResolver>`.

- [ ] **Step 1 — failing test (slack).** `slack.users` resolver maps a stubbed `users.list` response to `[{ id:"U1", label:"Alice" }]`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the contract types + each resolver, calling the provider API already used elsewhere (`SlackApi`, the GitHub installation client, the Linear client). Declare `options` on the matching catalog fields (`user`→`slack.users`, `channel`→`slack.channels`, GitHub `repo`/`branch`, Linear `team`).
- [ ] **Step 4 — run, expect PASS** (repeat a resolver test per plugin).
- [ ] **Step 5 — commit** `feat(plugins): provider filter-option resolvers`.

### Task 12: `GET /api/events/filter-options`

**Files:**
- Modify: `packages/api/src/routes/events.ts`
- Modify: `packages/api/src/wire/types.ts` (`FilterOptionsResponse`)
- Test: `packages/api/src/routes/events.test.ts`

**Interfaces:**
- Consumes: `filterOptionResolvers` (Task 11).
- Produces: `GET /api/events/filter-options?source=&q=&<dep>=` → `{ options: FilterOption[] }`; per-org TTL cache; unknown/uncredentialed source → `{ options: [], reason }`.

- [ ] **Step 1 — failing test.** `GET /api/events/filter-options?source=slack.users&q=al` returns Alice; `source=github.branches&repo=acme/app` passes `repo` as a dep; an unknown source → `{ options: [], reason }` (200, not 500).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Look up the resolver by `source` across registered plugins; pass `q` and the declared `dependsOn` params from the query; wrap in a per-`(org, source, deps, q)` TTL cache; resolve org creds; catch provider errors into a `reason`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(events): generic filter-options endpoint`.

### Task 13: option-source pickers in the filter editor

**Files:**
- Modify: `packages/web/src/components/events/filter-editor.tsx`
- Modify: `packages/web/src/api/events.ts` (a `useFilterOptions` query)
- Test: `packages/web/src/components/events/filter-editor.test.tsx`

**Interfaces:**
- Consumes: `GET /api/events/filter-options`, the catalog `options` descriptor.
- Produces: an entity field renders a searchable picker that stores `{ value: id, label }`; a `dependsOn` field disables until its parent has a value; no source → free text.

- [ ] **Step 1 — failing test.** For a field with `options.source = "slack.users"`, typing queries the endpoint and selecting Alice sets `value:"U1"`, `label:"Alice"`; a `github.branches` field is disabled until `repo` is set; a field with no `options` still renders the text input.
- [ ] **Step 2 — run, expect FAIL.** `pnpm --filter @valet/web test filter-editor`.
- [ ] **Step 3 — implement.** Branch the value cell on the field's `options`; debounce the query; store id+label; gate on `dependsOn`; keep the existing free-text path.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(web): provider-populated filter pickers, no raw ids`.

### Task 14: unified automation wizard

**Files:**
- Create: `packages/web/src/components/events/automation-wizard.tsx`
- Modify: `packages/web/src/components/events/subscription-create-dialog.tsx`, `packages/web/src/components/workflows/trigger-dialog.tsx` (redirect to the wizard)
- Modify: `packages/web/src/routes/events.index.tsx` (entry point)
- Test: `packages/web/src/components/events/automation-wizard.test.tsx`

**Interfaces:**
- Consumes: the filter editor (Task 13), the subscription + schedule create APIs.
- Produces: a When → Match → Then → Review flow that writes an event subscription or a schedule and shows a plain-language summary.

- [ ] **Step 1 — failing test.** Selecting "event", picking `slack.app_mention`, adding a user filter, and choosing "the Platform team's assistant" POSTs an `event_subscriptions` create with the right `eventKeys`/`filters`/`target`; selecting "schedule" with a cron POSTs a schedule; the review step renders a name-based summary (no raw ids).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the four steps, reusing the existing create mutations per branch; redirect the two old dialogs to open the wizard.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(web): unified automation wizard; retire the split dialogs`.

### Task 15: Part 2 validation gate

- [ ] `pnpm typecheck`; `pnpm --filter @valet/web test`; `pnpm --filter @valet/api test`.
- [ ] `make e2e E2E_ARGS="--only web-build,docs-lint"` after wire-type/prose changes, then full `make e2e 2>&1 | tee /tmp/e2e-part2.log`; clean scorecard.
- [ ] Update `docs/specs/2026-08-28-channel-reply-routing-design.md` status to implemented; note any deviations.

---

## Self-review

- **Spec coverage:** 1.1 Task 1; 1.2 Tasks 2,4; 1.3 Tasks 3-5 (covered by origin routing, no separate port); 1.4 Tasks 5,6; 1.5 Task 7; 2.1 Tasks 11,12; 2.2 Tasks 10,13; 2.3 Task 9; 2.4 Task 14. Invariants (drop-log on failed reply) Task 5. Testing gates Tasks 8,15.
- **Placeholder scan:** each code step names the file, the seam, and the assertion; no "handle edge cases".
- **Type consistency:** `ChannelOrigin { channelType, threadKey }`, `SignalContent.origin`, `threadKeyFromEvent`, `FilterOption { id, label, hint? }`, `FilterOptionResolver`, filter `label?`, op `"regex"` used consistently across tasks.
