# Event wakeups

Date: 2026-10-15. Status: proposed.

Depends on: `2026-10-08-sandbox-scratch-wakeups-leases-design.md` (wakeups,
signals, the WakeWatcher, the background-work rule), and
`2026-07-20-event-system-design.md` (ingress, `NormalizedEvent`, subscriptions,
receipts). Related, shipped separately: the native integration credential
policy (see Non-goals).

## Problem

An agent can wait for a process, for output lines, or for a time. It cannot
wait for something that happens in GitHub, Slack, or Linear. Today an agent
that reacts to CI, a review, a Slack reply, or a new triage ticket has
three poor options:

1. It polls with `watch` and `gh` or `curl`. The sandbox stays awake for the
   whole wait, and each poll result costs a turn.
2. It asks a person to remind it.
3. It proposes a durable event subscription. It waits for a person to enable
   it, and it outlives the task.

The event pipeline already receives these events. Agents cannot query them,
because each event family keeps the same fact at a different payload path.
For example, a pull request number is at `check_run.pull_requests[].number`,
`pull_request.number`, or `issue.number`. A subscription filter on a field
that the trigger does not declare never matches.

## Thesis

Normalize every event into one shape with **subjects** and a **status**.
Then a one-off wait is a small query: a subject plus raw event keys. An
event waiter is a new wakeup kind. It reuses the signal turns, limits,
badge, cancel path, and background-work rule of the wakeups spec. It holds
no lease, so the sandbox sleeps while the agent waits.

## Requirement language

MUST, MUST NOT, SHOULD, and MAY follow RFC 2119. A sentence without one of
these words is informative.

## Terminology

One name for one thing. Synonyms in code or prose are defects.

- **event**: a `NormalizedEvent` produced by a plugin trigger's `toEvent`.
- **subject**: a canonical string that names one object an event concerns,
  such as a repository, a pull request, or a Slack thread (Part A).
- **status**: one normalized outcome string on an event, when the event has
  one (Part A).
- **previous status**: the status the subject had before an update event,
  when the provider reports it.
- **derived event**: an event that a plugin computes from other events and
  provider state (Part B).
- **event waiter**: a wakeup row with `kind = "event"`. In prose always
  "event waiter", never "listener" or "subscription".
- **subscription**: the existing durable, person-enabled event subscription.
  It is a different thing from an event waiter.
- **clause**: one entry of an event waiter's `on` list (Part C).
- **match digest**: the bounded record of one matched event that an event
  waiter stores until delivery.
- **once mode** and **stream mode**: the two event waiter modes (Part F).
- **arm**: the `wait_for_event` call that creates an event waiter.
- **self**: the set of external actor ids that the session acts as for a
  service (Part E).
- **native integration**: GitHub, Slack, or Linear. Each has an app
  identity that Valet owns.
- **thread link**: the web URL of a thread, `<public url>/threads/<thread id>`.

## Acceptance scenarios (normative)

The implementation ships one integration test per scenario. Each test runs
from a clean database against signed fixture webhooks and fixture provider
APIs.

Universe:

- Org `acme`. User `u-001`, linked to GitHub user `ada` (id `1001`), Slack
  user `U001`, and Linear user `lin-u1`.
- GitHub App `valet-app[bot]` (id `9001`), installation `77` on
  `acme/lean-proofs`. Pull request `#42`, head SHA
  `aaaa000000000000000000000000000000000001`.
- Slack team `T001`, public channel `C001` with the bot `B9` (user
  `U-BOT`) as a member. Thread root `1712345678.000100`.
- Linear team `ENG`, app actor `app-1`.
- Personal session `s-1`, thread `t-1`. Idle timeout 2 minutes.

### Scenario A: CI on a pull request

| Step | Action | Expected observation |
|---|---|---|
| A1 | Agent calls `wait_for_event` with subject `https://github.com/acme/lean-proofs/pull/42`, clauses `[{ key: "github.check_run.completed", status: ["failure", "timed_out", "cancelled", "action_required", "startup_failure"] }, { key: "github.pull_request.checks_completed" }]`, `once: false`, reason `CI on #42`, `max_hours: 6`. | The result text starts `waiting wk_` and names `github:acme/lean-proofs#42`. One `wakeups` row exists with kind `event`, status `running`, subjects `["github:acme/lean-proofs#42"]`. No `leases` row exists. |
| A2 | The turn ends. Three minutes pass. | The session's sandbox is suspended by the idle sweep. The event waiter is still `running`. |
| A3 | Fixture sends `check_run.completed` for check `lint`, conclusion `success`, PR `42`. The fixture API reports one pending check run. | No signal reaches `t-1` within 10 seconds. |
| A4 | Fixture sends `check_run.completed` for check `test`, conclusion `failure`. The fixture API still reports one pending check run. | Within 5 seconds `t-1` receives one `event.matched` signal. Its body contains `github.check_run.completed · failure`. |
| A5 | Fixture sends `check_run.completed` for check `build`, conclusion `success`. The fixture API reports no pending check runs. | Within 5 seconds `t-1` receives one `event.matched` signal whose body contains `github.pull_request.checks_completed · failure`. |
| A6 | Agent calls `wakeup_cancel` with the waiter id. | The row is `cancelled`. No further signal reaches `t-1`. |

