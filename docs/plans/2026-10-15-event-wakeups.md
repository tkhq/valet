# Event Wakeups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `wait_for_event`: an agent-armed, deadline-bounded wakeup that fires on a normalized GitHub, Slack, or Linear event, stacked on PR #863.

**Architecture:** Plugins add `subjects`, `status`, `previousStatus`, and `actor.bot` to every `NormalizedEvent`. An event waiter is a `wakeups` row with `kind: "event"`, indexed by subject. `ingestEvent` appends match digests to waiter rows. The WakeWatcher derives, delivers, and ends them with the existing signal machinery.

**Tech Stack:** TypeScript, Hono api, `@valet/engine`, PGlite/Postgres (`store-postgres`), typebox tool schemas, vitest, React 19 web.

**Spec:** `docs/specs/2026-10-15-event-wakeups-design.md`. Read it before any task. It is the source of truth. If code and spec disagree, change the spec in the same commit (spec errata), never silently.

## Global Constraints

- Branch `feat/event-wakeups`, worktree `.claude/worktrees/event-wakeups`, base `feat/sandbox-scratch-wakeups` (PR #863). PR targets `feat/sandbox-scratch-wakeups`.
- Follow `CLAUDE.md`: no `any`, no `as unknown as T`, no `@ts-ignore`; ASD-STE100 prose for comments, UI copy, and errors; every refusal names its fix.
- Migrations: edit `packages/store-postgres/migrations/pg/0000_engine.sql` in place AND add `SCHEMA_REPAIRS` entries in `packages/api/src/lib/drizzle.ts`. Do NOT change `ENGINE_SCHEMA_VERSION`. Run `make dev-clean` after editing.
- Each commit: subject ≤72 chars, conventional type, body `Changelog: none` for `feat`/`fix`. Run `node scripts/ci/changelog_commit_guard.mjs --base $(git rev-parse origin/dev-v2) --head HEAD` before pushing.
- Tests: `pnpm --filter @valet/<pkg> test <filter>` with NO `--`. Web test files need `make e2e E2E_ARGS="--only web-build"` because `tsc --build` skips them.
- Limits copied from the spec: clauses 1 to 8; `reason` 1 to 200 characters; `max_hours` 1 to `timerMaxHours`; digest `text` ≤ 4096 bytes; stream mode uses `watchMinIntervalMs` and `watchMaxEventsPerHour`.
- Signal types: `event.matched`, `event.ended`. Dispatch ids: `wakeup:<id>:event:<n>`, `wakeup:<id>:terminal`.

## Review Focus

1. **A provider redelivers the same webhook** (GitHub and Slack both retry). Expect one signal. Test: Task 8 redelivery case.
2. **The waiter's session is deleted or moved while an event arrives.** Expect no delivery and no error in ingest. Test: Task 8 "session gone" case.
3. **A burst of 50 matching events in one second in stream mode.** Expect one signal listing all 50, then rate behavior. Test: Task 10 burst case.
4. **A derive call fails (GitHub 5xx or token error).** Expect the digest kept for the next tick, `valet_event_waiter_derive_total{result="error"}` incremented, and no signal. Test: Task 9 error case.
5. **The agent arms a wait on a Slack thread it is already following.** Expect refusal R6, no row. Test: Task 11 R6 case.

---

### Task 1: Engine event contract fields

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts:107-160` (NormalizedEvent, TriggerDef), `:575-625` (ValetPlugin), `:656` (validateValetPlugin)
- Test: `packages/engine/test/valet-plugin.test.ts` (create if absent)

**Interfaces:**
- Produces:
  ```ts
  export interface NormalizedEvent {
    /* existing fields */
    subjects?: string[];
    status?: string;
    previousStatus?: string;
    actor?: { externalId: string; login?: string; bot?: boolean };
  }
  export interface DeriveContext {
    orgId: string;
    /** Org app credential for the plugin's service. Null when not connected. */
    appToken(): Promise<string | null>;
    fetch: typeof fetch;
  }
  export interface DerivedEventDef {
    key: string;
    description: string;
    sources: string[];
    derive(ctx: DeriveContext, subject: string, source: NormalizedEvent): Promise<NormalizedEvent | null>;
  }
  export interface EventSubjects {
    fromUrl(url: string): { subject: string; slackChannel?: string } | null;
    label(subject: string): string;
    url(subject: string): string | null;
  }
  export interface StatusResolver {
    /** Maps a provider state reference to a normalized status. */
    resolve(ctx: DeriveContext, ref: { teamKey?: string; stateId: string }): Promise<string | null>;
  }
  export interface ValetPlugin {
    /* existing fields */
    eventSubjects?: EventSubjects;
    derivedEvents?: DerivedEventDef[];
    statusResolver?: StatusResolver;
  }
  ```
- `subjectService(subject: string): string` (returns the prefix before `:`), exported from `packages/engine/src/events/subjects.ts`.

- [ ] **Step 1:** Write a failing test: `validateValetPlugin` accepts a plugin with `eventSubjects`, `derivedEvents`, `statusResolver`, and rejects `derivedEvents: [{ key: "", ... }]` with a message naming `derivedEvents[0].key`. Test `subjectService("github:acme/x#1") === "github"`.
- [ ] **Step 2:** Run `pnpm --filter @valet/engine test valet-plugin`. Expect FAIL.
- [ ] **Step 3:** Add the types above. Add the validation branch in `validateValetPlugin` that checks `derivedEvents[i].key` is non-empty and `sources` is a non-empty array. Create `packages/engine/src/events/subjects.ts` with `subjectService` and re-export from the engine barrel (the barrel MUST stay browser-safe: no node imports).
- [ ] **Step 4:** Run the test and `pnpm typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `feat(engine): add event subjects and derived event contracts`.

### Task 2: Event waiter kind and store contract (engine)

**Files:**
- Modify: `packages/engine/src/wakeups/types.ts:9-60` (kinds, Wakeup, WakeupPatch, WakeupCreateInput, WakeupsSeam), `packages/engine/src/types.ts:2246-2304` (SessionStore), `packages/engine/src/providers/in-memory/store.ts:298-410`
- Modify: `packages/engine/src/test-helpers/store-contract.ts:702+` (new cases)
- Test: `packages/engine/test/in-memory-store.test.ts` (runs the contract)

**Interfaces:**
- Produces:
  ```ts
  export type WakeupKind = "process" | "watch" | "timer" | "event";
  export interface EventClause {
    key: string; status?: string[]; from_status?: string[];
    actor?: string; bots?: boolean; include_self?: boolean;
  }
  export interface EventMatchSpec { clauses: EventClause[]; once: boolean; self: string[] }
  export interface EventMatchDigest {
    key: string; status?: string; previousStatus?: string; subjects: string[];
    summary: string; url?: string; actor?: string; occurredAt: string;
    dedupeKey: string; text?: string; derive?: string;
  }
  // Wakeup gains:
  subjects?: string[]; eventMatch?: EventMatchSpec; eventBuffer?: EventMatchDigest[];
  // WakeupPatch gains "eventBuffer".
  // WakeupCreateInput gains:
  | { kind: "event"; subjects: string[]; match: EventMatchSpec; reason: string; maxHours: number }
  // SessionStore gains:
  findEventWaiters(subjects: readonly string[]): Promise<Wakeup[]>;
  appendEventMatch(id: string, digest: EventMatchDigest, updatedAt: number): Promise<boolean>;
  export const EVENT_DIGEST_TEXT_MAX_BYTES = 4096;
  ```
- `listDueWakeups` MUST also return running `event` rows whose `eventBuffer` is non-empty, and running `event` rows whose `deadlineAt <= now`.

- [ ] **Step 1: Write the failing contract tests** in `store-contract.ts` under `describe("wakeups and leases")`:
  ```ts
  const eventWaiter = (over: Partial<Wakeup> = {}): Wakeup => wakeup({
    id: "wk_ev", kind: "event", status: "running", reason: "CI on #42",
    subjects: ["github:acme/lean-proofs#42"], deadlineAt: 10_000,
    eventMatch: { clauses: [{ key: "github.check_run.completed" }], once: true, self: [] },
    eventBuffer: [], ...over,
  });
  const digest = (over: Partial<EventMatchDigest> = {}): EventMatchDigest => ({
    key: "github.check_run.completed", subjects: ["github:acme/lean-proofs#42"],
    summary: "acme/lean-proofs: check_run completed", occurredAt: "2026-10-15T00:00:00Z",
    dedupeKey: "d-1", ...over,
  });
  it("findEventWaiters returns running event rows that share a subject", async () => {
    await store.createWakeup(eventWaiter());
    await store.createWakeup(eventWaiter({ id: "wk_other", subjects: ["github:acme/other#1"] }));
    await store.createWakeup(eventWaiter({ id: "wk_done", status: "done" }));
    const rows = await store.findEventWaiters(["github:acme/lean-proofs", "github:acme/lean-proofs#42"]);
    expect(rows.map((r) => r.id)).toEqual(["wk_ev"]);
  });
  it("appendEventMatch appends once per dedupeKey and only while running", async () => {
    await store.createWakeup(eventWaiter());
    expect(await store.appendEventMatch("wk_ev", digest(), 20)).toBe(true);
    expect(await store.appendEventMatch("wk_ev", digest(), 21)).toBe(false);
    await store.transitionWakeup("wk_ev", ["running"], "cancelled", { cause: "cancelled", endedAt: 22 }, 22);
    expect(await store.appendEventMatch("wk_ev", digest({ dedupeKey: "d-2" }), 23)).toBe(false);
    expect((await store.getWakeup("wk_ev"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["d-1"]);
  });
  it("appendEventMatch cuts text to 4096 bytes", async () => {
    await store.createWakeup(eventWaiter());
    await store.appendEventMatch("wk_ev", digest({ text: "é".repeat(5000) }), 20);
    const text = (await store.getWakeup("wk_ev"))?.eventBuffer?.[0]?.text ?? "";
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
  });
  it("listDueWakeups returns event rows with a buffer or a passed deadline", async () => {
    await store.createWakeup(eventWaiter({ id: "wk_idle" }));
    await store.createWakeup(eventWaiter({ id: "wk_buf", eventBuffer: [digest()] }));
    await store.createWakeup(eventWaiter({ id: "wk_late", deadlineAt: 5 }));
    const { rows } = await store.listDueWakeups(100, 50);
    expect(rows.map((r) => r.id).sort()).toEqual(["wk_buf", "wk_late"]);
  });
  it("transitionWakeup clears eventBuffer when the patch sets []", async () => {
    await store.createWakeup(eventWaiter({ eventBuffer: [digest()] }));
    const row = await store.transitionWakeup("wk_ev", ["running"], "running", { eventBuffer: [] }, 30);
    expect(row?.eventBuffer).toEqual([]);
  });
  ```
  Byte cutting MUST keep whole UTF-8 code points (use the existing `sliceUtf8`-style helper if the engine has one; otherwise add `cutUtf8(text, max)` in `packages/engine/src/wakeups/digest.ts` and test it).
- [ ] **Step 2:** Run `pnpm --filter @valet/engine test in-memory-store`. Expect FAIL.
- [ ] **Step 3:** Add the types. Implement both methods in the in-memory store. Extend the in-memory `listDueWakeups` filter (`store.ts:358-359`) with the event rule.
- [ ] **Step 4:** Run the test. Expect PASS. Run `pnpm typecheck` (store-postgres will fail until Task 3; that is expected and Task 3 is next).
- [ ] **Step 5:** Commit `feat(engine): add the event wakeup kind and store contract`.

### Task 3: Postgres store for event waiters

**Files:**
- Modify: `packages/store-postgres/migrations/pg/0000_engine.sql:226-256`
- Modify: `packages/store-postgres/src/helpers.ts:722-830` (WakeupRow, rawToWakeupRow, isWakeupKind, rowToWakeup)
- Modify: `packages/store-postgres/src/store.ts:1431-1750` (insertWakeup, TRANSITION_SQL, transitionParams, listDueWakeups, WAKEUP_KINDS, new methods)
- Modify: `packages/api/src/lib/drizzle.ts:1748-1800` (SCHEMA_REPAIRS)
- Test: `packages/store-postgres/test/pg-store.test.ts` (runs the contract), `packages/api/src/lib/drizzle.test.ts` (schema-repair coverage, if present)

**Interfaces:**
- Consumes: Task 2 types and contract.
- DDL:
  ```sql
  "match_json" text,
  "subjects" text[],
  "event_buffer" text,
  -- after the table:
  CREATE INDEX "engine_wakeups_event_subjects" ON "engine_wakeups" USING gin ("subjects") WHERE "kind" = 'event' AND "status" = 'running';
  ```
- SCHEMA_REPAIRS entries (one per column plus the index):
  ```ts
  { describe: "engine_wakeups.match_json column",
    probe: { kind: "column", table: "engine_wakeups", column: "match_json" },
    sql: 'ALTER TABLE "engine_wakeups" ADD COLUMN IF NOT EXISTS "match_json" text' },
  { describe: "engine_wakeups.subjects column",
    probe: { kind: "column", table: "engine_wakeups", column: "subjects" },
    sql: 'ALTER TABLE "engine_wakeups" ADD COLUMN IF NOT EXISTS "subjects" text[]' },
  { describe: "engine_wakeups.event_buffer column",
    probe: { kind: "column", table: "engine_wakeups", column: "event_buffer" },
    sql: 'ALTER TABLE "engine_wakeups" ADD COLUMN IF NOT EXISTS "event_buffer" text' },
  { describe: "engine_wakeups_event_subjects index",
    probe: { kind: "index", index: "engine_wakeups_event_subjects" },
    sql: 'CREATE INDEX IF NOT EXISTS "engine_wakeups_event_subjects" ON "engine_wakeups" USING gin ("subjects") WHERE "kind" = \'event\' AND "status" = \'running\'' },
  ```
- `findEventWaiters`: `SELECT * FROM engine_wakeups WHERE kind = 'event' AND status = 'running' AND subjects && $1::text[]`.
- `appendEventMatch`: one statement:
  ```sql
  UPDATE engine_wakeups
     SET event_buffer = (COALESCE(event_buffer, '[]')::jsonb || jsonb_build_array($2::jsonb))::text,
         updated_at = $3
   WHERE id = $1 AND status = 'running'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(event_buffer, '[]')::jsonb) e
                      WHERE e->>'dedupeKey' = $2::jsonb->>'dedupeKey')
  RETURNING id
  ```
  Cut `text` in TypeScript before the call.
- `TRANSITION_SQL`: add `event_buffer = COALESCE($N, event_buffer)` as the LAST parameter so existing `$5..$16` and the lease variant's `$17` keep their numbers; renumber the lease variant's cause to `$18`. Update `transitionParams` accordingly.
- `listDueWakeups` WHERE gains: `OR (kind = 'event' AND status = 'running' AND (COALESCE(event_buffer, '[]') <> '[]' OR deadline_at <= $1))`.
- `WAKEUP_KINDS` and `isWakeupKind` gain `"event"`. A row whose `match_json` or `event_buffer` fails to parse counts as a bad row through the existing `mapGoodRows` path.

- [ ] **Step 1:** Run `pnpm --filter @valet/store-postgres test`. Expect FAIL (contract cases from Task 2).
- [ ] **Step 2:** Implement the DDL, mappers, SQL, and SCHEMA_REPAIRS above.
- [ ] **Step 3:** Run `make dev-clean`, then `pnpm --filter @valet/store-postgres test` and `pnpm --filter @valet/api test drizzle`. Expect PASS. Run `pnpm typecheck`. Expect PASS.
- [ ] **Step 4:** Commit `feat(store-postgres): store event waiters with a subject index`.

### Task 4: GitHub normalization, subjects, and URLs

**Files:**
- Modify: `packages/plugin-github/src/triggers.ts:274-300` (`toEvent`)
- Create: `packages/plugin-github/src/subjects.ts`
- Modify: `packages/plugin-github/src/plugin.ts` (add `eventSubjects`)
- Test: `packages/plugin-github/src/subjects.test.ts`, `packages/plugin-github/test/fixtures/` (recorded payloads)

**Interfaces:**
- Produces: `githubEventSubjects(eventType: string, payload: Record<string, unknown>): { subjects: string[]; status?: string; bot: boolean }` and `githubSubjects: EventSubjects`.

- [ ] **Step 1:** Write table tests for every GitHub row of spec A6 and every GitHub row of A5. Use recorded payloads (trim to the fields used). Example rows:
  ```ts
  it.each([
    ["check_run", checkRunFailurePr42, ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42", `github:acme/lean-proofs@${SHA}`], "failure"],
    ["check_suite", checkSuiteForkNoPrs, ["github:acme", "github:acme/lean-proofs", `github:acme/lean-proofs@${SHA}`], "success"],
    ["pull_request", prClosedMerged, ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42", `github:acme/lean-proofs@${SHA}`], "merged"],
    ["pull_request_review", reviewApproved, ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42"], "approved"],
    ["issue_comment", commentOnPr42, ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42"], undefined],
    ["status", statusPending, ["github:acme", "github:acme/lean-proofs", `github:acme/lean-proofs@${SHA}`], "pending"],
  ])("%s maps to subjects and status", (type, payload, subjects, status) => {
    const r = githubEventSubjects(type, payload);
    expect(r.subjects).toEqual(subjects);
    expect(r.status).toBe(status);
  });
  it("Bot sender marks the actor as a bot", () => {
    expect(githubEventSubjects("check_run", { ...checkRunFailurePr42, sender: { id: 41898282, login: "github-actions[bot]", type: "Bot" } }).bot).toBe(true);
  });
  it.each([
    ["https://github.com/Acme/Lean-Proofs/pull/42", "github:acme/lean-proofs#42"],
    ["https://github.com/acme/lean-proofs/issues/7", "github:acme/lean-proofs#7"],
    [`https://github.com/acme/lean-proofs/commit/${SHA}`, `github:acme/lean-proofs@${SHA}`],
    ["https://github.com/acme/lean-proofs", "github:acme/lean-proofs"],
    ["github:acme/lean-proofs#42", "github:acme/lean-proofs#42"],
    ["https://example.com/x", null],
  ])("fromUrl(%s)", (input, subject) => {
    expect(githubSubjects.fromUrl(input)?.subject ?? null).toBe(subject);
  });
  it("label and url round-trip a PR subject", () => {
    expect(githubSubjects.label("github:acme/lean-proofs#42")).toBe("acme/lean-proofs#42");
    expect(githubSubjects.url("github:acme/lean-proofs#42")).toBe("https://github.com/acme/lean-proofs/pull/42");
  });
  ```
  Subjects are ordered coarse to fine and de-duplicated; owner and repo are lower-cased.
- [ ] **Step 2:** Run `pnpm --filter @valet/plugin-github test subjects`. Expect FAIL.
- [ ] **Step 3:** Implement `subjects.ts` per spec A2 and A5. In `toEvent`, set `subjects`, `status`, and `actor.bot` from `githubEventSubjects`. `url(subject)` for a `#n` subject returns the `/pull/n` form (GitHub redirects issue numbers).
- [ ] **Step 4:** Run the tests and the existing `triggers` tests. Expect PASS.
- [ ] **Step 5:** Commit `feat(plugin-github): normalize event subjects and status`.

