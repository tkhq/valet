# Slack thread auto-follow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The assistant keeps up with a Slack thread it is engaged in without a re-mention, decides for itself whether each new message deserves a reply or an emoji, and is configured through an outcome-first automation form.

**Architecture:** A message's reply mode rides on `ChannelOrigin` (`reply: "auto" | "manual"`). Addressed messages auto-reply; overheard follow-thread messages are observed and answered only via a `reply_to_origin` / `react_to_origin` action. A `followed_threads` table binds a Slack thread to an assistant; a webhook consumer routes threaded messages on followed threads to that assistant's per-thread valet thread.

**Tech Stack:** TypeScript, `@valet/engine`, Hono (`packages/api`), Drizzle + PGlite/node-postgres, `packages/plugin-slack`, React (`packages/web`), Vitest.

**Spec:** `docs/specs/2026-08-28-slack-thread-autofollow-design.md`

## Global Constraints

- Base branch `fix/channel-thread-binding` (needs its per-thread binding: a channel signal lands on `session.thread(slack:{channel}:{threadTs})`).
- Type safety: no `any`, no `as unknown as T`, no `@ts-expect-error`; narrow instead.
- Pre-1.0 migrations: edit `packages/api/migrations/pg/0000_app.sql` in place + update the Drizzle schema (`packages/api/src/schema/index.ts`) + add a `SCHEMA_REPAIRS` entry (`packages/api/src/lib/drizzle.ts`); `rm -rf ~/.valet/pg` after. `follow` and `reply`/`messageTs` live in existing `jsonb` (no DDL for those).
- Every user-facing error names the corrective action. STE prose for comments/copy.
- Validation: `pnpm typecheck`, targeted `pnpm --filter <pkg> test`, full `make e2e` before done.

## File structure

- `packages/engine/src/types.ts` — `ChannelOrigin` gains `reply?: "auto" | "manual"` and `messageTs?: string`; add `origin?` to `ToolContext`.
- `packages/engine/src/thread.ts` — thread `origin` onto `ToolContext` at turn build.
- `packages/api/src/channels/host.ts` — `deliverAssistantMessage` skips the auto-post when the finishing turn's origin `reply === "manual"`.
- `packages/plugin-slack/src/actions/actions.ts` — `reply_to_origin`, `react_to_origin` actions.
- `packages/api/migrations/pg/0000_app.sql`, `schema/index.ts`, `lib/drizzle.ts` — `followed_threads` table.
- `packages/api/src/events/followed-threads.ts` (new) — write + lookup helpers.
- `packages/api/src/events/dispatcher.ts` / `orchestrator-target.ts` — write a follow record for a follow-enabled channel mention; thread `follow` off the target.
- `packages/api/src/channels/follow-router.ts` (new) — the webhook consumer for a threaded message on a followed thread.
- `packages/api/src/routes/slack-webhook.ts` — wire the follow-router into the fan-out.
- `packages/api/src/orchestrator/persona.ts` — overheard guidance.
- `packages/web/src/components/events/automation-wizard.tsx` — outcome-first step 1.

---

### Task 1: reply mode + messageTs on the origin; suppress auto-post for manual

**Files:**
- Modify: `packages/engine/src/types.ts` (`ChannelOrigin`)
- Modify: `packages/api/src/channels/host.ts` (`deliverAssistantMessage`)
- Test: `packages/engine/test/submission.test.ts`, `packages/api/src/channels/host.test.ts`

**Interfaces:**
- Produces: `ChannelOrigin { channelType; threadKey; reply?: "auto" | "manual"; messageTs?: string }`. `deliverAssistantMessage` posts only when the turn's origin `reply !== "manual"`.

- [ ] **Step 1 — failing test (engine).** `renderSignalEnvelope`/round-trip: a signal with `origin.reply = "manual"` persists and reads back. (Extend the existing origin round-trip.)
- [ ] **Step 2 — failing test (host).** A `message_end` whose finishing turn's origin has `reply: "manual"` does NOT call `transport.send`. Reuse the existing origin host test harness (KeyedTransport, submit a signal with `origin.reply = "manual"`).
- [ ] **Step 3 — run, expect FAIL.**
- [ ] **Step 4 — implement.** Add `reply?` and `messageTs?` to `ChannelOrigin`. In `deliverAssistantMessage`, after resolving `entry` + origin: `const origin = entry.queueItemId ? originFromEntries(entries, entry.queueItemId) : undefined; if (origin?.reply === "manual") return;` before the send block (but after `markDelivered` is fine either way — choose before send so nothing posts).
- [ ] **Step 5 — run, expect PASS.**
- [ ] **Step 6 — commit** `feat(engine): reply mode and message ts on channel origin`.

