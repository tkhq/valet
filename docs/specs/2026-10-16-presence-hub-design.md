# Presence hub

Date: 2026-10-16. Status: proposed.

Depends on: `2026-10-16-delivery-threads-and-claims-design.md` (thread
policy, claims, natural subjects), `2026-08-15-workflow-triggers-ui-design.md`
(the aggregated triggers read, schedules REST), `2026-07-20-event-system-design.md`
(subscriptions REST, receipts, the Web UI section), `2026-08-17-team-workspace-ui-design.md`
(the workspace switcher scope).

Supersedes the "Tabbed hub" decision and the Triggers tab of the workflow
triggers UI spec, and the "Web UI" section of the event system spec.

## Problem

Two nav entries, "Automation" (`/workflows`: Workflows, Runs, Triggers,
Templates) and "Events" (`/events`: Channels, Log, Subscriptions), show the
same rows under four names: automation, subscription, trigger, rule. An
event-triggered workflow is a trigger on one page and a subscription on
the other. A schedule that prompts the assistant is created from the
Events wizard and listed only under Workflows. The new thread policy adds
one more concept with no obvious home. Users cannot answer the question
they have: where is Valet, and what does it do there?

## Thesis

One section, **Presence**, answers that question. It shows the places
Valet is in, what it listens for in each, how it appears there, which
threads are active there, and what it does on a schedule. Every object is
rendered as a sentence, and the UI uses five nouns.

## Requirement language

MUST, MUST NOT, SHOULD, and MAY follow RFC 2119. A sentence without one of
these words is informative.

## Terminology

The left column is the only vocabulary UI copy MAY use for these objects.
The right column is the system word, which stays in code, API paths, and
the system specs.

| User-facing | System |
|---|---|
| **Presence**: where Valet is and what it does there; the section | the hub |
| **place**: a Slack channel, a GitHub repository, pull request, or issue, a Linear team or issue. Copy names the concrete thing (`#incidents`, `acme/api#12`) and uses "place" only as a column header | subject |
| **listener**: when something happens in a place, Valet does something | event subscription with any target |
| **routine**: at a time, Valet does something | workflow schedule with any target |
| **appears as**: the display name and avatar Valet uses when it replies | the `presence` field on a target, renamed `appearance` (Part H) |
| **Runs in**: the form label for where deliveries land | thread policy |
| **active**: a thread currently waiting on this place | event waiter |
| **following**: a Slack thread whose replies reach a Valet thread | followed thread |
| **Activity**: what happened | events, deliveries, receipts |
| **workflow**, **run** | unchanged |

UI copy MUST NOT use "subscription", "trigger", "subject", "event waiter",
or "automation" for these objects. "Event" appears only inside Activity
and the event picker, where it names the thing that happened.

## Acceptance scenario (normative)

Universe: org `acme`, user `u-001` in the personal workspace, team `sre`
with team workspace scope. Slack channel `C900` is named `#incidents`.
Repository `acme/api` exists. The rules R1, R2, R4, S1 and threads from the
delivery threads spec Scenario T exist for `u-001`, plus thread `t-inc` from
Scenario C for `sre`.

| Step | Action | Expected observation |
|---|---|---|
| H1 | Open the app. | The nav shows one entry, **Presence**, and no "Events" or "Automation" entry. |
| H2 | Open `/presence`. | The Places tab is active. Groups: Slack, GitHub, Linear. GitHub lists `acme/api`; Slack lists `#incidents`. Each row names the count of listeners and whether a thread is active there. |
| H3 | Open `acme/api`. | The place page lists R1 as `Listens on acme/api for pull request reviews and completed checks · works in one thread per pull request`, and R4 as `Listens on acme/api for failed checks · works in the thread Platform CI`. It lists the subject threads `acme/api#12` and `acme/api#13`. |
| H4 | Switch to the `sre` workspace and open `#incidents`. | The page lists M and P as listeners, shows `Appears as` for M, lists `Active now: t-inc`, and lists the Slack threads `t-inc` follows. |
| H5 | Click **Add** on `#incidents`, choose "Reply to mentions", keep **Runs in** at its default, finish. | The wizard opened with the place preselected. The new listener's sentence ends with `replies in a new thread`. Its stored policy is `{ mode: "new" }`. |
| H6 | Click **Add**, choose "Send a notification" for failed checks on `acme/api`. | **Runs in** defaults to `One thread per pull request` and offers `A new thread each time`, `This listener's thread`, `An existing thread…`. The last opens a searchable picker of the workspace's open threads. |
| H7 | Open R4, which points at the archived `Platform CI` thread (Scenario T step T7). | The listener row carries a problem badge. The page says `This listener's thread is archived. Pick another thread.` with the picker inline. |
| H8 | Open the Routines tab. | S1 appears as `Every day at 9:00 · Morning summary · works in this routine's thread`. Fire now, edit, and enable or disable are available. |
| H9 | Open the Activity tab. | The C2 mention appears as `Mention in #incidents → replied in t-inc`. Expanding it shows the receipt stages. The C1 message appears as `Message in #incidents → claimed by t-inc`. |
| H10 | Open the Workflows and Runs tabs. | They show what `/workflows` and its Runs tab showed. The workflow editor's triggers panel lists the workflow's listeners and routines with the same sentences. |
| H11 | Open thread `t-inc`. | The thread context card's background section shows `Fed by: M, P` with links, under the existing waiting entry. |
| H12 | Visit `/events?tab=subscriptions`, `/events/<eventId>`, `/workflows/<id>`, `/workflows/runs/<runId>`, `/channel?key=...`. | Each redirects to its Presence URL. No old URL returns a 404. |