### Task 5: Slack normalization, subjects, and URLs

**Files:**
- Modify: `packages/plugin-slack/src/triggers.ts:84-140` (`toEvent`), and the verify path that builds `VerifiedEvent` so the envelope `team_id` reaches `toEvent` when the inner event lacks `team`
- Create: `packages/plugin-slack/src/subjects.ts`
- Modify: `packages/plugin-slack/src/plugin.ts`
- Test: `packages/plugin-slack/src/subjects.test.ts`

**Interfaces:**
- Produces: `slackEventSubjects(eventType: string, payload: Record<string, unknown>, teamId: string | undefined): { subjects: string[]; bot: boolean }`, `slackSubjects: EventSubjects` (`fromUrl` returns `{ subject: "slack:?/C001/1712345678.000100", slackChannel: "C001" }` with the team placeholder `?`; the api fills the team, see Task 11).

- [ ] **Step 1:** Write table tests for the Slack rows of A6 and A5: a threaded reply carries workspace, channel, and thread subjects; a thread root carries the thread subject for its own `ts`; `bot_message` and `bot_id` set `bot: true`; a permalink `p1712345678000100` parses to `1712345678.000100`; a permalink with `?thread_ts=` uses the thread ts. `label("slack:T001/C001/1712345678.000100")` is `#C001 thread`; `url()` returns `null`.
- [ ] **Step 2:** Run `pnpm --filter @valet/plugin-slack test subjects`. Expect FAIL.
- [ ] **Step 3:** Implement. Thread the envelope `team_id` into `VerifiedEvent` (add an optional `teamId` field on the Slack verify result if the engine type allows extra context; otherwise put it on the payload as `__team_id` and document it in the code comment). In `toEvent`, set `subjects` and `actor.bot`.
- [ ] **Step 4:** Run the tests and existing Slack trigger tests. Expect PASS.
- [ ] **Step 5:** Commit `feat(plugin-slack): normalize event subjects`.

