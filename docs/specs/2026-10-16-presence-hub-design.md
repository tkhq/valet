# Presence hub

Date: 2026-10-16. Revised 2026-10-17 (rail layout, vocabulary). Status: implemented (revision 2).

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
("listener") that no person uses. Users could not answer the question
they have: where is Valet, and what does it do there?

## Thesis

**Presence** is Valet listening somewhere. One section, Presence, shows
the places Valet is in, what it listens for and does in each, how it
appears there, which threads are active there, and what it does on its
own schedule (a **routine**). The places are the navigation. Every line is
a sentence, and the UI uses six nouns.

## Requirement language

MUST, MUST NOT, SHOULD, and MAY follow RFC 2119. A sentence without one of
these words is informative.

## Terminology

The left column is the only vocabulary UI copy MAY use for these objects.
The right column is the system word, which stays in code, API paths, and
the system specs.

| User-facing | System |
|---|---|
| **Presence**: Valet listening somewhere; also the section | the hub; an event subscription is one line of a place's presence |
| **place**: a Slack channel, a GitHub repository, a Linear team; also a service as a whole (`Everywhere in Slack`). Copy names the concrete thing (`#incidents`, `acme/api`) and uses "place" only as a column header | a subject at the mid grain; a pull request or issue is a thread inside its repository's page |
| a line of presence has no category noun; copy uses its sentence, or its own name where a noun is unavoidable (breadcrumb, Fed by) | an event subscription with any target |
| **routine**: at a time, Valet does something | a workflow schedule with any target |
| **Appears as**: the display name and avatar Valet uses when it replies | the `appearance` field (Part J) |
| **Runs in**: the form label for where deliveries land | thread policy |
| **active**: a thread currently waiting on this place | event waiter |
| **following**: a Slack thread whose replies reach a Valet thread | followed thread |
| **Activity**: what happened | events, deliveries, receipts |
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
| P2 | Open `/presence`. | The pane shows Activity. The rail shows `Activity` with a problem count of 1, `Routines` with a count of 1, then the groups `Slack` and `GitHub`; `GitHub` lists `acme/api` with 2 lines and an active dot. No pull request appears in the rail. |
| P3 | Select `acme/api`. | The pane header reads `acme/api` with `GitHub`. Under **Valet here**, R1 reads `When a pull request review or a check completes on acme/api, work in one thread per pull request.` and R4 reads `When a check completes on acme/api, work in the Platform CI thread.` with an inline problem line `Platform CI is archived. Pick another thread:` and a picker. **Threads** lists `One thread per pull request: acme/api#12, acme/api#13`. |
| P4 | Switch to the `sre` workspace and select `#incidents`. | The pane lists M and P as sentences, **Appears as** `Ops Bot`, **Threads** with `Active now: t-inc` and `Following: 1 Slack thread`, and **Recent activity** with the C2 mention. |
| P5 | Click **Listen for…** on `#incidents`. | The wizard opens fixed on `#incidents`. The When step offers only Slack choices. The preview line reads `When someone mentions Valet in #incidents, reply in a new thread.` Create stores a rule with policy `{ mode: "new" }`. |
| P6 | Select `Routines`, click **New routine**, set weekdays at 9:00, a prompt, and a name. | The preview reads `Every weekday at 9:00, <name>: work in its own thread.` The row appears under Routines with `Next: <date and time>` and **Fire now**. |
| P7 | Open R4 from its row. | The pane shows a breadcrumb `acme/api › CI failures`, the sentence as the title, a fact strip (When, Do, Runs in, Appears as) with **Edit**, the problem line with the picker, then deliveries as sentences. |
| P8 | Pick a new thread in the picker. | The problem line disappears, the sentence ends with the new thread's title, and the rail's problem count on `Activity` drops to 0. |
| P9 | Select `Activity`, choose the `Problems` chip. | The dead-lettered delivery appears as `Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver`. With the chip off, the C2 mention appears as `Mention in #incidents → replied in t-inc`. |
| P10 | Open `/workflows`. | The Workflows page shows the workflow list and a Runs view at its own URL. The editor's panel lists this workflow's presence lines and routines as sentences, and its **Add** opens the wizard fixed on the workflow. |
| P11 | Open thread `t-inc`. | The thread context card shows `Fed by: Incident mentions, Channel watch` with links; `acme/api#12`'s header names its place, `acme/api#12`. |
| P12 | Visit `/events?tab=subscriptions`, `/events/<eventId>`, `/channel?key=slack:C900`, `/presence/listeners/<id>`, `/presence/workflows`, `/presence/runs/<runId>`. | Each redirects: the first three into Presence, `/presence/listeners/<id>` to `/presence/rules/<id>`, the last two to `/workflows`. No URL returns a 404. |