### Scenario B: a Slack thread reply

| Step | Action | Expected observation |
|---|---|---|
| B1 | Agent calls `wait_for_event` with subject `https://acme.slack.com/archives/C001/p1712345678000100`, clause `[{ key: "slack.message", bots: false }]`, reason `Reply from Grace`, `max_hours: 24`. | The row's subjects are `["slack:T001/C001/1712345678.000100"]`. |
| B2 | Fixture sends a threaded `message` from the bot `B9`. | No signal within 10 seconds. |
| B3 | Fixture sends a threaded `message` from user `U002` with text `Looks good, ship it`. | Within 5 seconds `t-1` receives one `event.matched` signal whose body contains `Looks good, ship it`. The row is `done` with cause `fired`. |
| B4 | Fixture sends another threaded reply from `U002`. | No signal. |

### Scenario C: a Linear triage shift

| Step | Action | Expected observation |
|---|---|---|
| C1 | Agent calls `wait_for_event` with subject `https://linear.app/acme/team/ENG/triage`, clauses `[{ key: "linear.issue.create", status: ["triage"] }, { key: "linear.issue.update", status: ["triage"], from_status: ["backlog", "unstarted", "started", "completed", "canceled"] }]`, `once: false`, reason `ENG triage shift`, `max_hours: 8`. | The row's subjects are `["linear:team/ENG"]`. |
| C2 | Fixture sends `Issue create` for `ENG-8` in a `triage` state, created by a person. | Within 5 seconds `t-1` receives one `event.matched` signal naming `ENG-8`. |
| C3 | Fixture sends `Issue update` for `ENG-8` that changes only the title. | No signal. |
| C4 | Fixture sends `Issue update` for `ENG-9` from a `backlog` state to a `triage` state. | `t-1` receives one `event.matched` signal naming `ENG-9`, no earlier than `watchMinIntervalMs` after C2's signal. |
| C5 | Fixture sends `Comment create` on `ENG-8` by the app actor `app-1`. | No signal (self). |

### Scenario D: refusals at arm

| Step | Action | Expected observation |
|---|---|---|
| D1 | Subject `https://github.com/acme/other/pull/1`, which installation `77` does not cover. | The result is the refusal text R2 (Part D). No row exists. |
| D2 | Subject a Slack permalink in channel `C002`, where the bot is not a member. | The result is the refusal text R4. |
| D3 | Clause key `github.check_suite.done`. | The result is the refusal text R5. |

### Scenario E: an incident channel

Org `acme` has an enabled team subscription on `slack.channel_created` with
filter `channel_name` prefix `inc-`, targeting the team assistant. It also
has an enabled `slack.app_mention` subscription for the same team.

| Step | Action | Expected observation |
|---|---|---|
| E1 | Fixture sends `channel_created` for public channel `C900`, name `inc-db-latency`. | The team assistant receives one signal in a new thread `t-inc`. |
| E2 | The agent calls `conversations.join` for `C900`, posts its thread link to `C900`, then calls `wait_for_event` with subject `slack:T001/C900`, clause `[{ key: "slack.message", bots: false }]`, `once: false`, `min_interval_seconds: 30`, reason `Incident inc-db-latency`, `max_hours: 168`. | The posted message contains the link `<public url>/threads/t-inc`. One running event waiter exists on `t-inc`. |
| E3 | Fixture sends three messages from `U002` and `U003` in `C900` within 10 seconds. | `t-inc` receives one `event.matched` signal that lists all three. |
| E4 | 20 seconds after E3's signal, fixture sends one more message. | `t-inc` receives its signal no earlier than 30 seconds after E3's signal. |
| E5 | Fixture sends a message `<@U-BOT> status?` and the matching `app_mention` event. | `t-inc` receives exactly one turn for that post, from the `slack.app_mention` subscription. The event waiter skips the `message` event. |

Pass criterion: all steps of all five scenarios, in one run each, from a
clean start.

## Part A: Normalization

`NormalizedEvent` (`packages/engine/src/valet-plugin.ts`) gains these
optional fields:

```ts
/** Canonical subjects, coarse to fine. */
subjects?: string[];
/** One normalized outcome, when the event has one. */
status?: string;
/** The status before this update, when the provider reports it. */
previousStatus?: string;
```

`actor` gains `bot?: boolean`.