### Task 6: Linear normalization, subjects, URLs, and status resolver

**Files:**
- Modify: `packages/plugin-linear/src/triggers.ts:110-140` (`toEvent`)
- Create: `packages/plugin-linear/src/subjects.ts`, `packages/plugin-linear/src/status-resolver.ts`
- Modify: `packages/plugin-linear/src/plugin.ts`
- Test: `packages/plugin-linear/src/subjects.test.ts`, `packages/plugin-linear/src/status-resolver.test.ts`

**Interfaces:**
- Produces: `linearEventSubjects(type: string, payload)`, `linearSubjects: EventSubjects`, `linearStatusResolver: StatusResolver` (GraphQL `workflowStates(filter: { team: { key: { eq } } })`, cache per team key for one hour, keyed by org).

- [ ] **Step 1:** Table tests for the Linear rows of A6 and A5: issue create in triage gives `linear:team/ENG`, `linear:ENG-8`, status `triage`; a comment by an application actor gives `bot: true`; a comment payload without the parent identifier gives only the team subject; `fromUrl("https://linear.app/acme/team/ENG/triage")` is `linear:team/ENG`; `url("linear:ENG-7")` is `https://linear.app/issue/ENG-7`. Status resolver test with a stub `fetch`: returns `backlog` for a known state id, makes one GraphQL call for two lookups within the hour, returns `null` for an unknown id.
- [ ] **Step 2:** Run `pnpm --filter @valet/plugin-linear test subjects status-resolver`. Expect FAIL.
- [ ] **Step 3:** Implement. Read the actor type from the webhook's top-level `actor.type`; treat any value other than `user` as a bot. Verify the field name against a recorded webhook; if it differs, use the recorded name and add a spec errata line under A4.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit `feat(plugin-linear): normalize event subjects and resolve states`.