Pass criterion: all steps, in one run, from a clean start.

## Part A: Information architecture

*Conformance: web.*

1. Two nav entries replace "Automation" and "Events": **Presence** at
   `/presence` and **Workflows** at `/workflows`. The Presence subtitle is
   `Where Valet is, and what it does there.`
2. Presence is a two-pane shell: a left **rail** (Part B) and a **pane**.
   There are no tabs. The shell reuses the Settings rail primitives.
3. Routes:

   | Path | Pane |
   |---|---|
   | `/presence` | Activity (Part F) |
   | `/presence/activity` | Activity |
   | `/presence/routines` | Routines (Part E); `?routine=<id>` opens one |
   | `/presence/places/$subject` | a place (Part C) |
   | `/presence/rules/$id` | one line of presence (Part D) |
   | `/presence/events/$eventId` | one event |
   | `/workflows`, `/workflows/runs`, `/workflows/$workflowId`, `/workflows/runs/$runId` | the Workflows section (Part G) |

4. Every URL from revision 1 and from before it MUST redirect: `/events*`
   and `/channel` into Presence, `/presence/listeners/$id` to
   `/presence/rules/$id`, `/presence/workflows*` to `/workflows*`,
   `/presence/runs*` to `/workflows/runs*`. Redirects carry their search
   params and live in one table.
5. `/presence` MUST land on Activity. It never lands on a place.
6. A detail page (a line of presence, a routine, an event) opens in the
   pane with a breadcrumb; the rail stays visible.
7. On a narrow viewport the rail MUST collapse into a dropdown, as the
   Settings rail does.
8. The workspace switcher scopes the whole section.

## Part B: The rail

*Depends on: delivery threads spec Part D. Conformance: api, web.*

1. Rail order: **New routine** (a button), **Activity** with a problem
   count (Part F step 4), **Routines** with a count, then one group per
   service (Slack, GitHub, Linear) in that order.
2. A group header is itself the service-wide place (`Everywhere in Slack`,
   `Across GitHub`, `Across Linear`). Selecting it opens the service page,
   which lists the lines whose filters name no single place.
3. Group rows are places at the mid grain only: Slack channels, GitHub
   repositories, Linear teams. A pull request or issue MUST NOT appear in
   the rail; it appears inside its repository's or team's page as a thread.
   `GET /api/presence/places` keeps returning every grain; the rail filters.
4. A place row shows its label, the number of presence lines there, an
   **active** dot when a thread waits there, and a problem dot when a line
   there has a problem.
5. A group with no places and no service-wide lines does not render.
6. Past eight places, a filter box appears at the top of the rail and the
   groups collapse by default, with the selected place's group open.
7. The rail reads one `GET /api/presence/places` per workspace, refreshed
   on every write the section makes and every 60 seconds.

## Part C: The place page

*Depends on: delivery threads spec Parts A and B. Conformance: web, api.*

1. Header: the concrete name, the service, and an outbound link to the
   place in its tool when the api knows it. The header never shows the
   place key; loading reads `Loading…`; a failed read reads `Not available`.
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
6. **Appears as**: shown when any line here sets one; inline change.
7. **Recent activity**: the last ten rows for this place (Part F grammar)
   and `View all` into Activity filtered to the place.
