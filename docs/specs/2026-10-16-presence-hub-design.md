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
   | `/presence/places/$subject` | `/channel?key=` |
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
   `skipped: <reason>`, or `no listener`. A delivery that is pending,
   failed, or dead reads as its delivery status line, such as `retries in
   8 minutes, after 2 attempts`.
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

## Part H: Rename `presence` to `appearance` and `orchestrator` to `assistant`

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
- The acceptance scenario as a browser test over the full stack. See
  Deviations: it runs as a router-level web test and an api integration
  test.
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

- **Problem state source (Part C step 5, Part D).** The list route reads a
  listener's problem from its deliveries. `problem` is set when the latest
  settled delivery (`delivered` or `dead`) since the rule's last edit
  dead-lettered with the pin text. A later delivery that lands, or any edit,
  clears it. A routine's problem is `disabledReason`, a column the scheduler
  sets when a dead pin disables the schedule. Enabling the schedule or
  changing its pin clears it. The index `event_deliveries_subscription`
  serves the problem query.
- **Activity rows carry their place and deliveries (Part E step 1).** Each
  stored event on `GET /api/events/log` carries `place`, the concrete name
  of its natural subject's place, and `deliveries`, the same delivery rows
  the event page lists for this workspace's rules and the org's. A thread
  reference on a delivery (`thread`, `claimedBy`) carries the thread's
  `title` and `archived`, so a row reads `claimed by t-inc` after `t-inc`
  is archived. A claim whose thread the viewer may not open reads `claimed
  by another thread`.
- **The editor's listeners come from the rules list (Part F step 2).** The
  panel reads `GET /api/event-subscriptions` and keeps the rules whose
  target is this workflow, because a sentence needs each rule's filters and
  target. Routines come from the workflow's trigger list. A row opens the
  listener or routine page; the panel does not edit a row in place.
- **Activity rows withhold a hidden claiming thread everywhere.** A
  skipped row's `detail` is one of its deliveries' skip texts. When that
  text names a claiming thread the viewer may not open, the row reads
  `Skipped, claimed by another thread.`, as the delivery does.
- **Some `presence` names stay (Part H step 1).** The workflow
  `definition.presence`, the run parameter `presence`, and the queue item
  `metadata.presence` keep their names. They are outside the subscription
  target and the schedule that Part H renames. Each is typed `Appearance`,
  and the UI labels each `Appears as`.
- **Agent tool ids keep `presence` (Part H step 1).** The tool
  `events.set_subscription_presence` and the `presence` input of
  `events.propose_subscription` keep their names, because stored tool
  policies name the tool ids. Both tools store `appearance`.
- **A second refusal (Part H step 5).** A write that sends both `assistant`
  and `orchestrator` is refused with `Send assistant, not orchestrator.`, in
  the same way as the `appearance` refusal of Part H step 2.
- **Validator errors may say `appearance`.** An API validator error names
  the wire field, so it may say `appearance`. UI copy says `Appears as`. The
  copy lint for INV-H2 covers UI copy only.
- **Old routes redirect at the leaf (Part A step 4).** Each replaced leaf
  route has its own `beforeLoad` redirect. A redirect on a parent layout
  route would run for every child URL and send each child to the parent's
  target. The Runs tab is the route file `presence.runs.index.tsx` under a
  `presence.runs.tsx` layout, so `/presence/runs/$runId` nests beside it.
- **The Runs tab is new (Part A step 2).** The old `/workflows` page had
  only the Workflows and Scheduled tabs; a run list lived on each
  workflow's page. Part A step 2 requires a Runs tab, so
  `presence.runs.index.tsx` lists every run in the workspace, newest
  first, over the existing `GET /api/workflows/runs`. No api route was
  added for it.
- **Every thread reads its feeders (Part G step 1).** A rule's `own`
  thread, an `existing` pin, and a place's thread usually hold no event
  waiter. So the background section reads `GET /api/presence/feeders` for
  every thread it shows, cached for 30 seconds. The `Fed by` line sits
  under the first event waiter when the thread holds one. Otherwise it is
  its own line after the list. The section shows when it has work or a
  `Fed by` line, and hides when it has neither. A routine link opens
  `/presence/routines?routine=<id>`.
- **The `/workflows?tab=runs` row has no live source.** No link in the app
  or the api builds that URL today. The row stays so that an old bookmark
  or a later link lands on the Runs tab.
- **The places API accepts a channel-only Slack key (Part B step 3).** An
  old `/channel?key=slack:<channel>` link and a thread's channel chip name a
  channel without its Slack workspace. `GET /api/presence/places/:subject`
  resolves `slack:<channel>` to `slack:<team>/<channel>` with the org's
  Slack workspace. If the org has no Slack workspace, the route answers 404
  with `That Slack channel has no workspace in its link. Pick the channel
  from Places.` The web adds the workspace from the places list before it
  links, so the API resolution is a fallback.
- **The All listeners view is in the URL (Part B step 4).** The toggle
  writes `?view=all`, so Back and a shared link keep the view.