### Task 7: Pure clause matcher

**Files:**
- Create: `packages/api/src/events/waiter-match.ts`
- Test: `packages/api/src/events/waiter-match.test.ts`

**Interfaces:**
- Consumes: `EventClause`, `EventMatchSpec`, `EventMatchDigest`, `NormalizedEvent`, `DerivedEventDef`.
- Produces:
  ```ts
  export type ClauseResult = { matched: false } | { matched: true; derive?: string };
  export function matchClauses(spec: EventMatchSpec, event: NormalizedEvent, derived: readonly DerivedEventDef[]): ClauseResult;
  export function keyMatches(pattern: string, key: string): boolean; // same glob rule as subscriptions (trailing ".*")
  export function needsPreviousStatus(spec: EventMatchSpec): boolean;
  export function toDigest(event: NormalizedEvent, derive?: string): EventMatchDigest;
  export function mentionsBot(event: NormalizedEvent, botUserId: string | undefined): boolean; // slack.message text contains `<@botUserId>`
  ```

- [ ] **Step 1:** Encode every row of spec E1 as `it.each`, plus: `status` with no event status is no match; `actor` matches login or external id; `include_self` absent with an actor outside `self` matches. `mentionsBot` is true only for `slack.message` with `<@U-BOT>` in `text` and false for a missing bot id. `toDigest` takes `text` from the payload (`text` for Slack, `comment.body`/`review.body` for GitHub, `data.body` for Linear) and the URL from the payload's `html_url`, `refs.url`, or none.
- [ ] **Step 2:** Run `pnpm --filter @valet/api test waiter-match`. Expect FAIL.
- [ ] **Step 3:** Implement. Reuse the subscription key-glob function from `packages/api/src/events/match.ts` (export it if private).
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit `feat(api): match event waiter clauses`.

