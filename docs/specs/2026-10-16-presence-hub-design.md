# Presence hub

Date: 2026-10-16. Revised 2026-10-17 (rail layout, vocabulary) and 2026-10-18 (overview landing). Status: revision 2 implemented; revision 3 proposed.

Depends on: `2026-10-16-delivery-threads-and-claims-design.md` (thread
policy, claims, natural subjects), `2026-08-15-workflow-triggers-ui-design.md`
(the aggregated triggers read, schedules REST), `2026-07-20-event-system-design.md`
(subscriptions REST, receipts, the Web UI section), `2026-08-17-team-workspace-ui-design.md`
(the workspace switcher scope).

Supersedes the "Tabbed hub" decision and the Triggers tab of the workflow
triggers UI spec, and the "Web UI" section of the event system spec.

## Problem

Two nav entries, "Automation" (`/workflows`: Workflows, Runs, Triggers,
Templates) and "Events" (`/events`: Channels, Log, Subscriptions), showed
the same rows under four names: automation, subscription, trigger, rule.
An event-driven workflow was a trigger on one page and a subscription on
the other. A schedule that prompts the assistant was created from the
Events wizard and listed only under Workflows. Revision 1 of this spec
merged both pages into one section with five tabs. That put a second
level of navigation under the top nav, and it kept a category noun
("listener") that no person uses. Revision 2 replaced the tabs with a rail
of places beside an Activity log. That inverted the page: the log, which a
person reads rarely, filled the pane, while the places and what Valet does
in each, which the page promises, sat in a rail as bare labels. The main
creation flow was not on the landing at all. Users still could not answer
the question they have: where is Valet, and what does it do there?

## Thesis

**Presence** is Valet listening somewhere. One section, Presence, lands on
the map: every place Valet is in, what it does there as sentences, whether
it is working, and what it does on its own schedule (a **routine**). The
things a person set up are the page. History is a drill-in. One **Add**
starts everything. Every line is a sentence, and the UI uses six nouns.

## Requirement language

MUST, MUST NOT, SHOULD, and MAY follow RFC 2119. A sentence without one of
these words is informative.

## Journeys (informative)

| Journey | Frequency | What the person must see first |
|---|---|---|
| Set up: "make Valet answer in #incidents" | first visit, then rarely | one **Add** button and a wizard that reads back as a sentence |
| Glance: "is Valet doing what I think? anything broken?" | most visits | the places, their sentences, on or off, an attention banner |
| Adjust: "turn that off", "move it to another thread" | sometimes | the sentence row with its switch and inline fix |
| Investigate: "why did Valet not reply yesterday?" | occasionally | activity scoped to a place or a line; the global log last |
| Routines: "what runs on a schedule, and when next" | sometimes | the `On a schedule` group with `Next` and `Fire now` |

The overview (Part B) serves the first three journeys without a click. The
place page (Part C), the line page (Part D), and Activity (Part F) serve the
rest.

## Terminology

The left column is the only vocabulary UI copy MAY use for these objects.
The right column is the system word, which stays in code, API paths, and
the system specs.

| User-facing | System |
|---|---|
| **Presence**: Valet listening somewhere; also the section and its landing page | the hub; an event subscription is one line of a place's presence |
| **place**: a Slack channel, a GitHub repository, a Linear team; also a service as a whole (`Everywhere in Slack`). Copy names the concrete thing (`#incidents`, `acme/api`) and uses "place" only as a column header | a subject at the mid grain; a pull request or issue is a thread inside its repository's page |
| a line of presence has no category noun; copy uses its sentence, or its own name where a noun is unavoidable (breadcrumb, Fed by) | an event subscription with any target |
| **routine**: at a time, Valet does something; the group `On a schedule` | a workflow schedule with any target |
| **Appears as**: the display name and avatar Valet uses when it replies | the `appearance` field (Part J) |
| **Runs in**: the form label for where deliveries land | thread policy |
| **active**: a thread currently waiting on this place | event waiter |
| **following**: a Slack thread whose replies reach a Valet thread | followed thread |
| **Activity**: what happened | events, deliveries, receipts |
| **Needs attention**: the banner of things to fix | problems: an archived pin, a disabled routine, a dead delivery |
| **workflow**, **run** | unchanged; their own top-nav entry |

