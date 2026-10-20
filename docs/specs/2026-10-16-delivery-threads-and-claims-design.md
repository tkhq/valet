# Delivery threads and claims

Date: 2026-10-16. Status: implemented (Parts A, B, D, E); Part C pending.

Depends on: `2026-10-15-event-wakeups-design.md` (event waiters, digests,
Scenario E), `2026-07-20-event-system-design.md` (subscriptions, the
dispatcher, followed threads), `2026-08-15-workflow-triggers-ui-design.md`
(schedules and their assistant prompts).

Supersedes: `2026-10-15-incident-mention-routing-design.md`. Its Part A
becomes the conversational leg of Part C here. Its acceptance scenario
survives as steps C2 to C7.

The user-facing words for these objects (presence, listener, routine,
place, appears as) are defined in `2026-10-16-presence-hub-design.md`. This
document uses the system words: event subscription, schedule, subject.

## Problem

Three places decide which assistant thread receives an event, and they do
not share an answer.

1. The dispatcher picks a thread by heuristic. A mention opens a thread
   keyed by its Slack post and binds a follow. A plain Slack message lands
   in one thread per channel. A human comment on a pull request that a
   thread opened continues in that thread. Everything else lands in one
   `events` thread per owner, and a schedule's prompt lands there too. The
   person who wrote the rule cannot change any of this.
2. The event waiter matcher delivers a digest to the thread that armed the
   waiter.
3. The two consult each other only for Slack mentions: the mention rule and
   the incident routing spec. For every other service, an event that a
   waiter accepts and a subscription matches reaches two threads. A review
   on a pull request the agent is waiting on wakes the waiting thread and
   the `events` thread.

## Thesis

A rule names where its deliveries land: a new thread each time, one thread
per subject, one thread for the rule, or an existing thread. Above that
policy, two things win in order: a conversation that already has a thread,
and a thread whose waiter has claimed the event. Per owner, one event
reaches one assistant thread, and it reaches it once.

## Requirement language

MUST, MUST NOT, SHOULD, and MAY follow RFC 2119. A sentence without one of
these words is informative.

## Terminology

- **owner**: a user, a team, or an org; the party a subscription, schedule,
  or session belongs to.
- **assistant delivery**: a subscription delivery with an assistant
  target, or a schedule firing with an assistant prompt. Workflow and
  `signal` targets are not assistant deliveries. The stored discriminator
  for an assistant target is still the legacy value `orchestrator` until
  the Presence hub spec Part H renames it.
- **thread policy**: the rule's choice of destination thread. Modes: `new`,
  `subject`, `own`, `existing`.
- **natural subject**: the subject a plugin names as the grouping unit for
  an event: a Slack channel, a GitHub pull request or issue (else the
  repository), a Linear issue (else the team).
- **conversation binding**: a thread that an external conversation already
  maps to: a `followed_threads` row for a Slack thread, or the thread that
  opened a pull request (`threadForPullRequest`).
- **conversational event**: an event the dispatcher delivers as an inbound
  message with a reply route: a Slack event with a channel origin (mention,
  reply in a followed thread, direct message), or a human comment or review
  on a pull request that this owner's thread opened. Every other event is
  **ambient**.
- **waiter**: a running event waiter (event wakeups spec Part C).
- **claim**: a waiter of the delivery's owner whose clauses accept the event
  and whose thread can receive a delivery.
- **digest**: the `event.matched` payload a waiter appends (event wakeups
  spec Part E).
- **destination**: the resolved answer for one assistant delivery: a thread
  key with a title, an explicit `{ sessionId, threadId }` target, or a skip
  with a reason.

## Acceptance scenarios (normative)

Universe for Scenario T: org `acme`. User `u-001` owns a personal
assistant. GitHub repository `acme/api` with pull requests `#12`, `#13`,
`#14`. Linear team `ENG` with issues `ENG-42`, `ENG-43`. Slack team `T001`,
channel `C900`. Rules are created through the REST API with the policies
named in each step.