Pass criterion: all steps, in one run, from a clean start.

## Part A: Information architecture

*Conformance: web.*

1. One nav entry, **Presence**, at `/presence`, replaces the "Automation"
   and "Events" entries. Its subtitle is `Where Valet is, and what it does
   there.`
2. Tabs, in order: **Places** (index), **Routines**, **Activity**,
   **Workflows**, **Runs**.
3. Routes:

   | New | Replaces |
   |---|---|
   | `/presence` | `/events` (Channels), `/workflows` Triggers |
   | `/presence/places/$key` | `/channel?key=` |
   | `/presence/listeners/$id` | the Subscriptions tab's inline edit and review |
   | `/presence/routines` | `/workflows` Triggers (schedules) |
   | `/presence/activity` | `/events?tab=log` and the legacy `tab` values |
   | `/presence/events/$eventId` | `/events/$eventId` |
   | `/presence/workflows`, `/presence/workflows/$workflowId` | `/workflows`, `/workflows/$workflowId` |
   | `/presence/runs`, `/presence/runs/$runId` | `/workflows` Runs, `/workflows/runs/$runId` |

4. Every replaced URL MUST redirect to its new URL and carry its search
   params (`tab`, `status`, `q`, `review`, `key`). The redirects stay for at
   least one release and are listed in one file.
5. The workspace switcher scopes the whole section, as it scopes threads
   today. A team workspace shows the team's places, listeners, routines,
   and activity.

## Part B: Places

*Depends on: delivery threads spec Part D. Conformance: api, web.*

1. `GET /api/presence/places` MUST return the workspace's places, grouped
   by service, each with: the subject key, the label, the service, the
   parent subject, counts of listeners and active threads, and the last
   activity time. The source is the union of: subjects named by listener
   filters, subject threads (`subject:<key>`), follow bindings, running
   waiters, and events from the last 30 days.
2. A listener whose filters name no single place (a repository-wide rule,
   a `channel in [...]` filter) MUST list under its parent place: the
   repository, the Slack workspace, or the Linear team. The parent row
   reads `Across acme/api` or `Everywhere in Slack`.
3. The place page MUST show these sections, in order:
   - the header: the concrete name and the service;
   - **Listeners**: Part C rows, with an **Add** button that opens the
     wizard with the place preselected;
   - **Appears as**, when any listener here sets an appearance;
   - **Threads**: the subject thread, the threads following Slack threads
     here, and the threads active here, each a link;
   - **Recent activity** for this place.
4. The Places tab MUST offer a view toggle, **All listeners**, that lists
   every listener of the workspace in one flat table with the same rows.

## Part C: Listeners

*Depends on: delivery threads spec Parts A and B. Conformance: web, api.*

1. A listener row is one sentence:

   ```
   Listens <in|on> <place> for <events>[ from <filter>] · <does> [· as <appearance>]
   ```

   `in` for Slack and Linear, `on` for GitHub. `<events>` uses the event
   picker's human labels, joined by "and". `<does>` is one of:

   | Target and policy | `<does>` |
   |---|---|
   | assistant, conversational keys, `new` | `replies in a new thread` |
   | assistant, other keys, `new` | `works in a new thread each time` |
   | assistant, `subject` | `works in one thread per <channel \| pull request \| issue \| repository \| team>` |
   | assistant, `own` | `works in this listener's thread` |
   | assistant, `existing` | `works in the thread <title>` |
   | workflow | `runs <workflow name>` |