A plugin's `toEvent` MUST fill `subjects` for every event it emits. Each
event MUST carry at least one subject. The mapping for each service is a
pure, exported function. `refs` stays unchanged, so every existing filter
keeps its behavior.

### A1. Subject grammar

| Service | Object | Subject |
|---|---|---|
| GitHub | owner | `github:<owner>` |
| GitHub | repository | `github:<owner>/<repo>` |
| GitHub | pull request or issue | `github:<owner>/<repo>#<number>` |
| GitHub | commit | `github:<owner>/<repo>@<full sha>` |
| Slack | workspace | `slack:<team>` |
| Slack | channel | `slack:<team>/<channel>` |
| Slack | thread | `slack:<team>/<channel>/<thread_ts>` |
| Linear | team | `linear:team/<KEY>` |
| Linear | issue | `linear:<IDENTIFIER>` |

Owner and repository names are lower-cased. GitHub numbers pull requests
and issues in one sequence, so a comment on pull request 42 carries
`#42`.

### A2. GitHub mapping

- Owner and repository come from `repository.full_name`.
- Numbers come from `pull_request.number`, `issue.number`, and every entry
  of `check_run.pull_requests`, `check_suite.pull_requests`, and
  `workflow_run.pull_requests`.
- SHAs come from `check_run.head_sha`, `check_suite.head_sha`,
  `workflow_run.head_sha`, `pull_request.head.sha`, and `sha` on `status`.
- Status: `conclusion` for check runs, check suites, and workflow runs;
  `review.state` lower-cased for reviews; `merged` or `closed` for
  `pull_request.closed`; `state` for `status`.
- `actor.bot` is true when `sender.type` is `Bot`.

### A3. Slack mapping

- The team comes from the event's team field. When it is absent, the
  ingress passes the team id of the org's connected workspace.
- Every event with a channel carries the channel subject.
- A message with `thread_ts` carries the thread subject for that
  `thread_ts`. A message without `thread_ts` carries the thread subject
  for its own `ts`, so a wait on a thread also sees edits to its root.
- `actor.bot` is true when the event has `bot_id` or the subtype
  `bot_message`.

### A4. Linear mapping

- Issue events carry `linear:team/<data.team.key>` and
  `linear:<data.identifier>`.
- Comment events carry the team subject and, when the payload includes it,
  the parent issue's identifier.
- Status is the issue state's `type`: `triage`, `backlog`, `unstarted`,
  `started`, `completed`, or `canceled`.
- `previousStatus`: Linear's `updatedFrom` reports a state id only. The
  normalizer leaves `previousStatus` unset. The matcher resolves it through
  the plugin's status resolver only when a candidate clause names
  `from_status` (Part E).
- `actor.bot` is true when the webhook's actor is an application.

### A5. URL parsing

Each native plugin exports `subjectFromUrl(url)`. The tool uses it at arm.
Ingest never calls it.

| Input | Subject |
|---|---|
| `https://github.com/Acme/Lean-Proofs/pull/42` | `github:acme/lean-proofs#42` |
| `https://github.com/acme/lean-proofs/issues/7` | `github:acme/lean-proofs#7` |
| `https://github.com/acme/lean-proofs/commit/aaaa000000000000000000000000000000000001` | `github:acme/lean-proofs@aaaa000000000000000000000000000000000001` |
| `https://github.com/acme/lean-proofs` | `github:acme/lean-proofs` |
| `https://acme.slack.com/archives/C001/p1712345678000100` | `slack:T001/C001/1712345678.000100` |
| `https://acme.slack.com/archives/C001/p1712345699000200?thread_ts=1712345678.000100` | `slack:T001/C001/1712345678.000100` |
| `https://linear.app/acme/issue/ENG-7/fix-login` | `linear:ENG-7` |
| `https://linear.app/acme/team/ENG/triage` | `linear:team/ENG` |
| `github:acme/lean-proofs#42` | `github:acme/lean-proofs#42` |
| `https://example.com/x` | refusal R1 |

A Slack permalink carries a workspace domain and no team id. The tool
resolves the team as the org's connected Slack workspace and confirms the
channel with `conversations.info`.

### A6. Normalization vectors

Implementations encode these rows as table tests against recorded payloads.