| Step | Action | Expected observation |
|---|---|---|
| T1 | Create R1: `github.pull_request_review` and `github.check_run.completed` on `acme/api`, assistant target, policy `subject`. A review on `#12` arrives. | One thread with key `subject:github:acme/api#12` and title `acme/api#12` exists in `u-001`'s assistant and holds the delivery. |
| T2 | A check run completes on `#12`. | The same thread holds the second delivery. No new thread exists. |
| T3 | A review on `#13` arrives. | A second thread, `acme/api#13`, holds it. |
| T4 | Create R3: `linear.issue.update` for team `ENG`, policy `own`, name `ENG triage`. Updates arrive on `ENG-42` and `ENG-43`. | One thread with key `sub:<R3>` and title `ENG triage` holds both deliveries. |
| T5 | Create R4: `github.check_run.completed` with status `failure` on `acme/api`, policy `new`. Two failures arrive. The dispatcher retries the second delivery once. | Two threads exist, each titled by its event summary. The retry lands in the second thread. No third thread exists. |
| T6 | `u-001` creates a thread titled `Platform CI` and patches R4 to `existing` with that thread. A failure arrives. | `Platform CI` holds the delivery. |
| T7 | `u-001` archives `Platform CI`. A failure arrives. | The delivery dead-letters with `Pick another thread for this rule in Presence.` R4 reports the problem. No thread is created or reopened. |
| T8 | `u-001` archives the `ENG triage` thread. An update on `ENG-42` arrives. | The `ENG triage` thread reopens and holds the delivery. |
| T9 | Create schedule S1 with a prompt, policy `own`, name `Morning summary`. It fires twice. | One thread with key `schedule:<S1>` and title `Morning summary` holds both prompts. |
| T10 | Create R2: `slack.app_mention` in `C900`, policy `new`, `follow: true`. A mention arrives in a new Slack thread `X`. A reply arrives in `X`. | The mention opens one thread with key `sub:<R2>:<deliveryId>`, and a `followed_threads` row binds `X` to it. The reply lands in that thread through the binding. |
| T11 | Patch R2 to `existing` with a thread from another user. | The patch is refused with `This thread belongs to another owner. Pick a thread in your workspace.` |

Universe for Scenario C: the event wakeups spec's Scenario E universe after
step E2. Team `sre` owns thread `t-inc`, which holds a stream waiter on
`slack:T001/C900` with clause `slack.message`, `bots: false`,
`min_interval_seconds: 30`. Team rules: M (`slack.app_mention` in `C900`,
policy `new`, `follow: true`) and P (`slack.message` in `C900`, policy
`subject`). `U001` links to a team member; `U002` links to no Valet user.
Thread `t-s` is another `sre` thread bound by a follow to Slack thread
`X2` before E2. User `u-001` owns thread `t-pr`, which armed a stream
waiter on `github:acme/api#12` with clauses `github.pull_request_review`
and `github.pull_request.checks_completed`, and R1 from Scenario T exists.
`t-pr` also opened pull request `#14` through Valet and holds a second
waiter on `github:acme/api#14`. Rule R5 (`github.issue_comment` on
`acme/api`, policy `subject`) and workflow rule W
(`github.pull_request_review` on `acme/api`, workflow target) exist for
`u-001`. Thread `t-tri` (u-001) holds a stream waiter on `linear:ENG-42`,
and R3 exists.