### Task 8: Match event waiters inside ingest

**Files:**
- Create: `packages/api/src/events/waiters.ts`
- Modify: `packages/api/src/events/ingest.ts:17` (`IngestDeps`), `:179-268` (call before the early return)
- Modify: `packages/engine/src/metrics.ts` (`recordEventWaiterMatch(service)`, `recordEventMatchFailed()`), engine index re-export
- Modify: ingest callers that build `IngestDeps`: `packages/api/src/plugins/http-github.ts:535`, `packages/api/src/channels/slack-inbox.ts:263`, `packages/api/src/plugins/http-routes.ts:201`
- Test: `packages/api/src/events/waiters.test.ts`, `packages/api/src/events/ingest.test.ts`

**Interfaces:**
- Consumes: Task 7, `SessionStore.findEventWaiters`/`appendEventMatch`, `channelVisibility`.
- Produces:
  ```ts
  export interface WaiterMatchDeps {
    engineStore: SessionStore;
    sessionOrg(sessionId: string): Promise<{ orgId: string; ownerType: string; ownerId: string } | null>;
    plugins: ValetPlugin[];
    slackStillVisible(sessionId: string, channelId: string): Promise<boolean>;
    resolvePreviousStatus(service: string, orgId: string, event: NormalizedEvent): Promise<string | null>;
    nudge(): void;
    now(): number;
    /** Slack bot user id for the org, for the mention rule. */
    slackBotUserId(orgId: string): Promise<string | undefined>;
    /** True when an enabled slack.app_mention subscription matches this event's channel. */
    appMentionCovered(orgId: string, event: NormalizedEvent): Promise<boolean>;
  }
  export async function matchEventWaiters(deps: WaiterMatchDeps, orgId: string, service: string, event: NormalizedEvent): Promise<number>;
  // IngestDeps gains: waiters?: WaiterMatchDeps
  ```

- [ ] **Step 1:** Write failing tests:
  - An event with no matching subscription still appends a digest to a matching waiter and returns 1; the receipt has a `waiter_match` stage with detail `1 event waiter matched.`
  - A waiter in another org gets nothing.
  - A waiter whose session is gone (`sessionOrg` returns null) gets nothing and ingest succeeds.
  - Redelivery of the same `dedupeKey` appends once (Review Focus 1).
  - A `matchEventWaiters` that throws leaves the subscription outcome and receipt stages identical to a run without waiters, and increments the failed counter (INV-E2).
  - A Slack candidate whose `slackStillVisible` is false is dropped.
  - `nudge` is called once when at least one digest was appended, and never otherwise.
  - Mention rule (spec Part E): a `slack.message` containing `<@U-BOT>` is skipped when an enabled subscription naming `slack.app_mention` matches the channel (evaluate it with the existing subscription matcher against the same payload), and matches when no such subscription exists.