2. The **Runs in** control appears in the wizard's assistant step and on the
   listener page. Options and copy: `A new thread each time`, `One thread
   per <subject kind>` (hidden when the keys name no natural subject), `This
   listener's thread`, `An existing thread…` with a searchable picker of the
   workspace's open threads, newest first, showing title and last activity.
3. Wizard defaults: "Reply to mentions" → `new`; "Send a notification" or
   "Run a workflow on an event" with a natural subject → `subject`;
   otherwise `own`.
4. The listener page MUST show: the sentence, enable or disable, edit (the
   existing dialog, with **Runs in** editable), **Appears as**, the delivery
   list with `Delivered to <thread>`, `Claimed by <thread>`, or the
   dead-letter text, and this listener's receipts.
5. A listener whose `existing` thread no longer accepts delivery MUST show a
   problem badge in every list and the text `This listener's thread is
   archived. Pick another thread.` with the picker inline.
6. Coverage copy: a personal listener paused by a team listener reads
   `Paused: a team listener covers the same events.`

## Part D: Routines

*Depends on: delivery threads spec Part A. Conformance: web.*

1. A routine row is one sentence: `<schedule in words> · <name> · <does>`,
   where `<does>` is `works in this routine's thread`, `works in a new
   thread each time`, `works in the thread <title>`, or `runs <workflow>`.
2. The routine page MUST offer fire now, edit, enable or disable, and the
   run or delivery history.
3. **Runs in** for a routine offers `new`, `own`, and `existing`.

## Part E: Activity

*Conformance: web.*

1. The Activity tab is the event log, receipts, and problems from `/events`
   Log, with one change: each row leads with a sentence, `<event in words>
   in <place> → <outcome>`, where the outcome is `replied in <thread>`,
   `delivered to <thread>`, `claimed by <thread>`, `started <workflow> run`,
   `skipped: <reason>`, or `no listener`.
2. The receipt stages stay available under a disclosure. The event page
   keeps its payload and redeliver control.

## Part F: Workflows and Runs

*Conformance: web.*

1. The Workflows and Runs tabs carry the `/workflows` Workflows, Templates,
   and Runs content without change, under the new routes.
2. The workflow editor's triggers panel MUST render the workflow's listeners
   and routines with Part C and Part D sentences, and its **Add** opens the
   wizard with the workflow preselected.

## Part G: Threads

*Conformance: web.*

1. The thread context card's background section (event wakeups spec Part H)
   gains `Fed by: <listeners and routines>` with links, for a thread that is
   a rule's `own` thread, an `existing` pin, or a subject thread.
2. A subject thread's header names its place.

## Part H: Rename `presence` to `appearance`

*Conformance: shared types, api, web.*

1. The `Presence` type in `@valet/shared` becomes `Appearance`, and the
   `presence` field on subscription targets and schedules becomes
   `appearance`.
2. The API MUST accept both field names on write for one release and MUST
   emit `appearance` on read. A write that carries both MUST be refused
   with `Send appearance, not presence.`
3. The stored `target` JSON is read with both names until the accept-both
   window closes. No backfill runs.
4. UI copy says **Appears as**.

## Invariants

- **INV-H1 Every old URL redirects.** Mechanism: one redirect table, and a
  test that walks every row and the legacy `tab` values. Vector: H12.
- **INV-H2 UI copy uses only the Terminology table's words.** Mechanism: a
  lint over `packages/web/src/components/presence/**` and the routes for the
  banned words. Vector: a test that greps the built copy.
- **INV-H3 The hub adds no feature beyond parity, the rows, the place page,
  and Runs in.** Mechanism: the Non-goals table. Review enforces it.
- **INV-H4 A thread picker lists only threads the viewer may deliver to.**
  Mechanism: the picker reads the workspace's open threads through the
  existing thread list API, scoped by the switcher.

## Testing

- Route tests for Part A step 4, one per row.
- Component tests for the sentence renderers (Part C step 1, Part D step 1,
  Part E step 1), one per `<does>` row.
- The acceptance scenario as a browser test over the full stack.
- A copy lint for INV-H2.

## Non-goals (normative boundary)

| Excluded | Why | Re-entry seam |
|---|---|---|
| Bulk enable or disable, listener history, versioning | Beyond parity | A later listeners spec |
| Moving Workflows and Runs to a Skills-adjacent nav entry | Capability, not presence; one entry first | Part A step 2 |
| Routines that post to a place | A routine's prompt is free text; no structured destination | A `posts to` field on routines |
| Place pages for direct messages | Channel bindings own DM routing | The channel bindings spec |
| Renaming code identifiers beyond `presence` → `appearance` | Churn with no user-facing gain | None planned |

## Deviations

None yet.