- **The place page header (Part B step 3).** The line under the name is the
  service, plus the reach label (`Across acme/api`, `Everywhere in Slack`)
  when listeners list there. Until the place loads, the title reads
  `Loading…`, and after a failed read it reads `Not available`. The title
  never shows the place key.
- **The place page thread headings (Part B step 3).** The Threads section
  has three lists: `Threads for <name>` (the subject threads), `Following`,
  and `Active now`.
- **A service-wide row hides when it is empty (Part B step 2).** The Slack
  workspace row, `github:*`, and `linear:*` show only when a listener lists
  there or a thread is active there. Otherwise their children are the
  group's top rows, because the group heading names the service.
- **Event names come from a short-name table (Part C step 1).** The catalog
  carries a description for each event key, not a short label. The web keeps
  a table of short names (`mentions`, `pull request reviews`, `completed
  checks`) for common keys. Other keys read as the picker's description. A
  `label` field on catalog entries would replace the table.
- **R4 reads `completed checks` (acceptance H3).** The catalog has no filter
  on a check's conclusion, so the sentence cannot say `failed checks`. R4
  reads `Listens on acme/api for completed checks`.
- **`One thread per team` does not appear (Part C steps 1 and 2).** The web
  derives the subject kind from the event keys. A Linear key gives `issue`,
  never `team`, so the option and the `<does>` text for a team never show.
- **Conversational keys are a key-level approximation (Part C step 1).** A
  listener on `slack.app_mention`, `slack.message`, or a GitHub comment key
  reads as conversational, so a `new` policy reads `replies in a new
  thread`. The same rule picks `replied in` over `delivered to` in Activity.
  The rule reads the key only: a `slack.message` that no one addressed to
  Valet still reads `replied in`.
- **Cron in words covers common forms (Part D step 1).** `cronInWords`
  reads every N minutes, hourly, daily, weekdays, one weekday, and a day of
  the month. Any other expression reads `On the schedule <expr>`. The words
  ignore the timezone. The Routines tab adds the timezone in parentheses
  when it is not UTC.
- **The routine page is a search param (Part D step 2).** One routine opens
  at `/presence/routines?routine=<id>` inside the Routines tab, not at its
  own route.
- **A preselected place's filter follows the events (Part B step 3).** The
  wizard pins the place's filter. An event without the filter's field drops
  it, and a later event with the field brings it back. A filter the reader
  removed stays removed.
- **A restored filter takes its first value.** The wizard restores a pinned
  filter with the value the place gave it. If the reader edited that value
  and an event change dropped the filter, the restored filter shows the
  place's value, not the edit.
- **The acceptance runs as a web test and an api test (Testing).** The repo
  has no browser driver for the web app, and the full-stack e2e row drives
  HTTP and WebSocket only. Two suites replace the browser test and the
  plan's `presence-hub` e2e row:
  `packages/web/src/routes/-presence-acceptance.test.tsx` renders the app's
  route tree with a memory history and walks H1 to H12 against a `fetch`
  stub that answers with wire-typed fixtures.
  `packages/api/src/integration/presence-hub.test.ts` runs the data half over
  a real database: places, place pages, feeders, a listener's `problem` from
  a real dead-lettered delivery, and a routine's `disabledReason` from a real
  scheduler fire. The api suite is in the core integration list.
- **H11 renders the background section alone.** The thread page needs a
  live session socket, so the web test renders the thread context card's
  background section with its own router. In the api test, M works in its
  own thread `t-inc` and P is pinned to it, so the feeders read names both.
- **The copy lint reads source, not the build (INV-H2).** The lint parses
  every non-test file under `components/presence/`, every
  `routes/presence*.tsx`, and each reused dialog the hub opens:
  `workflows/trigger-dialog.tsx` and, under `events/`,
  `edit-subscription-dialog.tsx`, `delivery-preferences.tsx`, `event-match-step.tsx`,
  `automation-review.tsx`, and `automation-wizard.tsx`. It checks string literals, template text, and JSX
  text. It skips imports, types, object keys, comparisons, `case` labels,
  the values of code properties (`key`, `mode`, `kind`, `type`, `id`, `tab`,
  `status`, `view`, `outcome`), non-copy JSX attributes (`className`, `to`,
  `href`, `idPrefix`, and similar), and strings with no space that hold `.`, `_`, `:`,
  `/`, `*`, `$`, or `-`. A line marked `// copy-lint: allow <word>`, or the
  line after the marker, may use that word.
- **Copy lint allowances.** The workflow editor
  (`routes/presence.workflows.$workflowId.tsx`) keeps the drawer state value
  `triggers` on two lines. The value never shows; the drawer's title is
  `Listeners and routines`. The reused dialogs need no allowance. Their
  copy says routine for a schedule and listener for an event rule, and
  says turn on, not enable. The wizard's Runs in field takes the id prefix
  `automation-outcome`, a code value the lint skips.
- **A routine page is read-only until it knows the viewer (Part D step 2).**
  The page enables its controls for the owner of a personal routine and for
  a member of the owning team, as the server's trigger access rule does. A
  routine that runs a workflow keeps its controls on, and the server checks
  the workflow. While the viewer or the teams load, the controls stay off.