- [ ] **Step 2:** Run `pnpm --filter @valet/api test waiters ingest`. Expect FAIL.
- [ ] **Step 3:** Implement `matchEventWaiters` per spec Part E steps 1 to 6. In `ingestEvent`, call it inside its own `try/catch` before the early return at `:265`, then append the receipt stage (step 7). Wire `waiters` at the three ingest call sites from providers (`engineStore`, the sessions table for `sessionOrg`, `channelVisibility` for Slack, `wakeWatcher.nudge`).
- [ ] **Step 4:** Run. Expect PASS. Run `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat(api): match event waiters during event ingest`.

### Task 9: Derived events and GitHub checks_completed

**Files:**
- Create: `packages/plugin-github/src/derived.ts`
- Modify: `packages/plugin-github/src/plugin.ts` (`derivedEvents`)
- Modify: `packages/api/src/events/ingest.ts:24-36` (catalog lists derived keys with `derived: true`), `packages/engine/src/valet-plugin.ts` (`EventCatalogEntry.derived?: boolean`)
- Create: `packages/api/src/events/derive.ts` (`runDerive`)
- Test: `packages/plugin-github/src/derived.test.ts`, `packages/api/src/events/derive.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const checksCompleted: DerivedEventDef; // key "github.pull_request.checks_completed"
  export async function runDerive(plugins: ValetPlugin[], orgId: string, digest: EventMatchDigest, subject: string,
    ctx: DeriveContext): Promise<{ result: "event"; digest: EventMatchDigest } | { result: "null" } | { result: "error"; error: unknown }>;
  ```
  The digest stores the source event's SHA in `subjects` (commit subject), so `derive` can read it without the raw payload. `runDerive` builds a minimal `NormalizedEvent` from the digest for `derive`.

- [ ] **Step 1:** Encode spec B2 rows against a stub `fetch` returning fixture JSON for `GET /repos/acme/lean-proofs/pulls/42`, `GET /repos/acme/lean-proofs/commits/<sha>/check-runs?per_page=100&page=N`, `GET /repos/acme/lean-proofs/commits/<sha>/status`. Add: pagination over two pages; a 502 makes `runDerive` return `error` (Review Focus 4); the derived dedupeKey equals `derived:checks_completed:acme/lean-proofs@<sha>:failure`.
- [ ] **Step 2:** Run `pnpm --filter @valet/plugin-github test derived` and `pnpm --filter @valet/api test derive`. Expect FAIL.
- [ ] **Step 3:** Implement B1 exactly. `appToken()` resolves the installation token through `resolveInstallationApiToken(deps, orgId, owner)`.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit `feat(plugin-github): derive checks_completed for pull requests`.

### Task 10: WakeWatcher delivery for event waiters

**Files:**
- Modify: `packages/api/src/engine/wake-watcher-decide.ts` (new `decideEventWaiter`), `packages/api/src/engine/wake-watcher.ts:155-460` (derive step, event branch in `processRow`, `nudge()`), `packages/api/src/lib/sweep-timer.ts:21` (expose a guarded `runNow`)
- Modify: `packages/engine/src/metrics.ts` (`recordEventDerive(key, result)`)
- Test: `packages/api/src/engine/wake-watcher-decide.test.ts`, `packages/api/src/engine/wake-watcher.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function decideEventWaiter(now: number, row: Wakeup, opts: DecideOptions): WakeupDecision | null;
  export function eventMatchedSignal(row: Wakeup, digests: EventMatchDigest[], n: number, terminal: boolean): SignalDraft;
  export function eventEndedSignal(row: Wakeup, cause: "deadline" | "rate", hours: number, count: number): SignalDraft;
  // WakeWatcher gains: nudge(): void  (schedules one pass; never overlaps a running pass)
  ```
- Body format per spec Part F; attributes `wakeupId`, `kind: "event"`, `subject`, `matchCount`.

- [ ] **Step 1:** Failing decide tests:
  - once mode, one digest: `to: "done"`, cause `fired`, one `event.matched` with dispatch id `wakeup:<id>:terminal`, patch `eventBuffer: []`.
  - once mode, three digests: body lists the first, then `Also matched` with two lines.
  - stream mode, first emit: `to: "running"`, signal dispatch id `wakeup:<id>:event:1`, `eventCount` 1, `lastEmitAt` now.
  - stream mode inside `watchMinIntervalMs` of `lastEmitAt`: returns `null` (keep buffer).
  - stream mode with `eventMatch.minIntervalMs: 30_000`: a digest 20 s after `lastEmitAt` waits; at 30 s it emits (spec Scenario E4).
  - stream mode, burst of 50 digests: one signal with 50 blocks (Review Focus 3).
  - stream mode past `watchMaxEventsPerHour` in the window: `to: "done"`, cause `rate`, `event.ended` with the F1 rate text.
  - deadline passed with empty buffer: `to: "expired"`, cause `deadline`, `event.ended` with the F1 deadline text.
  - A digest with `derive` set is never delivered by `decideEventWaiter` (the watcher derives first).