| Event | Subjects | Status | Bot |
|---|---|---|---|
| `check_run.completed`, PR 42, conclusion `failure` | `github:acme`, `github:acme/lean-proofs`, `github:acme/lean-proofs#42`, `github:acme/lean-proofs@aaaa…0001` | `failure` | sender type |
| `check_suite.completed`, empty `pull_requests` (fork) | owner, repo, commit | `success` | sender type |
| `pull_request.closed`, merged | owner, repo, `#42`, head commit | `merged` | sender type |
| `pull_request_review.submitted`, state `APPROVED` | owner, repo, `#42` | `approved` | sender type |
| `issue_comment.created` on PR 42 | owner, repo, `#42` | none | sender type |
| `status`, state `pending` | owner, repo, commit | `pending` | sender type |
| Slack threaded reply in `C001` | `slack:T001`, `slack:T001/C001`, `slack:T001/C001/1712345678.000100` | none | `false` |
| Slack thread root `1712345678.000100` | workspace, channel, thread `1712345678.000100` | none | `false` |
| Slack `bot_message` | workspace, channel, thread | none | `true` |
| Linear `Issue create` `ENG-8`, state type `triage` | `linear:team/ENG`, `linear:ENG-8` | `triage` | `false` |
| Linear `Comment create` by app actor | team, parent issue | none | `true` |

## Part B: Derived events

*Depends on: Part A.*

A native plugin MAY declare derived event keys:

```ts
interface DerivedEventDef {
  key: string;              // e.g. "github.pull_request.checks_completed"
  description: string;
  sources: string[];        // source event keys, globs allowed
  derive(ctx: DeriveContext, subject: string, source: NormalizedEvent):
    Promise<NormalizedEvent | null>;
}
```

- Derived keys appear in `workflows.list_event_types` marked `derived`.
- Ingest never calls `derive`. The WakeWatcher calls it for a match digest
  that a clause on a derived key produced (Part E, Part F).
- `derive` returns `null` when the derived condition does not hold yet.
  The WakeWatcher then drops the digest and sends no signal.
- `DeriveContext` gives the plugin the org's app credential for its
  service. It gives no session credential.

### B1. `github.pull_request.checks_completed`

Sources: `github.check_run.completed`, `github.check_suite.completed`,
`github.workflow_run.completed`, `github.status`. Subject: a pull request
subject.

1. Read the pull request. If the source event's SHA differs from the
   current head SHA, return `null`.
2. List check runs for the head SHA (all pages) and read the combined
   commit status.
3. If any check run has a status other than `completed`, or the combined
   status is `pending` with at least one status, return `null`.
4. Otherwise return an event with status `failure` when any conclusion is
   `failure`, `timed_out`, `cancelled`, `action_required`, or
   `startup_failure`, or the combined status is `failure` or `error`.
   Return status `success` in all other cases.
5. The derived `dedupeKey` is
   `derived:checks_completed:<owner>/<repo>@<sha>:<status>`.

A pull request with no checks never produces this event. The waiter's
deadline ends that wait.

### B2. Derive vectors

| Fixture state | Result |
|---|---|
| Source SHA is an old head | `null` |
| One check run `in_progress` | `null` |
| All runs `success`, no statuses | status `success` |
| All runs complete, one `failure` | status `failure` |
| All runs `success`, combined status `pending` with one status | `null` |

## Part C: The event waiter

*Depends on: Parts A and B.*

An event waiter is a `wakeups` row with `kind = "event"`. Four nullable
columns hold its state:

```sql
"match_json"   text,    -- { clauses, once, self, minIntervalMs }
"subjects"     text[],  -- the subjects it waits on
"event_buffer" text,    -- JSON array of match digests awaiting delivery
"event_seen"   text     -- JSON array of delivered dedupe keys, oldest first
CREATE INDEX "engine_wakeups_event_subjects" ON "engine_wakeups"
  USING gin ("subjects") WHERE "kind" = 'event' AND "status" = 'running';
```

- The four columns and the index MUST ship with matching `SCHEMA_REPAIRS`
  entries.
  `ENGINE_SCHEMA_VERSION` MUST NOT change.
- `WakeupKind` gains `event`. `WakeupCause` uses the existing `fired`,
  `deadline`, `cancelled`, and `rate`.
- A clause is `{ key, status?, from_status?, actor?, bots?, include_self? }`.
- An event waiter MUST NOT create a lease.

`SessionStore` gains three methods, all covered by the conformance suite.
Each write method is one statement.

- `findEventWaiters(subjects: string[]): Promise<Wakeup[]>` returns running
  event waiters whose subjects overlap the argument.
- `appendEventMatch(id, digest, updatedAt): Promise<boolean>` appends a
  digest and sets `updatedAt`. It appends only to a `running` row with
  `kind = "event"`. It refuses a `dedupeKey` that `event_buffer` or
  `event_seen` holds. It refuses when the buffer holds 200 digests, and it
  counts that refusal in `valet_event_waiter_buffer_full_total`. It
  returns whether it appended.
- `removeEventMatches(id, dedupeKeys, updatedAt): Promise<boolean>` removes
  only the digests with those keys from `event_buffer`. A digest that
  arrived after the caller read the row stays. It appends the keys to
  `event_seen` and keeps the newest 256, so the oldest key drops first. It
  returns false for an unknown id or a row that is not an event waiter.
- `listDueWakeups` also returns a running event waiter whose buffer is not
  empty or whose `deadlineAt` has passed.

