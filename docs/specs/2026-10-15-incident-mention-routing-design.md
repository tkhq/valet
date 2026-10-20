# Incident mention routing

Date: 2026-10-15. Status: superseded by `2026-10-16-delivery-threads-and-claims-design.md` (Part C). Accurate for the code on this branch until that spec ships.

Depends on: `2026-10-15-event-wakeups-design.md` (event waiters, the
mention rule, Scenario E) and `2026-07-20-event-system-design.md`
(subscriptions, the dispatcher, followed threads).

## Problem

In the incident flow, the assistant watches a channel with a stream event
waiter on the channel subject. A message that mentions Valet in that
channel follows a different path. The event waiter skips it by the mention
rule, and the `slack.app_mention` subscription delivers it to a new
assistant thread keyed by the message (`slack:<channel>:<ts>`). That
thread has no incident context, and the incident thread never sees the
mention. The dispatcher then binds a follow on the new Slack thread, so
later replies under the mention reach the new thread too, while the event
waiter also receives them as channel messages.

## Thesis

When an assistant already watches a channel, a mention in that channel
belongs to the watching thread. The dispatcher routes the mention there and
binds no follow, because the event waiter already covers the channel.

## Requirement language

MUST, MUST NOT, SHOULD, and MAY follow RFC 2119. A sentence without one of
these words is informative.

## Terminology

- **watching waiter**: a running event waiter in stream mode (`once:
  false`) whose `subjects` contain the channel subject `slack:<team>/<channel>`
  of the mention, and that receives every later message in the channel. It
  has a direct clause whose key matches `slack.message` with no `actor`,
  `status`, or `from_status` filter. Its `primarySubject`, when set, is the
  channel subject.
- **target owner**: the subscription owner the dispatcher delivers the
  mention for (`sub.ownerType`, `sub.ownerId`).

## Acceptance scenario (normative)

Universe: Scenario E of the event wakeups spec, after step E2. Thread
`t-inc` holds a watching waiter on `slack:T001/C900`. The team has an
enabled `slack.app_mention` subscription with `follow: true`.

| Step | Action | Expected observation |
|---|---|---|
| M1 | Fixture sends a top-level message `<@U-BOT> status?` from `U001` in `C900`, and its `app_mention` event. | `t-inc` receives exactly one turn for the post, from the `slack.app_mention` subscription. No new assistant thread exists. |
| M2 | Inspect `followed_threads`. | No row exists for that message's Slack thread. |
| M3 | Fixture sends a threaded reply under the mention from `U003`. | `t-inc` receives the reply once, through the event waiter. |
| M4 | The agent replies in its turn for M1. | The reply posts in the mention's Slack thread (the signal's origin route). |
| M5 | Fixture sends a top-level mention `<@U-BOT> is the replica healthy?` from `U002`, who links to no Valet user, in `C900`, and its `app_mention` event. | The team mention gate refuses `U002`. `t-inc` receives the post once, through the event waiter. No `slack.app_mention` delivery exists for it. |
| M6 | The agent cancels the watching waiter. Fixture sends another top-level mention in `C900`. | The mention opens a new assistant thread keyed by the message, as before this spec, and the dispatcher binds a follow. |

Pass criterion: all steps, in one run, from a clean start.

## Part A: Routing

*Conformance: dispatcher.*

1. When the mention is a reply in a Slack thread, the dispatcher MUST look
   up the follow binding of that Slack thread (`findFollowedThread`). When
   a binding of the target owner exists, the dispatcher MUST keep today's
   behavior (step 7). The follow keeps one Slack conversation in one
   assistant thread. A binding of another owner does not stop routing.
2. Before it delivers a `slack.app_mention` to an assistant, the
   dispatcher MUST look up watching waiters with
   `findEventWaiters(["slack:<team>/<channel>"])`.
3. It MUST keep only waiters whose session belongs to the event's org and
   whose session owner equals the target owner.
4. It MUST keep only stream waiters (`eventMatch.once === false`) whose
   `subjects` contain the channel subject itself, and that receive every
   later channel message (see Terminology). A waiter on a thread subject
   alone does not watch the channel. A waiter restricted to one sender
   would miss the later replies that Part B leaves to it.
5. It MUST then keep only waiters whose target would resolve for
   `deliverToAssistantThread`: the session names a live, non-archived
   assistant or execution of the target owner, and its thread is not
   archived. The dispatcher reuses `assistant-delivery.ts`'s own gate
   (`isDeliverableTarget`) for this check, so a candidate that would
   dead-letter there is never chosen here. A team-owned child or plain
   session carrying a stream waiter, or a waiter on an archived thread, does
   not qualify.