| Step | Action | Expected observation |
|---|---|---|
| C1 | `U001` posts a top-level message in `C900` with no mention. | `t-inc` receives one `event.matched` digest. P's delivery is `skipped` with `claimed by thread t-inc`. No thread with key `subject:slack:T001/C900` exists. |
| C2 | `U001` posts `<@U-BOT> status?` in `C900`, Slack thread `X`. | M delivers the mention to `t-inc` as an inbound message with the Slack origin. `t-inc` receives exactly one turn for it and no digest. A `followed_threads` row binds `X` to `t-inc`. |
| C3 | `U003` replies in `X`. | `t-inc` receives the reply once, through the binding. The waiter appends no digest. |
| C4 | `U002` posts `<@U-BOT> is the replica healthy?` in `C900`. | The team gate refuses `U002`. `t-inc` receives one digest. No `slack.app_mention` delivery exists. |
| C5 | `U001` posts a mention in `X2`. | `t-s` receives it through its binding. `t-inc` receives one digest for the channel message. |
| C6 | Team `platform` has a mention rule on `C900` and no waiter. A user linked to both teams posts a mention in a new Slack thread. | `platform`'s rule opens a `platform` thread. M delivers to `t-inc`. Each team receives the mention once. |
| C7 | The agent in `t-inc` calls `wakeup_cancel`. `U001` posts a top-level message. | P delivers to a new thread with key `subject:slack:T001/C900` and title `#incidents`. |
| C8 | A human review lands on `#12`. | `t-pr` receives one digest. R1's delivery is `skipped` with `claimed by thread t-pr`. No `acme/api#12` subject thread is created for this delivery. |
| C9 | A human comment lands on `#14`. | R5 delivers it to `t-pr` as an inbound message, through the pull request binding. `t-pr`'s waiter appends no digest. |
| C10 | A check run completes on `#14`. | `t-pr` receives one digest. R1's delivery is `skipped` with `claimed by thread t-pr`. |
| C11 | An update lands on `ENG-42`. | `t-tri` receives one digest. R3's delivery is `skipped` with `claimed by thread t-tri`. |
| C12 | A review lands on `#12` while `t-pr` waits. | W starts a workflow run. `t-pr` receives its digest. |

Pass criterion: all steps of both scenarios, in one run each, from a clean
start.

## Part A: Thread policy

*Conformance: shared types, api.*

1. `@valet/shared` MUST export one type:

   ```ts
   type AssistantThreadPolicy =
     | { mode: "new" }
     | { mode: "subject" }
     | { mode: "own" }
     | { mode: "existing"; sessionId: string; threadId: string };
   ```

2. The assistant subscription target (`EventSubscriptionTargetWire`,
   stored kind `orchestrator`) and the schedule row gain `thread?:
   AssistantThreadPolicy`. The subscription stores it inside the `target`
   JSON. The schedule stores it in a new nullable `thread_policy` jsonb
   column on `workflow_schedules`, edited in place in `0000_app.sql`, with
   a matching `SCHEMA_REPAIRS` entry.
3. An absent policy MUST read as `new` for a delivery with a channel origin,
   else `own`. No backfill runs. `readThreadPolicy` stays shape-only; the
   dispatcher applies this default per delivery (`deliveryThreadPolicy`).
4. `subject` MUST be refused for a schedule, and for an event subscription
   whose keys name no natural subject (Part D). The refusal MUST say
   `This rule's events have no subject to group by. Pick another thread
   option.`
5. `existing` MUST be validated at write time: the thread MUST exist, MUST
   belong to a live assistant or execution session of the rule's owner, and
   MUST NOT be archived. The person who writes the policy MUST be able to
   read the thread, by the gate the thread read paths use
   (`threadVisibility`): a team thread with content from a private Slack
   channel needs membership in that channel. A team or org rule MUST NOT
   pin one person's thread (a helper or workflow editor key). The refusal
   for another owner's thread, a missing thread, and a thread the writer
   cannot read is the same text, `This thread belongs to another owner.
   Pick a thread in your workspace.`, so the answer never shows that the
   thread exists. The refusal for an archived thread is `This thread is
   archived. Pick an open thread.`
6. `validateValetPlugin` is unaffected. The policy is rule configuration.

## Part B: Destination resolution

*Depends on: Part A. Conformance: api.*

The resolver is a pure function:

```
resolveDestination(input) -> Destination
input = {
  owner, rule: { id, kind: "subscription" | "schedule", name, policy, follow },
  event?: { id, deliveryId, key, summary, subjects, naturalSubject, conversational },
  fireAt?: number,
  binding: { sessionId, threadId } | null,     // conversation binding
  claim: { sessionId, threadId, waiterId } | null,
}
Destination =
  | { kind: "target"; sessionId; threadId; reason }
  | { kind: "key"; key; title; reason }
  | { kind: "skip"; reason }
```

1. Precedence MUST be: binding, then claim, then policy.
   - `binding` present → `target` with reason `conversation:follow` or
     `conversation:pull_request`.
   - else `claim` present and the event is conversational → `target` with
     reason `claim:redirect`.
   - else `claim` present and the event is ambient → `skip` with reason
     `claimed by thread <threadId>`.
   - else the policy decides.
2. Policy keys and titles:

   | mode | key | title |
   |---|---|---|
   | `new`, subscription | `sub:<ruleId>:<deliveryId>` | the event summary, at most 80 characters |
   | `new`, schedule | `schedule:<ruleId>:<fireAt>` | the schedule name and the fire date |
   | `subject` | `subject:<naturalSubject>` | the plugin's subject label (Part D) |
   | `own`, subscription | `sub:<ruleId>` | the rule name |
   | `own`, schedule | `schedule:<ruleId>` | the schedule name |
   | `existing` | the stored target | unchanged |

   `subject` keys carry no rule id: every rule of one owner that groups by
   the same subject shares one thread.
3. A `key` destination MUST resolve to a thread only at delivery time, with
   `ensureFreshThread`, which gains a `title` for a thread it creates. A
   `skip` and a dead-letter MUST create no thread.
4. An archived thread found by key (`own`, `subject`) MUST reopen on
   delivery. A `target` destination from `existing` whose thread is
   archived, deleted, or outside the owner's live runtime MUST dead-letter
   with `Pick another thread for this rule in Presence.` and MUST NOT fall
   back to another mode.
5. A `follow: true` rule MUST bind the Slack thread to whichever thread the
   delivery landed in, as today. The binding then wins step 1 for later
   events in that Slack thread.
6. `EVENTS_THREAD_KEY` is removed. The dispatcher MUST NOT use
   `slackEventsThreadKey` as a destination; the function stays for the
   workflow attention audience keys that use it. The scheduler MUST pass
   its resolved destination to `deliverToAssistant` (today's
   `deliverToOrchestrator`, renamed with this part).

## Part C: Claims

*Depends on: Parts A and B, event wakeups Part E. Conformance: api.*

This part replaces the event wakeups spec's mention rule (Part E) and the
incident routing spec's Parts A and B.

1. Ingest MUST compute claims after the subscription match and the waiter
   clause evaluation, before it inserts deliveries. It computes them per
   matched assistant subscription with owner O. A claim candidate is a
   running waiter that meets all of these:
   - its session belongs to O and to the event's org;
   - its clauses accept the event (event wakeups Part E steps 2 to 4, with
     the Slack visibility check);
   - its thread passes `isDeliverableTarget`.