UI copy MUST NOT use "listener", "automation", "subscription", "trigger",
"subject", "rule", or "event waiter" for these objects. "Event" appears
only inside Activity and the event picker, where it names the thing that
happened.

## Acceptance scenario (normative)

Universe: org `acme`, user `u-001` in the personal workspace, team `sre`
with team workspace scope. Slack channel `C900` is named `#incidents`.
Repository `acme/api` exists. The rules R1, R2, R4, S1 and threads from the
delivery threads spec Scenario T exist for `u-001`, plus thread `t-inc` from
Scenario C for `sre`. One `sre` delivery has dead-lettered on R4's archived
pin.

| Step | Action | Expected observation |
|---|---|---|
| P1 | Open the app. | The nav shows **Presence** and **Workflows**, and no "Events" or "Automation" entry. |
| P2 | Open `/presence`. | The page shows **Add**, a **Needs attention** banner with one item (`Platform CI is archived. Pick another thread:` and a picker), then the group `GitHub` with the block `acme/api` (an active mark, R1 and R4 as sentences with switches, R4's problem line under its row) and the group `On a schedule` with S1 as a sentence, `Next: <date and time>`, and **Fire now**. No rail, no tabs, no pull request block. The footer reads `Activity`. |
| P3 | Select `acme/api`. | The place page header reads `acme/api` with `GitHub`. Under **Valet here**, R1 reads `When a pull request review or a check completes on acme/api, work in one thread per pull request.` and R4 reads `When a check completes on acme/api, work in the Platform CI thread.` with its inline problem line. **Threads** lists `One thread per pull request: acme/api#12, acme/api#13`. |
| P4 | Switch to the `sre` workspace and select `#incidents`. | The place page lists M and P as sentences, **Appears as** `Ops Bot`, **Threads** with `Active now: t-inc` and `Following: 1 Slack thread`, and **Recent activity** with the C2 mention. |
| P5 | Click **Listen for…** on the `#incidents` block of the overview. | The wizard opens fixed on `#incidents`. The When step offers only Slack choices. The preview reads `When someone mentions Valet in #incidents, reply in a new thread.` Create stores a rule with policy `{ mode: "new" }`. |
| P6 | Click **Add**, choose `On a schedule`, set weekdays at 9:00, a prompt, and a name. | The When step offers all four choices. The preview reads `Every weekday at 9:00, <name>: work in its own thread.` The row appears under `On a schedule` with `Next: <date and time>` and **Fire now**. |
| P7 | Open R4 from its row. | The page shows a breadcrumb `acme/api › CI failures`, the sentence as the title, a fact strip (When, Do, Runs in, Appears as) with **Edit**, the problem line with the picker, then deliveries as sentences. |
| P8 | Pick a new thread in the picker, then return to `/presence`. | The problem line is gone, the sentence ends with the new thread's title, and the **Needs attention** banner is gone. |
| P9 | Follow `Activity`, choose the `Problems` chip. | `/presence/activity` lists the dead-lettered delivery as `Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver`. With the chip off, the C2 mention appears as `Mention in #incidents → replied in t-inc`. The breadcrumb reads `Presence › Activity`. |
| P10 | Open `/workflows`. | The Workflows page shows the workflow list and a Runs view at its own URL. The editor's panel lists this workflow's presence lines and routines as sentences, and its **Add** opens the wizard fixed on the workflow. |
| P11 | Open thread `t-inc`. | The thread context card shows `Fed by: Incident mentions, Channel watch` with links; `acme/api#12`'s header names its place, `acme/api#12`. |
| P12 | Visit `/events?tab=subscriptions`, `/events/<eventId>`, `/channel?key=slack:C900`, `/presence/listeners/<id>`, `/presence/routines`, `/presence/routines?routine=<id>`, `/presence/workflows`, `/presence/runs/<runId>`. | Each redirects: the first three into Presence, `/presence/listeners/<id>` to `/presence/rules/<id>`, `/presence/routines` to `/presence`, `/presence/routines?routine=<id>` to `/presence/routines/<id>`, the last two to `/workflows`. No URL returns a 404. |

Pass criterion: all steps, in one run, from a clean start.

## Part A: Information architecture

*Conformance: web.*

1. Two nav entries replace "Automation" and "Events": **Presence** at
   `/presence` and **Workflows** at `/workflows`. The Presence subtitle is
   `Where Valet is, and what it does there.`
2. Presence is one column. There is no rail and there are no tabs. The
   landing page is the overview (Part B). Every other page of the section
   is a drill-in with a breadcrumb whose first crumb is `Presence`.
3. Routes:

   | Path | Page |
   |---|---|
   | `/presence` | the overview (Part B) |
   | `/presence/places/$subject` | a place (Part C) |
   | `/presence/rules/$id` | one line of presence (Part D) |
   | `/presence/routines/$id` | one routine (Part E) |
   | `/presence/activity` | Activity (Part F) |
   | `/presence/events/$eventId` | one event |
   | `/workflows`, `/workflows/runs`, `/workflows/$workflowId`, `/workflows/runs/$runId` | the Workflows section (Part G) |

4. Every URL from an earlier revision and from before the hub MUST
   redirect: `/events*` and `/channel` into Presence,
   `/presence/listeners/$id` to `/presence/rules/$id`, `/presence/routines`
   to `/presence`, `/presence/routines?routine=<id>` to
   `/presence/routines/<id>`, `/presence/workflows*` to `/workflows*`,
   `/presence/runs*` to `/workflows/runs*`, and the old `/workflows?tab=`
   values as the Deviations list them. Redirects carry their search params
   and live in one table.
5. `/presence` MUST land on the overview. It never lands on a place or on
   Activity.
6. The overview MUST read well at one column on a phone: blocks stack, the
   switch and the overflow menu stay on the sentence row, and nothing
   scrolls sideways.
7. The workspace switcher scopes the whole section.

## Part B: The overview

*Depends on: delivery threads spec Part D. Conformance: api, web.*

1. Header: the title, the workspace clause, the subtitle, and one **Add**
   button at the right. **Add** opens the wizard (Part H) on the When step
   with all four choices.
2. **Needs attention** (Part F step 4): a banner under the header, shown
   only when the workspace has at least one fault. Each item is one line:
   the fault text and its fix inline (an archived pin shows the thread
   picker; a disabled routine shows its reason and an `Edit` link; a dead
   delivery links its event). The banner never shows a bare count.
3. Groups, in order: `Slack`, `GitHub`, `Linear`, `On a schedule`. A group
   renders only when it has at least one block.
4. A **place block** has a header row and sentence rows. The header row:
   the concrete name as a link to the place page, an active mark with the
   count of threads waiting there, and `<time ago>` of the last activity. A
   block appears for every place at the mid grain (a Slack channel, a
   GitHub repository, a Linear team) that has at least one line of
   presence. A pull request or issue MUST NOT get a block. Lines whose
   filters name no single place form one block per service headed
   `Everywhere in Slack`, `Across GitHub`, or `Across Linear`, which links
   to the service page (Part C).
5. A **sentence row** is the Part C step 2 sentence without its `<in|on>
   <place>` clause (the block names the place), linked to the line's page,
   with the on/off switch and the overflow menu (Edit, Appears as, Delete)
   from Part C step 2. The problem line (Part C step 3) and the paused line
   render under the row. A block ends with a quiet `+ Listen for…` that
   opens the wizard fixed on that place.
6. The `On a schedule` group has one block with the Part E step 1 routine
   rows, each with `Next: <time>`, the switch, and **Fire now**, and ends
   with `+ New routine`, which opens the wizard on the schedule step.
7. Footer: a link `Activity` to `/presence/activity`. When the api already
   returns a total, the link MAY read `Activity · <n> events in the last 30
   days`.
8. Scale: with more than ten blocks, each group collapses to its header
   with a block count, a filter box appears above the groups and filters
   blocks by name, and groups with a fault stay open. Blocks within a group
   sort by last activity, newest first; blocks with no activity sort by
   name.
9. Empty state: a workspace with no block and no routine shows, in place
   of the groups, `Valet is not present anywhere yet.` with three cards
   (Connect Slack, Connect GitHub, Connect Linear, each to Integrations)
   and a line `or Add to listen somewhere, or run on a schedule.` with
   **Add**.
10. Reads: `GET /api/presence/places` (every grain; the overview keeps the
    mid grain and the service roots), `GET /api/event-subscriptions` (the
    sentences), and the workspace's schedules, refreshed on every write the
    section makes and every 60 seconds. Loading reads `Loading…` in place of
    the groups; a failed read names its fix.

## Part C: The place page

*Depends on: delivery threads spec Parts A and B. Conformance: web, api.*

1. Header: a breadcrumb `Presence › <name>`, the concrete name, the
   service, and an outbound link to the place in its tool when the api
   knows it. The header never shows the place key; loading reads
   `Loading…`; a failed read reads `Not available`.
2. **Valet here**: one sentence per line of presence, with an on/off switch
   and an overflow menu (Edit, Appears as, Delete). The sentence grammar:

   ```
   When <event in words> [from <sender>] <in|on> <place>, <do>[, as <appearance>].
   ```

   `in` for Slack and Linear, `on` for GitHub; events joined by "or". `<do>`
   is one of:

   | Target and policy | `<do>` |
   |---|---|
   | assistant, conversational keys, `new` | `reply in a new thread` |
   | assistant, other keys, `new` | `work in a new thread each time` |
   | assistant, `subject` | `work in one thread per <pull request \| issue \| channel>` |
   | assistant, `own` | `work in its own thread` |
   | assistant, `existing` | `work in the <title> thread` |
   | workflow | `run <workflow name>` |

   Conversational keys are Slack mentions, Slack messages, and GitHub
   comment keys (a key-level approximation; see Deviations).
3. A problem renders inline under its row, never as a badge alone:
   `<thread title> is archived. Pick another thread:` with the thread
   picker; a pick patches the line and clears the problem. A paused
   personal line reads `Paused: the team already listens for this.`
4. The **Listen for…** button opens the wizard (Part H) fixed on this place.
5. **Threads**: `Active now` (threads waiting here), `Following` (Slack
   threads bound here), and for a repository or team `One thread per pull
   request` or `One thread per issue` listing the subject threads; each a
   link.
6. **Appears as**: shown when any line here sets one.
7. **Recent activity**: the last ten rows for this place (Part F grammar)
   and `View all` into Activity filtered to the place.
8. Empty state: a place that exists only because events or threads touched
   it reads `Nothing is set up here yet.` with **Listen for…**.

## Part D: One line of presence

*Conformance: web, api.*

1. `/presence/rules/$id` shows a breadcrumb `Presence › <place> › <name>`,
   the sentence as the title, a fact strip (When, Do, Runs in, Appears as)
   with **Edit** (the existing dialog, Runs in editable), the on/off
   switch, the problem line when present, then **Deliveries** as sentences
   (`<event in words> → <outcome>, <time ago>`) and, for admins, receipt
   stages under a disclosure.
2. `EventSubscriptionWire` carries `problem?: string` (the pin text when
   the latest settled delivery since the line's last edit dead-lettered on
   its pin). The api offers `GET /api/event-subscriptions/:id/deliveries`
   and a `subscriptionId` filter on receipts.

## Part E: Routines

*Depends on: delivery threads spec Part A. Conformance: web, api.*

1. A routine row is one sentence: `<schedule in words>, <name>: <do>.` with
   `<do>` as `work in its own thread`, `work in a new thread each time`,
   `work in the <title> thread`, or `run <workflow>`; plus `Next: <time>`
   or `Off`, an on/off switch, and **Fire now**. The timezone follows the
   schedule words when it is not UTC. The rows live in the overview's `On
   a schedule` group (Part B step 6).
2. `/presence/routines/$id` shows a breadcrumb `Presence › On a schedule ›
   <name>`, the sentence as the title, a fact strip (When, Do, Runs in),
   Edit, Fire now, the switch, the problem line from `disabledReason`, and
   its run or delivery history.
3. A routine is created through **Add** → `On a schedule`, or `+ New
   routine` on the group, both of which open the wizard (Part H) on the
   schedule step.
4. `workflow_schedules` carries `disabled_reason`, set when the scheduler
   disables a routine for an undeliverable pin and cleared on enable or a
   pin change; the wire exposes `disabledReason` and the routine's owner.

## Part F: Activity

*Conformance: web, api.*

1. Rows are dated sentences: `<event in words> in <place> → <outcome>`,
   with outcomes `replied in <thread>`, `delivered to <thread>`, `claimed
   by <thread>`, `started <workflow> run`, `skipped: <reason>`, `no one
   listening`, or the delivery's status line when pending, failed, or dead.
2. `/presence/activity` has a breadcrumb `Presence › Activity`. Chips
   filter the list: `All`, `Problems`, one per service, and a place search.
   Receipt stages and diagnostics sit under disclosures for admins. The
   event page keeps payload and redeliver.
3. A claim by a thread the viewer cannot open reads `claimed by another
   thread`; an archived thread renders a disabled link.
4. The **Needs attention** banner lists the workspace's distinct faults:
   lines with a problem, routines with a `disabledReason`, and lines with
   a dead delivery in the last day. A dead delivery counts once per line,
   and only when its line does not already list for its own problem and
   was not edited after the delivery.

## Part G: Workflows

*Conformance: web.*

1. `/workflows` keeps its page with the workflow list and templates, and a
   Runs view at `/workflows/runs` listing every run in the workspace; the
   editor at `/workflows/$workflowId` and the run page at
   `/workflows/runs/$runId` are unchanged.
2. The editor's panel lists this workflow's presence lines and routines
   with the Part C and Part E sentences, each linking to its page. Its
   **Add** opens the wizard fixed on the workflow.

## Part H: The wizard

*Conformance: web.*

1. The wizard reads the configuration back as the sentence the lists use,
   in a preview line at its top that updates with every choice.
2. Step **When**: `Someone mentions Valet in Slack`, `Something happens on
   GitHub`, `Something happens in Linear`, `On a schedule`. Launched from
   **Add**, all four show. Launched from a place, the place is fixed and
   only its service's choices show. Launched from `+ New routine`, the
   schedule step opens first. Launched from a workflow, the Do step is
   fixed on that workflow.
3. Step **What**: the event picker for the chosen service, with filters.
4. Step **Do**: `Reply`, `Work on it`, `Run a workflow`. A non-Slack place
   never offers `Reply` or a Slack channel picker.
5. **Runs in** shows its default as a sentence with a `Change` link; the
   defaults are the thread policy spec's: mention → `new`; a notification
   or a workflow with a natural subject → `subject`; else `own`.
6. **Appears as** sits behind a disclosure.
7. Titles: `New routine` or `Listen for…`; the create button reads `Create`.
8. A preselected place filter stays through event changes; a filter the
   reader removed stays removed.
9. After Create, the overview MUST show the new row, and SHOULD scroll to
   and highlight its block.

## Part I: Threads

*Conformance: web.*

1. The thread context card's background section (event wakeups spec Part H)
   shows `Fed by: <names>` with links, for every thread that a line or
   routine feeds (its `own` thread, an `existing` pin, or a place's thread),
   whether or not the thread holds a waiter.
2. A place's thread header names its place and links to it.

## Part J: Rename `presence` to `appearance` and `orchestrator` to `assistant`

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
5. The stored target discriminator `kind: "orchestrator"`, the wire field
   `orchestrator: "user" | "team" | "org"`, and the schedule
   `target_kind` value `orchestrator` become `assistant`. The API MUST
   accept both values on write for one release and MUST emit `assistant`
   on read. Stored rows are read with both values. No backfill runs.
6. Code identifiers that name the delivery path use `assistant`
   (`deliverToAssistant`, `assistant-target.ts`). The wider rename of
   child-session code and the `smoke-orchestrator` make target is a
   separate sweep. CLAUDE.md names `assistant` as the only word for new
   code.

## Invariants

- **INV-H1 Every old URL redirects.** Mechanism: one redirect table, and a
  test that walks every row and the legacy `tab` values. Vector: P12.
- **INV-H2 UI copy uses only the Terminology table's words.** Mechanism: a
  lint over `components/presence/**`, the presence routes, and every dialog
  the section opens, for the banned words. Vector: a test that reads the
  source.
- **INV-H3 The hub adds no feature beyond parity, the overview, the pages,
  the wizard preview, and Runs in.** Mechanism: the Non-goals table. Review
  enforces it.
- **INV-H4 A thread picker lists only threads the viewer may deliver to.**
  Mechanism: the picker reads the workspace's open threads through the
  existing thread list API, scoped by the switcher.
- **INV-H5 No level of navigation sits under the top nav.** Mechanism: the
  section has no `TabBar` and no rail; a test renders every Presence route
  and asserts no `tablist` and no `navigation` landmark other than the
  breadcrumb.
- **INV-H6 Every fault is fixable where it is shown.** Mechanism: the
  banner item and the sentence row render the same inline fix component;
  a test asserts a pick from the banner patches the line.

## Testing

- Route tests for Part A step 4, one per row.
- Component tests for the sentence renderers (Part C step 2, Part E step 1,
  Part F step 1), one per `<do>` row and outcome.
- Overview tests: grouping and ordering (Part B steps 3, 4, 8), the
  sentence row without its place clause, the banner (Part B step 2, Part F
  step 4), the empty state, the scale rules at eleven blocks.
- The acceptance scenario as a router-level web test plus api integration
  (see Deviations).
- A copy lint for INV-H2 and a no-navigation test for INV-H5.

## Non-goals (normative boundary)

| Excluded | Why | Re-entry seam |
|---|---|---|
| Bulk enable or disable, line history, versioning | Beyond parity | A later spec |
| Pull requests or issues as blocks on the overview | Transient; they live inside their repository's page | Part B step 4 |
| Routines that post to a place | A routine's prompt is free text; no structured destination | A `posts to` field on routines |
| Place pages for direct messages | Channel bindings own DM routing | The channel bindings spec |
| Renaming code identifiers beyond `presence` → `appearance` | Churn with no user-facing gain | None planned |
| A per-event receipts endpoint | Receipts search by event id serves the disclosure | None planned |
| A server-side service filter or event total for Activity | The client filters loaded rows; a total is optional copy | A `service` and `total` on the log route |

## Deviations

Revision 1 deviations that still hold, with the revision 3 part numbers:

- **Problem state source (Part D step 2, Part E step 4).** The list route
  reads a line's problem from its deliveries. `problem` is set when the
  latest settled delivery (`delivered` or `dead`) since the line's last edit
  dead-lettered with the pin text. A later delivery that lands, or any edit,
  clears it. A routine's problem is `disabledReason`, a column the scheduler
  sets when a dead pin disables the schedule. Enabling the schedule or
  changing its pin clears it. The index `event_deliveries_subscription`
  serves the problem query.
- **Activity rows carry their place and deliveries (Part F step 1).** Each
  stored event on `GET /api/events/log` carries `place`, the concrete name
  of its natural subject's place, and `deliveries`, the same delivery rows
  the event page lists for this workspace's rules and the org's. A thread
  reference on a delivery (`thread`, `claimedBy`) carries the thread's
  `title` and `archived`. A claim whose thread the viewer may not open
  reads `claimed by another thread`, and a skipped row's `detail` reads
  `Skipped, claimed by another thread.` in that case.
- **The editor's lines come from the rules list (Part G step 2).** The
  panel reads `GET /api/event-subscriptions` and keeps the rules whose
  target is this workflow, because a sentence needs each rule's filters and
  target. Routines come from the workflow's trigger list. A row opens its
  page; the panel does not edit a row in place.
- **Some `presence` names stay (Part J step 1).** The workflow
  `definition.presence`, the run parameter `presence`, and the queue item
  `metadata.presence` keep their names. Each is typed `Appearance`, and the
  UI labels each `Appears as`.
- **Agent tool ids keep `presence` (Part J step 1).** The tool
  `events.set_subscription_presence` and the `presence` input of
  `events.propose_subscription` keep their names, because stored tool
  policies name the tool ids. Both tools store `appearance`.
- **A second refusal (Part J step 5).** A write that sends both `assistant`
  and `orchestrator` is refused with `Send assistant, not orchestrator.`
- **Validator errors may say `appearance`.** An API validator error names
  the wire field. UI copy says `Appears as`. The copy lint covers UI copy
  only.
- **Old routes redirect at the leaf (Part A step 4).** Each replaced leaf
  route has its own `beforeLoad` redirect. A redirect on a parent layout
  route would run for every child URL.
- **Every thread reads its feeders (Part I step 1).** The background
  section reads `GET /api/presence/feeders` for every thread it shows,
  cached for 30 seconds, and renders `Fed by` with or without a waiter.
- **A thread header links the server's place key (Part I step 2).** The
  web `placeOfSubject` mirrors the server's, and the link sends
  `?workspace=` with the thread owner's workspace.
- **One pinned title read.** Every page that names a pinned thread reads
  `usePinnedThreadTitles`, with an archived fallback. A delivery row names
  its thread by the `title` on its thread ref.
- **The places API accepts a channel-only Slack key (Part C step 1).**
  `GET /api/presence/places/:subject` resolves `slack:<channel>` with the
  org's Slack workspace; with none, it answers 404 `That Slack channel has
  no workspace in its link. Pick the channel from Presence.`
- **Event names come from a short-name table (Part C step 2).** The catalog
  carries a description for each key and no short label. A `label` field on
  catalog entries would replace the table.
- **R4 reads `a check completes` (acceptance P3).** The catalog has no
  filter on a check's conclusion, so the sentence cannot say `fails`.
- **`One thread per team` does not appear (Part C step 2).** The web
  derives the subject kind from the event keys; a Linear key gives `issue`.
- **Conversational keys are a key-level approximation (Part C step 2).** A
  `slack.message` that no one addressed to Valet still reads `reply in`.
- **Cron in words covers common forms (Part E step 1).** Other expressions
  read `On the schedule <expr>`.
- **A preselected place's filter follows the events (Part H step 8).** An
  event without the filter's field drops it; a later event with the field
  brings it back with the place's value. A filter the reader removed stays
  removed.
- **The acceptance runs as a web test and an api test (Testing).** The repo
  has no browser driver for the web app. `routes/-presence-acceptance.test.tsx`
  renders the route tree with a memory history against wire-typed fixtures;
  an api integration test covers places, feeders, `problem`, and
  `disabledReason`. The thread card step renders the background section on
  its own router, because the thread page needs a live session socket. For
  the same reason, P11 checks the thread header's place label through the
  pure `subjectPlaceLabel`.
- **The copy lint reads source files (INV-H2).** It scans string
  literals and JSX text and skips identifiers, imports, types, comments,
  test files, and the `idPrefix` attribute.
- **A routine page is read-only until it knows the viewer (Part E step 2).**
  Team and org routines are editable only by a member with access.
- **The place page edits Appears as in the edit dialog (Part C step 6).**
  The overflow menu item `Appears as` opens the existing edit dialog with
  focus on its Appears as field. The section shows each line's name and
  avatar with `Set by <name>`, and has no inline form.
- **A Slack channel's own threads keep their title (Part C step 5).** The
  subject group reads `One thread per pull request` on a repository and
  `One thread per issue` on a Linear team. On a Slack channel it reads
  `Threads for <channel>`.
- **A workflow line has no Runs in fact (Part D step 1).** A workflow
  target starts a run and no thread, so its fact strip shows When, Do,
  and Appears as.
- **The service chips filter in the browser (Part F step 2).** The log
  route has no service filter. A service chip keeps the loaded rows whose
  event key starts with `<service>.`, so a page can show fewer rows than it
  loaded. The place search sends `q`, which the server matches.
- **Receipts leave the chips (Part F step 2).** Admins open receipts under
  a `Receipts` disclosure beside the list. The old `status=receipts` value
  and the `/events?tab=receipts` redirect open the whole Log.

Revision 2 deviations that still hold:

- **The routine preview uses the Part E sentence (acceptance P6).** The
  wizard has one sentence renderer for every list. A routine's preview
  reads `Every weekday at 9:00, <name>: work in its own thread.` Before the
  reader types a name, the preview reads `this routine`.
- **Do offers `Follow a Slack thread` (Part H step 4).** For Slack, the Do
  step lists `Reply`, `Follow a Slack thread`, `Work on it`, and `Run a
  workflow`. The follow choice keeps the revision 1 outcome that listens
  to one Slack thread from a pasted message link.
- **The preview names the service until an event is picked (Part H step
  1).** Before the reader picks an event, the preview reads `When
  something happens on acme/api, <do>.` or `When something happens on
  GitHub, <do>.` A preselected Slack place starts on the mention, so its
  preview names the mention at once.
- **A mention rule's creator filter is not a sender (Part C step 2).** The
  api adds an unlabeled `user` filter with the creator's Slack id to a
  personal or org mention rule (`packages/api/src/events/mention-scope.ts`).
  That filter is the rule's scope, so the sentence shows no `from
  <sender>` for it. A labeled `user` filter still reads as a sender.
- **A routine row's switch is not gated (Part E step 1).** The row does
  not check `routineReadOnly` before it enables the switch. If the viewer
  may not change the routine, the server refuses, and the row shows the
  refusal, which names the fix. The routine page still reads its
  read-only state first.
- **Needs attention follows the switcher (Part F step 4).** The banner
  lists the faults of the active workspace only: its lines, its routines,
  and its Activity rows. The banner changes when the reader switches
  workspace.
- **The breadcrumb separator is decoration (Part D step 1).** The `›`
  between crumbs is a hidden list item with padding. The breadcrumb's text
  is `acme/api›CI failures`, and each crumb is its own link or the
  current page.
- **A dead delivery reads its status line (acceptance P9).** Part F step 1
  reads a dead delivery as its status line, so the P9 row reads `gave up
  after 3 attempts. To send it again, press Redeliver`. The lead follows
  the Part F grammar: `Completed check in acme/api#14`.
- **A pull request thread names its own place (acceptance P11).** The
  header names the server's place key, and that key keeps the pull
  request number (`github:acme/api#12`). The header of `acme/api#12` reads
  `acme/api#12` and links to that page. The overview does not list it.
- **A thread follow has its own sentence (Part C step 2).** The `Follow a
  Slack thread` outcome stores a `slack.message` line with `channel` and
  `thread_ts` filters. A line whose keys are all Slack messages and that
  has a `thread_ts` filter reads `When someone replies in the Slack thread
  in <channel>, <do>.` The channel is its label, or its id when the line
  has no label. The wizard preview reads the draft through the same
  renderer, so the preview equals the stored sentence.
- **Old Workflows tabs redirect from the live page (Part A step 4).**
  `/workflows` serves the Workflows list and is also a legacy route.
  `/workflows?tab=scheduled` and `?tab=triggers` redirect to `/presence`.
  With `&review=<id>`, they redirect to `/presence/routines/<id>`.
  `/workflows?tab=runs` redirects to `/workflows/runs`. Each `/workflows`
  row has a match condition, so a URL that no row takes serves the list.
- **View all searches a Slack place by its channel id (Part C step 7).**
  The server matches `q` against an event's summary and key, and a Slack
  summary carries the channel id (`app mentioned in C900 by U1`). So `View
  all` on a Slack channel sends the channel id from its key
  (`slack:<team>/<channel>`). Every other place sends its label.
- **Needs attention lists each fault once (Part F step 4).** A dead
  delivery names its line by `subscriptionId`. The banner adds that line
  only when the line has no `problem` and its `updatedAt` is before the
  delivery. So a line's problem and the dead delivery that caused it are
  one item, and a pick that fixes the line removes the item at once.
- **The empty state reads places and routines (Part B step 9).** The
  overview shows the onboarding cards only when the workspace has no
  block and no routine. A workspace with a routine is not empty: Valet
  already does something there on a schedule. The cards show only after
  both reads load.
- **The thread card says `wait` (INV-H2).** The background section of the
  thread context card names an event wakeup a `wait`, because `active`
  reads as a state and not a thing to count. The card is outside Presence,
  so the copy lint does not read it.

Revision 1 deviations that revision 2 retired: the All listeners view, the
place header's reach label, the empty service-wide row rule, and the
routine page as a tab child.

Revision 2 deviations that revision 3 retires: the rail's filter box and
collapse rules (replaced by Part B step 8), the plain group header for a
service without a service-wide row (a service block exists only when lines
name no place), the Activity landing, the `Activity` and `Routines` rail
counts (replaced by the banner), and the `/presence/routines?routine=<id>`
page (now `/presence/routines/<id>`).