### Task 2: reply_to_origin + react_to_origin actions

**Files:**
- Modify: `packages/engine/src/types.ts` (`ToolContext.origin?: ChannelOrigin`)
- Modify: `packages/engine/src/thread.ts` (populate `ToolContext.origin` from the running submission's signal origin at `buildToolContext`)
- Modify: `packages/plugin-slack/src/actions/actions.ts`
- Test: `packages/plugin-slack/src/actions/actions.test.ts`, an engine tool-context test

**Interfaces:**
- Consumes: `ToolContext.origin` (channelType/threadKey/messageTs).
- Produces: actions `slack.reply_to_origin({ text })`, `slack.react_to_origin({ emoji })`.

- [ ] **Step 1 — failing test.** With `ctx.origin = { channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.5" }`, `reply_to_origin({ text: "hi" })` posts `hi` to the thread (`chat.postMessage` with the rebuilt conversationKey/thread_ts); `react_to_origin({ emoji: "eyes" })` calls `reactions.add` on channel `C1`, ts `1.5`. Without an origin, each returns a corrective error ("This message did not come from a channel, so there is nothing to reply to.").
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Add `origin?` to `ToolContext`; in `thread.ts` set it from the running signal's `origin` when building the tool context. Add the two actions: parse `channelId`/`threadTs` from `origin.threadKey`; `reply_to_origin` uses the Slack API `chat.postMessage`; `react_to_origin` uses `reactions.add` on `origin.messageTs`. Reuse `ctx.credentials.get()` like the sibling actions.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(slack): reply_to_origin and react_to_origin actions`.

### Task 3: followed_threads table + write helpers

**Files:**
- Modify: `packages/api/migrations/pg/0000_app.sql`, `packages/api/src/schema/index.ts`, `packages/api/src/lib/drizzle.ts` (SCHEMA_REPAIRS)
- Create: `packages/api/src/events/followed-threads.ts`
- Test: `packages/api/src/events/followed-threads.test.ts`

**Interfaces:**
- Produces: `upsertFollowedThread(db, row)`, `findFollowedThread(db, { orgId, channelType, channelId, threadTs })`, `touchFollowedThread(db, id)`. Row: `{ orgId, channelType, channelId, threadTs, ownerType, ownerId, createdBy }`.

- [ ] **Step 1 — DDL.** Add the `followed_threads` table (columns per spec) to `0000_app.sql`, the Drizzle table to `schema/index.ts`, and a `SCHEMA_REPAIRS` entry adding the table/columns. `rm -rf ~/.valet/pg`.
- [ ] **Step 2 — failing test.** `upsertFollowedThread` then `findFollowedThread` returns the row; a second upsert on the same `(org, channel, thread)` updates, not duplicates (unique constraint). `touchFollowedThread` bumps `last_activity_at`.
- [ ] **Step 3 — run, expect FAIL.**
- [ ] **Step 4 — implement** the three helpers with Drizzle (`onConflictDoUpdate` on the unique index).
- [ ] **Step 5 — run, expect PASS** (also `pnpm --filter @valet/store-postgres test` if the row shape touches engine tables — it does not; this is an app table).
- [ ] **Step 6 — commit** `feat(events): followed_threads table and helpers`.

### Task 4: follow flag on the rule + dispatcher writes the follow record

**Files:**
- Modify: `packages/api/src/wire/types.ts` (`EventSubscriptionTargetWire` orchestrator variant gains `follow?: boolean`)
- Modify: `packages/api/src/routes/events.ts` (validator passes `follow` through)
- Modify: `packages/api/src/events/dispatcher.ts` (on a follow-enabled orchestrator delivery with a channel origin, upsert the follow record)
- Test: `packages/api/src/events/dispatcher.test.ts`, `packages/api/src/routes/events.test.ts`

**Interfaces:**
- Consumes: `upsertFollowedThread` (Task 3), `ChannelOrigin` (Task 1), the origin resolver (existing).
- Produces: a follow-enabled `slack.app_mention` delivery writes a `followed_threads` row bound to the subscription owner; a non-follow rule writes none.

- [ ] **Step 1 — failing test.** Dispatch a `slack.app_mention` event to an orchestrator target with `target.follow = true`; assert a `followed_threads` row exists for `(channel, thread_ts)` bound to the owner. With `follow` unset, assert none.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Add `follow?` to the orchestrator target wire + validator passthrough (it lives in the `target` jsonb; no DDL). In the dispatcher's orchestrator branch: when `target.follow` and an origin was resolved, `upsertFollowedThread(db, { orgId, channelType: origin.channelType, channelId, threadTs, ownerType: sub.ownerType, ownerId: sub.ownerId, createdBy: sub.createdBy })` (parse channelId/threadTs from `origin.threadKey`).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(events): record a followed thread for a follow-enabled mention`.

### Task 5: the follow-router consumer + overheard delivery

**Files:**
- Create: `packages/api/src/channels/follow-router.ts`
- Modify: `packages/api/src/routes/slack-webhook.ts` (fan-out adds the follow consumer)
- Modify: `packages/api/src/orchestrator/persona.ts` (overheard guidance)
- Test: `packages/api/src/channels/follow-router.test.ts`

**Interfaces:**
- Consumes: `findFollowedThread`/`touchFollowedThread` (Task 3), `ensureDefaultAssistantSession`, `threadKeyFromEvent`/origin building.
- Produces: `handleFollowedMessage(deps, { orgId, event })` — a threaded channel message on a followed thread delivers an overheard signal to the bound assistant's `slack:{channel}:{threadTs}` thread.

- [ ] **Step 1 — failing test.** A `message` event with `thread_ts` matching a followed thread submits a signal to the bound owner's assistant on thread `slack:{channel}:{thread_ts}` with `origin.reply === "manual"` and `origin.messageTs` set; an unfollowed thread submits nothing; a `bot_id`-carrying message is dropped.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** `handleFollowedMessage`: drop bot posts; require `thread_ts`; `findFollowedThread`; on hit, `ensureDefaultAssistantSession(owner)` + `session.thread(slack:{channel}:{thread_ts}).submitPrompt(signal)` where the signal body is the message text, `origin = { channelType, threadKey, reply: "manual", messageTs: ts }`, sender from the event actor; `touchFollowedThread`. Dedup by the Slack `event_id`. Wire into `slack-webhook.ts` fan-out beside the channel + event consumers. Append the overheard persona block when a turn's origin is `manual` (via the signal envelope / a role note).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(channels): follow-router delivers overheard thread messages`.

### Task 6: outcome-first wizard

**Files:**
- Modify: `packages/web/src/components/events/automation-wizard.tsx`
- Test: `packages/web/src/components/events/automation-wizard.test.tsx`

**Interfaces:**
- Produces: a step-1 outcome selector; "Reply to Slack mentions" writes a `slack.app_mention` subscription with `target.follow` from a toggle.

- [ ] **Step 1 — failing test.** Selecting "Reply to Slack mentions", a channel, an assistant target, and the "Keep following the thread" toggle POSTs an `event_subscriptions` create with `eventKeys: ["slack.app_mention"]`, the channel filter, and `target: { kind: "orchestrator", orchestrator: …, follow: true }`. The "Advanced / custom trigger" outcome shows the existing event picker.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Add the outcome selector as step 1; "Reply to Slack mentions" gathers channel + assistant + follow toggle and maps to the subscription create; "Advanced" renders the current event/filter step; "Run a workflow"/"Send a notification" map to the existing targets. Reuse the channel picker (`slack.channels` filter-options) for the channel choice.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(web): outcome-first automation wizard with Reply to mentions`.

### Task 7: validation gate

- [ ] `pnpm typecheck`; targeted suites: engine (submission/thread), plugin-slack (actions), api (events/dispatcher/routes, channels/host, follow-router), web (automation-wizard).
- [ ] Integration: a follow-enabled `app_mention` → follow record → a plain thread reply → overheard delivery → the bot replies via `reply_to_origin` (one Slack post) or stays silent (no post).
- [ ] Full `make e2e`; clean scorecard (name any pre-existing red). Update the spec status to implemented.

## Self-review

- **Spec coverage:** §1 reply modes → Tasks 1,5; §2 follow record → Tasks 3,4; §3 follow-enabled rules → Task 4; §4 follow-router → Task 5; §5 actions → Task 2; §6 persona → Task 5; §7 wizard → Task 6. Invariants (drop-log, no TTL) Task 5. Testing Task 7.
- **Placeholder scan:** each step names files, seams, and assertions.
- **Type consistency:** `ChannelOrigin.reply`/`messageTs`, `ToolContext.origin`, `upsertFollowedThread`/`findFollowedThread`/`touchFollowedThread`, `target.follow`, `handleFollowedMessage` used consistently across tasks.