2. Ambient event, one or more candidates: every candidate appends its
   digest. The delivery's destination is `skip` with `claimed by thread
   <threadId>`, naming the newest candidate.
3. Conversational event, one or more candidates: the delivery's destination
   is `target` on the candidate with the most specific matching subject,
   newest on a tie. That candidate appends no digest. The other candidates
   append theirs.
4. A delivery whose binding wins (Part B step 1) still suppresses the digest
   of a candidate whose thread equals the binding's thread. Other candidates
   append theirs.
5. A once-mode waiter is a candidate. When it is the redirect target, the
   delivery counts as its match: the waiter ends as `matched` and sends its
   terminal signal (event wakeups INV-E5) after the inbound delivery.
6. Ingest MUST stamp each delivery's destination in a new nullable
   `destination` jsonb column on `event_deliveries`, edited in place in
   `0000_app.sql`, with a matching `SCHEMA_REPAIRS` entry. The dispatcher
   MUST execute the stamp. A retry reads the same stamp.
7. A delivery with no stamp (a row from before this spec, or a resolver
   failure) MUST resolve its destination at dispatch from the binding and
   the policy only. It MUST NOT consult waiters. This keeps the failure
   mode at duplication, never loss (INV-D6).
8. Slack sends a mention as two events, `slack.message` and
   `slack.app_mention`, in either order. Each ingest predicts the other
   half through the plugin's `conversationalTwin` (Part D).
   - At the `slack.message` ingest, a waiter appends no digest when an
     assistant subscription of its owner would deliver the
     `slack.app_mention` twin. The sender gate (`mentionSenderActor`)
     applies to that prediction.
   - At the `slack.app_mention` ingest, ingest evaluates the claim
     candidates against the `slack.message` twin.
9. Workflow and `signal` targets MUST NOT yield to a claim (INV-D7).
10. The event wakeups spec's INV-E2 is reworded: a failure in waiter
    matching or in claim resolution never changes a subscription outcome
    and never fails ingestion. A success may stamp a delivery.

## Part D: Plugin contract

*Conformance: engine types, plugin packages.*

`ValetPlugin` gains two optional hooks beside `derivedEvents`:

```ts
naturalSubject?(event: NormalizedEvent): { subject: string; label: string } | null;
conversationalTwin?(event: NormalizedEvent, identity: { botUserId?: string }): NormalizedEvent | null;
```

| Plugin | `naturalSubject` | `conversationalTwin` |
|---|---|---|
| Slack | the channel: `slack:<team>/<channel>`, label `#<name>` (the channel id when the name is unknown) | `slack.message` whose text mentions `botUserId` ↔ `slack.app_mention` |
| GitHub | the pull request or issue when the payload names one, else the repository; labels `acme/api#12`, `acme/api` | null |
| Linear | the issue when the payload names one, else the team; labels `ENG-42`, `ENG` | null |

A plugin without `naturalSubject` offers no `subject` mode (Part A step 4).
Subject labels are display text only; keys use the subject grammar from the
event wakeups spec Part A.

## Part E: Observability

*Conformance: api, web.*

1. Each assistant delivery's receipt stage `destination` MUST record the
   `Destination` with its reason. The stage holds ids and the reason, never
   payload text.
2. The delivery list MUST show `Delivered to <thread>` with a link,
   `Claimed by <thread>` with a link, or the dead-letter text.
3. Counter `valet_event_delivery_destination_total{reason}` with reason in
   `policy_new`, `policy_subject`, `policy_own`, `policy_existing`,
   `conversation_follow`, `conversation_pull_request`, `claim_redirect`,
   `claim_skip`, `pin_unavailable`. A rising `pin_unavailable` pages a
   person. No code repairs it. A schedule counts `pin_unavailable` once, on
   the fire that disables it. A manual fire and a replica that re-fires the
   same slot do not count again. The chart's Grafana rule
   `valet-event-delivery-pin-unavailable` (`deploy/chart/valet/alerts/events.yaml`)
   fires on the first increase.

## Invariants

- **INV-D1 One assistant delivery per (owner, event) lands in at most one
  thread, and no waiter in that thread appends a digest for it.**
  Mechanism: the pure resolver runs once per delivery at ingest and stamps
  the row. Digest suppression reads the same decision. Vectors: C1 to C3,
  C8 to C10.
- **INV-D2 A conversation binding wins over claims and policy.** Mechanism:
  precedence order in `resolveDestination`. Vectors: C3, C5, C9.
- **INV-D3 A skip or a dead-letter creates no thread.** Mechanism: key
  resolution runs at delivery, after the destination kind is known.
  Vectors: C1, C8, T7.