A match digest holds `key`, `status`, `previousStatus`, `subjects`,
`summary`, `url`, `actor` login, `occurredAt`, `dedupeKey`, `text`, and an
optional `derive` key. `text` is the message or comment body, cut to 4096
bytes on a UTF-8 code point boundary. Before it stores a digest, the store
removes every NUL character from the digest's strings, because Postgres
rejects NUL in `text` and `jsonb`.

## Part D: The tool

*Depends on: Part C.*

```ts
wait_for_event({
  subject: string,         // URL or subject (A1, A5)
  on: Clause[],            // 1 to 8
  once?: boolean,          // default true
  reason: string,          // 1 to 200 characters
  max_hours: number,       // 1 to timerMaxHours
  min_interval_seconds?: number, // stream mode only; 30 to 3600
})
```

The tool is available in coding sessions, child sessions, and assistant
sessions. A workflow run has no arm path, so the tool refuses there with R9.

### D1. Arm checks

The tool runs these checks in order. Each refusal MUST use the text below.

| Id | Condition | Refusal text |
|---|---|---|
| R1 | The subject does not parse. | `[wait_for_event] <input> is not a supported subject. Give a GitHub pull request, issue, commit, or repository URL, a Slack message permalink, or a Linear issue or team URL.` |
| R2 | The GitHub App installation does not cover the repository. | `[wait_for_event] The GitHub App installation does not cover <owner>/<repo>. Install the app on that repository, then wait again.` |
| R3 | The session's resolved native credential cannot read the subject. | `[wait_for_event] This session cannot read <subject>. Connect an account that can, or ask an admin to grant the app access.` |
| R4 | Slack: the bot is not a member of the channel. | `[wait_for_event] Valet is not in <#channel>, so it does not receive its messages. Invite @Valet to the channel, then wait again.` |
| R5 | A clause key is in no catalog, or its service differs from the subject's. | `[wait_for_event] <key> is not an event key for <service>. Call workflows.list_event_types for the keys.` |
| R6 | The thread already receives this Slack thread's replies through a follow. | `[wait_for_event] This thread already receives replies from that Slack thread. No wait is needed.` |
| R7 | The service is not connected for the org. | `[wait_for_event] <Service> is not connected for this organization. Connect it in Settings, Integrations.` |
| R8 | The thread is at `wakeupsPerSession`. | The existing `[wakeups_limit]` text. |
| R9 | The session is a workflow run. | `[wait_for_event] Workflow runs cannot wait for events. Use a workflow trigger instead.` |

R3 is the visibility rule (INV-E1). The tool gets the session's native
credential from the host credential resolver. Then it reads the subject
once: the repository or pull request on GitHub, `conversations.info` on
Slack, the issue or team on Linear.

Until the native integration credential policy ships, Linear has no app
fallback for sessions. A session without a connected Linear credential
gets R3 for a Linear subject.

D1 errata (Task 11):

- Order. The checks run as R9, argument validation, R8, then R1, R5, R7,
  R2, R3, R4, R6. The checks with no provider call run first, and a
  disconnected service gets R7 before any read. The tool checks R9 and R8.
  The host's `checkArm` (`packages/api/src/events/waiter-arm.ts`) checks
  the rest.
- R2 checks owner coverage only: `installationResolvesFor` with
  `strictOwner`. R3's read with the session's credential catches a
  repository that the installation leaves out. An org with no GitHub App
  gets R7.
- R3 reads with the calling turn's credential provider
  (`ToolContext.credentials`). The tool passes it to `armEvent`, so the
  host credential resolver stays private to the host. A read that does not
  answer within 4 seconds, or that throws, gets R3.
- R3 for Slack: a team or org session may wait on public channels only.
  A personal session uses its owner's channel visibility. These are the
  match-time rules of Part E, step 4. A canonical Slack subject from
  another workspace gets R3.
- R4 reads `is_member` with the org's bot token, because R4 is about
  the bot. The read with the session's credential decides only R3.
- R4 also covers a channel that `conversations.info` reports as
  `channel_not_found`, because the bot cannot see a private channel it is
  not in. The text names `<#C…>` when Slack gives no channel name.
- R3 for Linear needs the session's own Linear credential. The org's
  app-actor token (`grant = client_credentials`) does not count.
- R5 also refuses `github.pull_request.checks_completed` unless the
  subject is a pull request: `[wait_for_event] <key> needs a pull request
  subject. Pass the pull request URL.` An issue number gets the same text
  after R3's read.
- R1 also refuses a GitHub owner alone (`github:acme`). The tool supports
  repository, pull request, issue, and commit subjects.
- `self` at arm holds the owner's linked external id for the service, the
  actor id behind the session's resolved credential (GitHub `/user`, Slack
  `auth.test`, Linear `viewer`), and the app actor id (the GitHub App bot
  user, the Slack `botUserId`, the Linear app actor). Each lookup has its
  own time limit. A lookup that fails or times out is left out, and the
  other ids stay.
