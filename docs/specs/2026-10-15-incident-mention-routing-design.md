# Incident mention routing

Date: 2026-10-15. Status: proposed.

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
  of the mention.
- **target owner**: the subscription owner the dispatcher delivers the
  mention for (`sub.ownerType`, `sub.ownerId`).

## Acceptance scenario (normative)

Universe: Scenario E of the event wakeups spec, after step E2. Thread
`t-inc` holds a watching waiter on `slack:T001/C900`. The team has an
enabled `slack.app_mention` subscription with `follow: true`.

| Step | Action | Expected observation |
|---|---|---|
| M1 | Fixture sends a top-level message `<@U-BOT> status?` from `U002` in `C900`, and its `app_mention` event. | `t-inc` receives exactly one turn for the post, from the `slack.app_mention` subscription. No new assistant thread exists. |
| M2 | Inspect `followed_threads`. | No row exists for that message's Slack thread. |
| M3 | Fixture sends a threaded reply under the mention from `U003`. | `t-inc` receives the reply once, through the event waiter. |
| M4 | The agent replies in its turn for M1. | The reply posts in the mention's Slack thread (the signal's origin route). |
| M5 | The agent cancels the watching waiter. Fixture sends another top-level mention in `C900`. | The mention opens a new assistant thread keyed by the message, as before this spec, and the dispatcher binds a follow. |

Pass criterion: all steps, in one run, from a clean start.

## Part A: Routing

*Conformance: dispatcher.*

1. Before it delivers a `slack.app_mention` to an assistant, the
   dispatcher MUST look up watching waiters with
   `findEventWaiters(["slack:<team>/<channel>"])`.
2. It MUST keep only waiters whose session belongs to the event's org and
   whose session owner equals the target owner.
3. It MUST keep only stream waiters (`eventMatch.once === false`) whose
   `subjects` contain the channel subject itself. A waiter on a thread
   subject alone does not watch the channel.
4. When one or more remain, the dispatcher MUST deliver the mention with an
   explicit target `{ sessionId, threadId }` of the newest remaining waiter
   (largest `createdAt`). The signal keeps its Slack origin, so a reply
   posts in the mention's Slack thread.
5. When none remain, the dispatcher MUST keep today's behavior.

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

## Invariants

- **INV-M1 A routed mention reaches the watching thread once.**
  Mechanism: the event waiter skips the mention by the mention rule, and
  the subscription delivers it once with the explicit target. Vector: M1.
- **INV-M2 A routed mention binds no follow.** Mechanism: the dispatcher
  skips `upsertFollowedThread` when Part A routed the delivery. Vector: M2.
- **INV-M3 Routing never crosses owners or orgs.** Mechanism: Part A step 2
  filters candidates before the target is chosen. Vector: a watching waiter
  of another team in the same channel is never chosen.

## Testing

- Dispatcher unit tests for Part A steps 1 to 5 and Part B.
- INV-M3 vector with two teams watching the same channel.
- The acceptance scenario as an integration test, extending
  `packages/api/src/integration/event-wakeups.test.ts` Scenario E.

## Non-goals (normative boundary)

| Excluded | Why | Re-entry seam |
|---|---|---|
| Routing for subscriptions other than `slack.app_mention` | Message subscriptions already target a channel thread | Part A, for another event key |
| Routing to once-mode waiters | A once waiter waits for one reply, not a channel | Part A step 3 |
| Merging an existing mention thread into the watching thread | Threads have no merge operation | A thread fork or merge spec |

## Deviations

None yet.