- **INV-D4 A retry never creates a second thread.** Mechanism: `new` keys
  derive from the delivery id or fire time; `existing` recovers the admitted
  dispatch by `event:<deliveryId>`. Vector: T5.
- **INV-D5 An `existing` policy delivers only inside the owner's live
  runtime.** Mechanism: write-time validation (Part A step 5) and
  `isDeliverableTarget` at delivery. Vectors: T7, T11.
- **INV-D6 A resolver failure causes duplication, never loss.** Mechanism:
  Part C step 7; a test injects a throwing resolver and asserts the delivery
  lands by policy and the waiter appends.
- **INV-D7 Workflow and `signal` targets never yield.** Mechanism: the
  resolver runs for assistant targets only. Vector: C12.
- **INV-D8 Every rule of one owner that groups by a subject shares one
  thread for it.** Mechanism: the `subject` key carries no rule id.
  Vectors: the unit tests `subject: two rules of one owner on one pull
  request share one key (INV-D8)` in `dispatcher.test.ts` and `subject: two
  rules on one pull request share one thread (INV-D8)` in
  `assistant-delivery.test.ts`.

## Testing

- Resolver vectors: one row per precedence branch and per policy mode, as
  data under `packages/api/src/events/destination.vectors.json`, run by one
  test.
- Scenario T and Scenario C as integration tests beside
  `event-wakeups.test.ts`. Scenario C steps C2 to C7 replace the incident
  routing integration steps.
- Plugin hook tests: `naturalSubject` and `conversationalTwin` per plugin.
- The event wakeups spec's Scenario E holds unchanged; E5's note points
  here.

## Non-goals (normative boundary)

| Excluded | Why | Re-entry seam |
|---|---|---|
| `channel_bindings.thread_key_template` | Channel ingress has its own policy and no rule object | `resolveDestination` can back the template later |
| Deduplicating one event across two owners | Each owner asked; both get it once | None planned |
| Parked workflow runs (`signal` targets) as claims | A different subsystem with its own wait semantics | Part C step 9 |
| GitHub or Linear bot mentions as conversational events | No inbound route exists for them today | Add an inbound route in the dispatcher; the resolver then treats them as conversational |
| Merging or forking threads | No thread merge operation exists | A thread fork spec |
| A `yieldToWaiters` knob per rule | No one would understand it; claims are the product rule | None planned |

## Deviations

- **Follows store their thread (Part B step 5).** A `followed_threads` row
  had no thread id, so the follow router could only route by the Slack
  thread key. The row gains nullable `session_id` and `thread_id`, written
  with the thread the binding mention landed in. The follow router and the
  dispatcher's binding read them. A row bound before the columns has nulls.
  For that row, both keep the Slack thread key (`slack:{channel}:{threadTs}`),
  and the dispatcher records reason `conversation_follow` with a `key`
  destination.
- **A dead follow binding is no binding.** If the bound thread fails
  `isDeliverableTarget`, the dispatcher passes no binding and the policy
  decides. A follow mention then re-binds the Slack thread to the new
  thread.
- **The follow router does not fall through.** A Slack reply that the
  follow router routes by a stored thread is refused when that thread is
  archived or deleted. The router throws its existing text and delivers
  nothing. Only the dispatcher falls through to the policy.
- **Part C is pending.** The claim vectors of Scenario C, which INV-D1,
  INV-D2, INV-D6, and INV-D7 name, and the `conversationalTwin` hook
  (Part D) arrive with Part C. Until then the only claim source is the
  incident mention routing waiter (`watching-waiter.ts`). The dispatcher
  asks it at dispatch for a `slack.app_mention`, and ingest stamps no
  destination.
- **Conversational test.** Until Part C lands, an event is conversational
  when it has a binding, when it is a `slack.app_mention`, or when it is a
  Slack direct message (`channel_type: "im"`).
- **Schedule pin.** A schedule whose `existing` pin cannot receive a
  delivery is disabled with `Pick another thread for this rule in
  Presence.`, the scheduler's existing handling for a broken schedule.