6. When one or more remain, the dispatcher MUST deliver the mention with an
   explicit target `{ sessionId, threadId }` of the newest remaining waiter
   (largest `createdAt`). The signal keeps its Slack origin, so a reply
   posts in the mention's Slack thread.
7. When none remain, the dispatcher MUST keep today's behavior.

## Part B: Follow binding

1. When Part A routed the mention to a watching waiter, the dispatcher
   MUST NOT bind a follow for the mention's Slack thread. The watching
   waiter receives the later replies as channel messages.
2. When Part A did not route the mention, the dispatcher MUST keep today's
   follow binding.

## Part C: Authorization

1. The mention passes the same sender gate as today before Part A runs.
   Routing never admits a sender the gate refuses.
2. The watching waiter's thread is in a session of the target owner, so the
   mention reaches no audience wider than today's delivery would.
3. The event waiter's mention rule MUST count a mention as covered only
   when the subscription's sender gate admits the sender. The rule reuses
   the dispatcher's gate (`mentionSenderActor` in `team-slack-gate.ts`).
   A mention that the gate refuses reaches the watching waiter as an
   ordinary channel message, with the waiter's own visibility check.
   Vector: M5.

## Invariants

- **INV-M1 A routed mention reaches the watching thread once.**
  Mechanism: the event waiter skips the mention by the mention rule, and
  the subscription delivers it once with the explicit target. Vector: M1.
- **INV-M2 A routed mention binds no follow.** Mechanism: the dispatcher
  skips `upsertFollowedThread` when Part A routed the delivery. Vector: M2.
- **INV-M3 Routing never crosses owners or orgs.** Mechanism: Part A step 3
  filters candidates before the target is chosen. Vector: a watching waiter
  of another team in the same channel is never chosen.

## Testing

- Dispatcher unit tests for Part A steps 1 to 7 and Part B.
- Waiter unit tests for the mention rule's sender gate (Part C step 3).
- INV-M3 vector with two teams watching the same channel.
- The acceptance scenario as an integration test, extending
  `packages/api/src/integration/event-wakeups.test.ts` Scenario E.

## Non-goals (normative boundary)

| Excluded | Why | Re-entry seam |
|---|---|---|
| Routing for subscriptions other than `slack.app_mention` | Message subscriptions already target a channel thread | Part A, for another event key |
| Routing to once-mode waiters | A once waiter waits for one reply, not a channel | Part A step 4 |
| Merging an existing mention thread into the watching thread | Threads have no merge operation | A thread fork or merge spec |
| Replies under a routed mention after the watching waiter ends | The routed mention bound no follow (Part B), so later replies under it reach no thread until the next mention | Part B: bind a follow for routed mentions when the waiter ends |
| Mentions that another owner's subscription admits in a watched channel | The event-wakeups mention rule skips a mention for every waiter when any admitting subscription covers it, so a waiter of a different owner never sees it | The event-wakeups mention rule, scoped per owner |

## Deviations

- M6's cancel runs in a real agent turn. A channel message in `C900`
  reaches `t-inc` through the event waiter, and the agent calls
  `wakeup_cancel` in that turn.
- The dispatcher reads the Slack team from the event row's channel
  subject, and falls back to the payload's `team`. When neither names a
  team, the dispatcher keeps today's behavior (Part A step 7).
- The `engineStore` dispatcher dependency is optional. A dispatcher built
  without it keeps today's behavior for every mention. Both production
  builders (`providers/node.ts`, `integration/_setup.ts`) wire it.
- Part A step 5's deliverability check extracts `isDeliverableTarget` out of
  `assistant-delivery.ts`, where `deliverToAssistantThread` already enforces
  the same resolve-and-not-archived gate for an explicit target. The
  dispatcher's `watchingTarget` wires it with the live `AppDb`, so
  `findWatchingWaiter` never chooses a candidate that delivery would refuse.
- Part A does not run the Slack channel visibility check that the waiter
  matcher runs (`slackStillVisible`). That check needs the Slack credential
  and identity providers, which the dispatcher does not hold. The routed
  thread belongs to the target owner, the same owner that today's delivery
  reaches, so the audience does not grow. If a team channel becomes
  private, the waiter stops receiving channel messages, but a mention can
  still route to its thread until the waiter ends.
- The dispatcher decides routing again on each delivery attempt. If the
  follow upsert throws after a delivery, the retry can see a waiter that
  armed in between and skip the follow, or the reverse. The dispatch id
  (`event:<delivery id>`) stays the same across attempts, so the mention
  is never submitted twice. The follow decision can differ from the first
  attempt's. This window is narrow, and the design accepts it.