- [ ] **Step 2:** Failing watcher tests: a derive step replaces a `derive` digest with the derived digest; a `null` derive drops it with no signal; an `error` derive keeps it and records `result="error"`; `nudge()` during a running pass runs exactly one more pass after it.
- [ ] **Step 3:** Run `pnpm --filter @valet/api test wake-watcher`. Expect FAIL.
- [ ] **Step 4:** Implement. In `processRow`, branch on `row.kind === "event"`: run derive for the latest `derive` digest (one per tick), write the buffer back with `transitionWakeup(id, ["running"], "running", { eventBuffer }, now)`, then `decideEventWaiter` and the existing `applyDecision`.
- [ ] **Step 5:** Run. Expect PASS.
- [ ] **Step 6:** Commit `feat(api): deliver event waiter signals from the WakeWatcher`.

### Task 11: Arm checks and the wait_for_event tool

**Files:**
- Create: `packages/api/src/events/waiter-arm.ts`
- Modify: `packages/engine/src/wakeups/types.ts` (`WakeupsSeam.armEvent?`), `packages/engine/src/wakeups/validate.ts` (`validateWaitForEvent`, `WakeupsTool` gains `"wait_for_event"`), `packages/engine/src/builtin-tools/wakeups.ts` (new tool), `packages/engine/src/builtin-tools/index.ts:17-34,1019`
- Modify: `packages/api/src/engine/wakeups-seam.ts:80-330` (`armEvent` creates the row), `packages/api/src/engine/host.ts` (`wakeupsOptions()` passes an arm function for coding, child, and assistant sessions; workflow sessions get none)
- Test: `packages/engine/test/wait-for-event.test.ts`, `packages/api/src/events/waiter-arm.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // engine
  export interface ArmEventRequest { subject: string; on: EventClause[]; once: boolean; reason: string; maxHours: number; minIntervalMs?: number }
  // EventMatchSpec (Task 2) gains: minIntervalMs?: number
  // WakeupsSeam gains:
  armEvent?(threadId: string, req: ArmEventRequest, origin?: ChannelOrigin): Promise<{ wakeup: Wakeup } | { refused: string }>;
  export function validateWaitForEvent(args: unknown, limits: WakeupLimits): Validation<ArmEventRequest>;
  export const waitForEventTool: ToolDef;
  // api
  export interface ArmDeps { /* plugins, db, credential readers, followed-thread lookup, installation checks */ }
  export async function checkArm(deps: ArmDeps, ctx: { sessionId: string; threadId: string; orgId: string }, req: ArmEventRequest):
    Promise<{ ok: true; subjects: string[]; self: string[] } | { ok: false; text: string }>;
  ```
- Refusal texts: copy R1 to R8 verbatim from spec D1.
- R2 checks owner coverage with `installationResolvesFor(deps, orgId, owner, { strictOwner: true })`. Per-repo access is checked by R3's read with the session's resolved credential. (Spec errata: note this split under D1.)
- Workflow sessions: `armEvent` is absent, so the tool returns `[wait_for_event] Workflow runs cannot wait for events. Use a workflow trigger instead.` (spec errata: add as R9).
- `self`: the owner's linked external id for the service, the shared credential owner's external id when the session resolves one, and the app actor id.

- [ ] **Step 1:** Engine tests for `validateWaitForEvent`: 0 clauses, 9 clauses, empty reason, 201-character reason, `max_hours` 0 and over `timerMaxHours`, default `once` true, `min_interval_seconds` 29 and 3601 refused, 30 accepted as `minIntervalMs: 30000`, `min_interval_seconds` with `once: true` refused (stream mode only). Tool tests with a fake seam: result text matches D2; a `{ refused }` result returns its text; a missing seam returns `wakeupsUnavailable("wait_for_event")`; at the per-session limit returns the `[wakeups_limit]` text.
- [ ] **Step 2:** api tests for `checkArm`, one per refusal R1 to R9 with stubbed deps, plus a pass case that returns subjects and `self`. Include Review Focus 5 (R6 for a followed thread).
- [ ] **Step 3:** Run `pnpm --filter @valet/engine test wait-for-event` and `pnpm --filter @valet/api test waiter-arm`. Expect FAIL.
- [ ] **Step 4:** Implement. `armEvent` in the seam: run `checkArm`; on pass, create the row (`kind: "event"`, `status: "running"`, `deadlineAt: now + maxHours * 3_600_000`, `subjects`, `eventMatch`, `eventBuffer: []`), no lease (INV-E3). `wakeup_list` shows `subject` and clause count; `process_read` refuses an event waiter with the D2 text.
- [ ] **Step 5:** Run. Expect PASS. `pnpm typecheck`.
- [ ] **Step 6:** Commit `feat(engine): add wait_for_event with arm checks`.

### Task 12: Background-work rule, child settle, wire, and routes

**Files:**
- Modify: `packages/api/src/engine/wakeups-admin.ts:60-140,262` (`selectWork` treats `event` like `timer`; human-cancel signal `event.ended`)
- Modify: `packages/api/src/orchestrator/children.ts:1074-1125,1419-1425` (event waiters within the timer bound hold settle)
- Modify: `packages/api/src/wire/types.ts:818-870` (`WakeupKindWire` gains `"event"`; `WakeupSummary` gains `subject?`, `subjectLabel?`, `subjectUrl?`, `clauseCount?`)
- Modify: `packages/api/src/routes/wakeups.ts` (list returns the new fields using plugin `eventSubjects.label/url`)
- Test: `packages/api/src/engine/wakeups-admin.test.ts`, `packages/api/src/orchestrator/children.test.ts`, `packages/api/src/routes/wakeups.test.ts`