- Only `armEvent` creates an event waiter. The seam's generic `create`
  refuses `kind: "event"`, so every event waiter passes the arm checks.
- `min_interval_seconds` is an integer from 30 to 3600. It is refused in
  once mode, including the default `once: true`. The row stores it as
  `minIntervalMs`.

### D2. Result text

`waiting <id> on <subject> for <clause list> until <deadline ISO>. End your
turn now; an event.matched signal starts your next turn.`

`wakeup_list` lists event waiters with their subject and clause count.
`wakeup_cancel` cancels them. `process_read` refuses them with
`[process_read] <id> is an event waiter and has no log.`

## Part E: Matching

*Depends on: Part C.*

`ingestEvent` runs the matcher after normalization. It MUST run before the
step that returns early for an event that no subscription matched.

1. `findEventWaiters(event.subjects)`.
2. For each candidate, keep it only when the session's org equals the
   event's org.
3. Evaluate the clauses. A clause matches when all of these hold:
   - the key glob matches the event key, or the clause key is a derived key
     whose `sources` match the event key;
   - `status`, when set, contains the event's status;
   - `from_status`, when set, contains the previous status;
   - `actor`, when set, equals the actor login or external id;
   - `bots` is unset or true, or the actor is no bot;
   - `include_self` is true, or the actor id is outside `self`.
4. Slack only: re-check the arm-time channel visibility decision against the
   cached channel privacy. Drop the candidate when it no longer holds.
5. `appendEventMatch` with the digest. A derived clause's digest carries
   `derive: <derived key>`.
6. Nudge the WakeWatcher.

Mention rule: a `slack.message` event whose text contains `<@bot user id>`
MUST NOT match an event waiter when an enabled subscription naming
`slack.app_mention` matches that channel. The matcher evaluates that
subscription with the existing subscription matcher against the same
payload. The mention then reaches the agent once, through the subscription.
7. Append a receipt stage `waiter_match` with the count of waiters that
   matched. The stage holds metadata only.

The tool fixes `self` at arm. It holds three ids for the subject's
service: the session owner's linked external id, the external id of a
shared personal credential that the session resolves, and the app's actor id.

`from_status` resolution: when a candidate clause names `from_status` and
the event has no `previousStatus`, the matcher calls the plugin's status
resolver. The Linear resolver maps a workflow state id to its type through
a per-team cache of workflow states (TTL one hour).

A thrown error in the matcher MUST NOT change the subscription outcome or
fail ingestion. The matcher increments
`valet_wakeups_event_match_failed_total` and logs the error.

### E1. Matcher vectors

| Clause | Event | Result |
|---|---|---|
| `{ key: "github.check_run.*" }` | `github.check_run.completed` | match |
| `{ key: "github.check_run.completed", status: ["failure"] }` | status `success` | no match |
| `{ key: "slack.message", bots: false }` | bot actor | no match |
| `{ key: "slack.message" }` | actor id in `self` | no match |
| `{ key: "slack.message", include_self: true }` | actor id in `self` | match |
| `{ key: "linear.issue.update", status: ["triage"], from_status: ["backlog"] }` | title-only update, state `triage` | no match |
| `{ key: "github.pull_request.checks_completed" }` | `github.check_run.completed` | match, digest marked `derive` |
| any clause | event org differs from session org | no match |

## Part F: Delivery and lifecycle

*Depends on: Parts B, C, and E.*

The WakeWatcher processes running event waiters with a non-empty
`event_buffer`.

1. For each digest marked `derive`, call the plugin's `derive`. Replace the
   digest with the derived event's digest. On `null`, drop it. Process at
   most one derive call per waiter per tick for the latest source digest.
   That call answers for the older digests with the same derive key, so the
   WakeWatcher removes them with it. One deadline of 20 seconds bounds the
   call. A call past it counts as an error, and the digests stay.
2. Once mode: CAS the row from `running` to `done` with cause `fired`. Then
   submit one `event.matched` signal with the first digest. List any other
   buffered digests under `Also matched`.
3. Stream mode: CAS the row's event count, remove the digests it will send
   with `removeEventMatches`, then submit one `event.matched` signal with
   them. The first signal goes out at once. Later signals
   follow the waiter's `minIntervalMs` when set, else `watchMinIntervalMs`,
   and `watchMaxEventsPerHour`, through the same
   rate code as `watch`. Each `event.matched` signal counts once toward the
   cap, however many digests it lists. When the hourly cap trips, the row
   ends with cause `rate`. If the removal fails after the CAS, the
   WakeWatcher rolls the CAS back and sends nothing, so the next tick sends
   the digests once and counts them once.