- **Receipt lookup.** The `destination` stage is appended to the receipt
  whose `event_id` matches the delivery's event. `event_receipts` gains the
  index `event_receipts_event` on `(org_id, event_id)`.
- **Explicit `own` or `existing` on a channel rule.** A rule that matches
  channel messages and sets `own` or `existing` puts several Slack
  conversations in one thread that can reply to each of them. This is the
  owner's choice. The default (Part A step 3) keys a thread per delivery
  (`sub:<rule>:<deliveryId>`). With `follow: true`, later replies in that
  Slack thread reach the same assistant thread through the binding.
  Without `follow`, each matching message opens its own thread.
- **Channel privacy follows content.** Every Slack-sourced assistant
  delivery records its channel on the thread it lands in, in engine thread
  `metadata.slackChannels`, and on a team execution's governing thread. A
  new thread gets the channel in the write that creates it, with its title.
  A thread that exists gets it before the title seed and the transcript
  fetch. So no title lists before its read gate holds. The
  read gate (`services/thread-access.ts`) collects channels from the key
  (`slack:`, `slack-events:`, and `subject:slack:<team>/<channel>`) and from
  `metadata.slackChannels` of the thread and the threads above it. A reader
  needs access to every private channel among them. Thread lists, thread
  routes, `thread_read`, attention routing, and the shared team views
  (briefings, outcomes) apply the same rule.
- **`slackEventsThreadKey` stays.** The dispatcher no longer uses it as a
  destination (Part B step 6). The workflow attention audience keys still
  use it, so the function stays for them.
- **Audience changes on an open child socket.** A socket rechecks a child
  thread's inherited channel audience on each frame when the parent thread
  is live in the same api process. A change on a grandparent thread, or on
  a parent thread that another api process holds, reaches the open child
  socket within the 5-minute recheck window, not at once.
- **Display default in the web.** The web shows a rule's default policy at
  the rule level: `new` when the rule follows Slack threads or its event
  keys carry Slack conversations, else `own`.
  The dispatcher decides per delivery (Part A step 3), so the shown default
  is an approximation for a rule that mixes channel and other events.
- **No `existing` option for org-owned rules in the web.** The thread
  picker lists the threads of a personal or team workspace. The runtime API
  has no org workspace key yet, so the web offers no `existing` option for
  an org-owned rule. The REST API still validates an `existing` pin for it.
- **Counter name.** The OpenTelemetry instrument is
  `valet_event_delivery_destination`. The Prometheus exporter adds the
  `_total` suffix.
- **Scenario T uses the GitHub catalog's real keys and filters.** The
  catalog has no bare `github.pull_request_review` key; R1 and W use
  `github.pull_request_review.submitted`. `github.check_run.completed` has
  no conclusion filter; R4 filters on the repository, and the test sends
  only failed check runs. The table's intent holds. A conclusion filter is
  a catalog addition, not a thread policy change.

## Errata to other specs

- Event wakeups Part E: the mention rule paragraph is replaced by a pointer
  to Part C here. INV-E2 is reworded as in Part C step 10. Scenario E5's
  note names this spec.
- Incident mention routing: superseded. Its header says so.
- Event system "Dispatcher": the thread heuristics paragraph points to Part
  B here.
- Workflow triggers UI: assistant-prompt schedules carry a thread policy
  (Part A step 2).

- **Unattended turns follow the policy's thread keys (2026-10-20).** dev-v2 #972 marks every turn a person did not type on a delivery thread as unattended (`isAutomatedDeliveryThread`, the host's `automatedThread`). The rule names the keys this policy writes: `sub:<rule>`, `sub:<rule>:<delivery>`, `schedule:<rule>`, `schedule:<rule>:<fire>`, and `subject:<natural subject>`, and keeps `events` and `slack-events:<channel>` for rows written before the policy. A pinned existing thread keeps its own key, so a person's thread is never marked.