- [ ] **Step 1:** Failing tests: pause and replace (`leasedOnly`) leave an event waiter running; move and archive stop it with an `event.ended` human-cancel signal; profile change leaves it running; a child with an event waiter whose deadline is inside the bound stays unsettled until the waiter ends; the list route returns `subjectLabel` `acme/lean-proofs#42` and `subjectUrl`.
- [ ] **Step 2:** Run the three test files. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit `feat(api): apply the background-work rule to event waiters`.

### Task 13: Subject filter for subscriptions

**Files:**
- Modify: `packages/api/src/events/match.ts:97-160` (`subject` field reads `event.subjects`), `packages/api/src/events/ingest.ts` (pass subjects into matching), catalog filters (implicit `subject` filter on every entry)
- Test: `packages/api/src/events/match.test.ts`

- [ ] **Step 1:** Failing tests: a subscription filter `{ field: "subject", op: "eq", value: "github:acme/lean-proofs#42" }` matches a `check_run.completed` for PR 42 and not PR 43; `op: "prefix"` with `github:acme/lean-proofs` matches both; derived keys are absent from subscription key validation.
- [ ] **Step 2:** Run `pnpm --filter @valet/api test match`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit `feat(api): filter subscriptions by event subject`.

### Task 14: Web for event waiters

**Files:**
- Modify: the composer status line, thread context card section, and thread-row line components added on #863 (find them by `grep -rn "Background work" packages/web/src`), `packages/web/src/components/session/signal-card.tsx:140-360` (`WAKEUP_PREFIXES` gains `"event."`; an event card)
- Test: the matching `*.test.tsx` files

- [ ] **Step 1:** Failing tests: the composer line shows `waiting on acme/lean-proofs#42` with the event icon; the card section shows the subject as a link to `subjectUrl` and the clause count; the thread row shows `Waiting on acme/lean-proofs#42`; an `event.matched` signal renders key, status chip, actor, summary, and link; a stream signal with three digests renders three blocks; `event.ended` with cause `deadline` renders the outcome label.
- [ ] **Step 2:** Run `pnpm --filter @valet/web test signal-card background` (adjust filters to the #863 file names). Expect FAIL.
- [ ] **Step 3:** Implement with existing primitives.
- [ ] **Step 4:** Run, then `make e2e E2E_ARGS="--only web-build"`. Expect PASS.
- [ ] **Step 5:** Commit `feat(web): show event waiters and their signals`.

### Task 15: Agent guidance and docs

**Files:**
- Modify: `packages/api/src/engine/prompt-rules.ts:168-175`, `packages/api/src/orchestrator/persona.ts:277-279`, the host prompt builders in `packages/api/src/engine/host.ts` (pass the thread link; find the public URL setting the api already uses for links, e.g. `BETTER_AUTH_URL`/the configured public URL), `packages/engine/src/builtin-tools/wakeups.ts` (tool description recipes)
- Modify: `docs/api-reference.md` (wakeups route fields), `docs/specs/2026-07-20-event-system-design.md` (subjects, derived events, `subject` filter), `docs/specs/2026-10-08-sandbox-scratch-wakeups-leases-design.md` (`event` kind in the wakeup list), `docs/specs/2026-10-15-event-wakeups-design.md` (errata from Tasks 6 and 11, Deviations)
- Test: `packages/api/src/engine/prompt-rules.test.ts`, `packages/api/src/orchestrator/persona.test.ts`

- [ ] **Step 1:** Failing tests: with a public URL configured, the coding prompt and persona contain `This thread's link is https://valet.example/threads/<thread id>.`; without one, they omit the sentence. The coding prompt and persona contain `call \`wait_for_event\` with its URL`; the tool description contains the four recipe headings `CI on a pull request`, `A Slack reply`, `A Linear triage shift`, `A reply on a Linear issue`, and the sentence about subscriptions.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement the Part I text verbatim. Update the docs.
- [ ] **Step 4:** Run tests and `python3 scripts/docs/docs_lint.py`. Expect PASS.
- [ ] **Step 5:** Commit `docs: document event waiters for agents and operators`.

### Task 16: Acceptance scenarios and validation

**Files:**
- Create: `packages/api/src/integration/event-wakeups.test.ts`
- Modify: `scripts/e2e/lib.ts` only if the integration suite needs registration

- [ ] **Step 1:** Write Scenarios A to E from the spec as five `it` blocks using the existing integration setup (`packages/api/src/integration/_setup.ts`), the GitHub fixture server (`startGithubFixture`), signed webhook helpers for Slack and Linear, and a fake clock for the WakeWatcher. Every expected observation in the spec tables is an assertion.
- [ ] **Step 2:** Run `pnpm --filter @valet/api test event-wakeups`. Fix code (not the scenarios) until PASS. If a scenario step is wrong, fix the spec in the same commit.
- [ ] **Step 3:** Run `make e2e 2>&1 | tee /tmp/e2e-event-wakeups.log`. Every red row MUST be a named, pre-existing environmental failure.
- [ ] **Step 4:** Local Kubernetes check: `make k8s-build-fast`, roll the api, run Scenario A by hand against the cluster; confirm with `kubectl --context rancher-desktop -n valet-sandboxes get pods` that the session's pod is gone during steps A2 to A5 and the signals still arrive.
- [ ] **Step 5:** Commit `test(api): cover event wakeup acceptance scenarios`.