5. Past `deadlineAt`, stream mode sends the digests it still holds in one
   last `event.matched` signal. That signal skips the min interval and
   counts once in the rate window. Then the row ends with cause `deadline`.
4. The dispatch id is `wakeup:<id>:event:<eventCount>`. The terminal
   dispatch id is `wakeup:<id>:terminal`.

Signal body, one block per digest:

```
github.check_run.completed · failure · by ada
acme/lean-proofs: check_run completed (test)
https://github.com/acme/lean-proofs/runs/123
```

A digest with `text` adds the text after the URL.

`event.matched` attributes: `wakeupId`, `kind: event`, `subject`,
`matchCount`. `event.ended` attributes: `wakeupId`, `kind: event`,
`subject`, `cause`.

If the waiter's thread is gone, the signal goes to the session's main
thread without the digests. The body names the waiter id and tells the
agent to arm a new wait in an open thread.

### F1. Endings

| Cause | Signal | Body |
|---|---|---|
| `fired` (once mode) | `event.matched` | the digest |
| `deadline`, no match delivered | `event.ended` | `No matching event arrived within <n> hours. Check the subject's state before you wait again.` |
| `deadline`, `<m>` matches delivered (stream mode, including the last flush) | `event.ended` | `The wait reached its <n>-hour deadline after <m> matched events. Arm a new wait to keep watching.` (`event` when `<m>` is 1) |
| `cancelled` by a person | `event.ended` | the human-cancel text of the wakeups spec |
| `cancelled` by the agent | none | |
| `rate` | `event.ended` | `Ended after <n> events in an hour. Narrow the clauses, then wait again.` `<n>` is the signal count in the rate window. |

### F2. Background-work rule

An event waiter follows the rule for timers:

- Pause and sandbox replace leave it running.
- Owner move, profile change, and thread archive stop it through the 409
  and `force` contract, with the human-cancel signal.
- In a child session, an event waiter whose deadline falls within the child
  timer bound keeps the child unsettled.
- Event waiters on hidden threads are counted and never named.

## Part G: Subscriptions

*Depends on: Part A.*

Every catalog entry gains the implicit filter field `subject`. Its value
matches when any of the event's subjects equals it (`eq`) or starts with it
(`prefix`). Derived keys stay unavailable to subscriptions (see Non-goals).

## Part H: Web

*Depends on: Part F.*

The composer status line, the thread context card's Background work
section, and the thread-list line come from the wakeups spec. This part
adds the event kind to each:

- Composer line: an event icon and the text `waiting on <subject label>`.
- Card section: the subject as a link, the clause count, and the deadline.
- Thread list: `Waiting on <subject label>` on the thread's row.
- Signal cards: an `event.matched` card shows the key, a status chip, the
  actor, the summary, and the link. A stream signal lists each digest.

Each plugin exports `subjectLabel(subject)` and `subjectUrl(subject)`. The
web shows a link only when `subjectUrl` returns one.

## Part I: Agent guidance

The coding prompt's Background work section and the assistant persona gain
this sentence:

> To wait for something in GitHub, Slack, or Linear, such as CI, a review,
> a reply, or a new ticket, call `wait_for_event` with its URL and end your
> turn. Do not poll with `watch` or `sleep`. Arm it before the action that
> triggers it, for example before `git push`.

Coding and assistant prompts also carry the thread link when the
deployment has a public URL:

> This thread's link is <thread link>. Post it when you announce work in a
> channel, so people can follow the thread.

The tool description carries four recipes: CI (Scenario A), a Slack reply
(Scenario B), a Linear triage shift (Scenario C), and a reply on a Linear
issue. It states that standing, unbounded watching is a subscription, so an
agent asked to "always" watch something proposes one.

## Part J: Observability

| Metric | Type | Labels |
|---|---|---|
| `valet_wakeups_total` | counter | `kind="event"`, `cause` (existing) |
| `valet_wakeups_active` | gauge | `kind="event"` (existing) |
| `valet_event_waiter_matches_total` | counter | `service` |
| `valet_event_waiter_derive_total` | counter | `key`, `result` (`event`, `null`, `error`) |
| `valet_wakeups_event_match_failed_total` | counter | |
| `valet_event_waiter_buffer_full_total` | counter | |

Alert rule: any increase of `valet_wakeups_event_match_failed_total` in an
hour, with the first-series pattern of the wakeups spec.

## Invariants

- **INV-E1 An event waiter delivers only events its session could read.**
  Mechanism: arm refuses unless R3 passes with the session's resolved native
  credential; the matcher drops a candidate from another org before it
  evaluates clauses; Slack re-checks at match time. Vectors: D1, E1 org row.
- **INV-E2 Waiter matching never changes a subscription outcome or fails
  ingestion.** Mechanism: the matcher runs inside its own error boundary;
  an ingest test asserts identical receipts with a throwing matcher.