8. Empty states: a place that exists only because events or threads
   touched it reads `Nothing is set up here yet.` with **Listen for…**. A
   workspace with no places shows, in the Activity pane, `Valet is not
   present anywhere yet.` with three cards (Connect Slack, Connect GitHub,
   Connect Linear, each to Integrations) and `or add a routine`.

## Part D: One line of presence

*Conformance: web, api.*

1. `/presence/rules/$id` shows a breadcrumb `<place> › <name>`, the
   sentence as the title, a fact strip (When, Do, Runs in, Appears as)
   with **Edit** (the existing dialog, Runs in editable), the problem line
   when present, then **Deliveries** as sentences (`<event in words> →
   <outcome>, <time ago>`) and, for admins, receipt stages under a
   disclosure.
2. `EventSubscriptionWire` carries `problem?: string` (the pin text when
   the latest settled delivery since the line's last edit dead-lettered on
   its pin). The api offers `GET /api/event-subscriptions/:id/deliveries`
   and a `subscriptionId` filter on receipts.

## Part E: Routines

*Depends on: delivery threads spec Part A. Conformance: web, api.*

1. A routine row is one sentence: `<schedule in words>, <name>: <do>.` with
   `<do>` as `work in its own thread`, `work in a new thread each time`,
   `work in the <title> thread`, or `run <workflow>`; plus `Next: <time>`,
   an on/off switch, and **Fire now**. The timezone follows the schedule
   words when it is not UTC.
2. `/presence/routines?routine=<id>` opens one routine in the pane: the
   sentence, the fact strip, Edit, Fire now, the problem line from
   `disabledReason`, and its run or delivery history.
3. **New routine** opens the wizard (Part H) on the schedule step.
4. `workflow_schedules` carries `disabled_reason`, set when the scheduler
   disables a routine for an undeliverable pin and cleared on enable or a
   pin change; the wire exposes `disabledReason` and the routine's owner.

## Part F: Activity

*Conformance: web, api.*

1. Rows are dated sentences: `<event in words> in <place> → <outcome>`,
   with outcomes `replied in <thread>`, `delivered to <thread>`, `claimed
   by <thread>`, `started <workflow> run`, `skipped: <reason>`, `no one
   listening`, or the delivery's status line when pending, failed, or dead.
2. Chips filter the list: `All`, `Problems`, one per service, and a place
   search. Receipt stages sit under a disclosure for admins. The event
   page keeps payload and redeliver.
3. A claim by a thread the viewer cannot open reads `claimed by another
   thread`; an archived thread renders a disabled link.
4. The rail's Activity count is the number of problems in the last day:
   dead deliveries, lines with a problem, routines with a `disabledReason`.

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
   GitHub`, `Something happens in Linear`, `On a schedule`. Launched from a
   place, the place is fixed and only its service's choices show. Launched
   from Routines, the schedule step opens first. Launched from a workflow,
   the Do step is fixed on that workflow.
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
- **INV-H3 The hub adds no feature beyond parity, the rail, the pages, the
  wizard preview, and Runs in.** Mechanism: the Non-goals table. Review
  enforces it.
- **INV-H4 A thread picker lists only threads the viewer may deliver to.**
  Mechanism: the picker reads the workspace's open threads through the
  existing thread list API, scoped by the switcher.
- **INV-H5 No level of navigation sits under the top nav except the rail.**
  Mechanism: the shell has no `TabBar`; a test renders every Presence route
  and asserts none.

## Testing

- Route tests for Part A step 4, one per row.
- Component tests for the sentence renderers (Part C step 2, Part E step 1,
  Part F step 1), one per `<do>` row and outcome.
- The acceptance scenario as a router-level web test plus api integration
  (see Deviations).
- A copy lint for INV-H2 and a no-tabs test for INV-H5.

## Non-goals (normative boundary)

| Excluded | Why | Re-entry seam |
|---|---|---|
| Bulk enable or disable, line history, versioning | Beyond parity | A later spec |
| Pull requests or issues in the rail | Transient; they live inside their repository's page | Part B step 3 |
| Routines that post to a place | A routine's prompt is free text; no structured destination | A `posts to` field on routines |
| Place pages for direct messages | Channel bindings own DM routing | The channel bindings spec |
| Renaming code identifiers beyond `presence` → `appearance` | Churn with no user-facing gain | None planned |
| A per-event receipts endpoint | Receipts search by event id serves the disclosure | None planned |

## Deviations

Revision 1 deviations that still hold, with the revision 2 part numbers:

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
  no workspace in its link. Pick the channel from the rail.`
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