- **INV-E3 An event waiter holds no lease.** Mechanism: the event create
  path has no `createLease` call; vector A1 asserts `leases` is empty.
- **INV-E4 A matched event reaches a thread at most once per waiter.**
  Mechanism: `appendEventMatch` refuses a `dedupeKey` present in
  `event_buffer` or `event_seen`; dispatch ids are per event count. Vector: a provider redelivery yields one signal.
- **INV-E5 Every ending except an agent cancel sends exactly one terminal
  signal.** Mechanism: the existing single-statement `transitionWakeup` CAS.
- **INV-E6 Matching cost is independent of the number of waiters.**
  Mechanism: the store has no method that lists all running event waiters;
  a test greps the store interface for one.
- **INV-E7 A digest's text is at most 4096 bytes, and delivery removes the
  digests it sent.** Mechanism: `appendEventMatch` cuts the text; delivery
  removes delivered digests by `dedupeKey` with `removeEventMatches`.
- **INV-E8 Events caused by self never wake an agent unless a clause sets
  `include_self`.** Mechanism: the matcher compares actor ids to `self`;
  vectors C5 and E1.
- **INV-E9 A derive call runs only for a waiter that names the derived
  key.** Mechanism: only the WakeWatcher calls `derive`, and only for a
  digest marked `derive`. Vector: zero fixture API calls when no waiter
  names the key.

## Testing

- Table tests for A5, A6, B2, and E1.
- Store conformance for `findEventWaiters` and `appendEventMatch` on PGlite
  and the in-memory store.
- Ingest tests: a match with no subscription, a throwing matcher (INV-E2),
  and visibility drops.
- WakeWatcher tests: once and stream modes, the rate cap, every ending in
  F1, and a removal that fails after the CAS (one signal, counted once in the rate window, on the next tick).
- Arm-check tests for R1 to R8.
- Background-work tests for each F2 rule.
- Web tests for each Part H element, including live rendering.
- One integration test per acceptance scenario.
- One local Kubernetes run: Scenario A with the session's sandbox
  hibernated through steps A2 to A5.
- `make e2e` clean before the pull request.

## Non-goals (normative boundary)

A v1 implementation MUST NOT ship these under this spec.

| Excluded | Why | Re-entry seam |
|---|---|---|
| Linear actions through the app identity | Policy change for all native integrations | The native integration credential policy spec and its `linear:app` credential |
| Derived events for subscriptions | The dispatcher has no derive step yet | `DerivedEventDef.derive`, called from the dispatcher |
| Lookback ("did it already happen") | Needs a store of recent events | A `since` argument on `wait_for_event` |
| Fork pull request subjects on check events | Needs one API call per event | GitHub normalizer enrichment |
| Workflow `waitForEvent` node | Workflows have parked runs | The `signal` subscription target |
| Per-event visibility re-checks for GitHub and Linear | One provider call per event | Run D1's R3 read in the matcher |
| More than one subject per waiter | No scenario needs it | The `subjects` column is already an array |
| Org-visible threads from subscriptions | Widens thread sharing (#869) to team threads, a policy decision | A `thread_share` option on the subscription target |
| Fork a thread into a personal workspace | Needs a transcript-prefix copy and a fork record | A fork action on a message, in the web and as a Slack shortcut |

## Rollout order

1. Engine: `NormalizedEvent` fields, `DerivedEventDef`, the `event` kind,
   columns, store methods, and conformance.
2. Plugins: GitHub, Slack, and Linear mappings, URL parsing, labels, and the
   GitHub derived key.
3. api: the matcher in `ingestEvent`, the tool and arm checks, WakeWatcher
   delivery, and `SCHEMA_REPAIRS`.
4. Web: Part H.
5. Prompts, tool descriptions, and the `subject` subscription filter.

Deployment: the GitHub App MUST subscribe to `check_run`, `check_suite`,
`workflow_run`, and `status`. The Slack app MUST subscribe to
`message.channels`, `message.groups`, and `message.im`. The Linear app
webhook MUST include `Issue` and `Comment`. Add the Part J alert rule.

## Deviations

- B1 step 2 reads at most 20 pages of 100 check runs. If a head SHA has
  more, `derive` fails with an error that names `github.check_suite.completed`
  as the alternative. A silent cut could report a false `success`.
- The subscription editors' catalogs (`GET /api/events/catalog` and
  `GET /api/workflows/trigger-catalog`) leave out derived keys, because
  subscriptions refuse them (Part G). `workflows.list_event_types` lists them
  with `derived: true`.
- Part F step 3 removes the digests before it submits the signal, not
  after. A crash between the two steps then loses one signal instead of
  sending it twice, which keeps INV-E4. A failed removal rolls the CAS back
  and stops the tick before the submit, so the digests go out once on the
  next tick.