Revision 2 deviations:

- **The routine preview uses the Part E sentence (acceptance P6).** The
  wizard has one sentence renderer for every list. A routine's preview
  reads `Every weekday at 9:00, <name>: work in its own thread.` The
  earlier P6 text was `Weekdays at 9:00, <prompt>.` Before the reader
  types a name, the preview reads `this routine`. The P6 row shows the
  corrected text.
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
- **The Routines pane switch is not gated (Part E step 1).** The pane does
  not check `routineReadOnly` before it enables the switch. If the viewer
  may not change the routine, the server refuses, and the pane shows the
  refusal, which names the fix. The routine page still reads its
  read-only state first.
- **The Activity count follows the switcher (Part F step 4).** The rail
  counts the problems of the active workspace only: its lines, its
  routines, and its Activity rows. The count changes when the reader
  switches workspace.
- **A group with no service-wide row shows a plain header (Part B step
  2).** The places list has a service-wide row only when a line there
  names no single place. Without that row, the group header is plain
  text, because no service page exists to open.
- **The breadcrumb separator is decoration (Part D step 1).** The `›`
  between crumbs is a hidden list item with padding. The breadcrumb's text
  is `acme/api›CI failures`, and each crumb is its own link or the
  current page.
- **A dead delivery reads its status line (acceptance P9).** Part F step 1
  reads a dead delivery as its status line, so the P9 row reads `gave up
  after 3 attempts. To send it again, press Redeliver`. The lead follows
  the Part F grammar: `Completed check in acme/api#14`. The P9 row shows
  the corrected text.
- **A pull request thread names its own place (acceptance P11).** The
  header names the server's place key, and that key keeps the pull
  request number (`github:acme/api#12`). The header of `acme/api#12` reads
  `acme/api#12` and links to that page. The rail does not list it. The
  P11 row shows the corrected text.
- **The thread card keeps `Event waiter` (INV-H2).** The background
  section of the thread context card names an event wakeup `Event waiter`.
  The card is outside Presence, so the copy lint does not read it. A
  later copy pass replaces the word with `active`.
- **A thread follow has its own sentence (Part C step 2).** The `Follow a
  Slack thread` outcome stores a `slack.message` line with `channel` and
  `thread_ts` filters. A line whose keys are all Slack messages and that
  has a `thread_ts` filter reads `When someone replies in the Slack thread
  in <channel>, <do>.` The channel is its label, or its id when the line
  has no label. The wizard preview reads the draft through the same
  renderer, so the preview equals the stored sentence.

- **Old Workflows tabs redirect from the live page (Part A step 4).**
  `/workflows` serves the Workflows list and is also a legacy route.
  `/workflows?tab=scheduled` and `?tab=triggers` redirect to
  `/presence/routines`. With `&review=<id>`, they redirect to
  `/presence/routines?routine=<id>`. `/workflows?tab=runs` redirects to
  `/workflows/runs`. Each `/workflows` row has a match condition, so a URL
  that no row takes serves the list.

Revision 1 deviations that revision 2 retires: the All listeners view, the
place header's reach label, the empty service-wide row rule, and the
routine page as a tab child. The `/workflows?tab=runs` row now goes to
`/workflows/runs`, because the Workflows section serves `/workflows`
again.
