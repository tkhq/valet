# Presence hub

Date: 2026-10-16. Revised 2026-10-17 (rail layout, vocabulary) and 2026-10-18 (overview landing; roster presentation). Status: implemented (revision 3); UX fixes 2026-10-18.

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
Repository `acme/api` exists. Team `sre` is named `SRE`. The rules R1, R2, R4, S1 and threads from the
delivery threads spec Scenario T exist for `u-001`, plus thread `t-inc` from
Scenario C for `sre`. One `sre` delivery has dead-lettered on R4's archived
pin.

| Step | Action | Expected observation |
|---|---|---|
| P1 | Open the app. | The nav shows **Presence** and **Workflows**, and no "Events" or "Automation" entry. |
| P2 | Open `/presence`. | The header shows **Activity** and **Add**. A **Needs attention** section holds one item: `In acme/api, Platform CI is archived. Pick another thread:` and a picker. The group `GitHub` holds the `acme/api` row: an active mark with `1 active thread`, R1 and R4 as sentences without the place clause (`When a check completes, work in the Platform CI thread.`), each with a switch, and R4's danger mark and fix under its row. The group `On a schedule` holds S1: `Every day at 9:00` and `Next <date and time>` in the place column, `Morning summary: work in its own thread.`, and **Fire now**. No rail, no tabs, no pull request row, no card borders. |
| P3 | Select `acme/api`. | The place page header reads `acme/api` with `GitHub`. Under **Valet here**, R1 reads `When a pull request review or a check completes on acme/api, work in one thread per pull request.` and R4 reads `When a check completes on acme/api, work in the Platform CI thread.` with its inline problem line. **Threads** lists `One thread per pull request: acme/api#12, acme/api#13`. |
| P4 | Switch to the `sre` workspace and select `#incidents`. | The place page lists M and P as sentences, **Appears as** `Ops Bot`, **Threads** with `Active now: t-inc` and `Following: 1 Slack thread`, and **Recent activity** with the C2 mention. |
| P5 | Click **+ Listen for…** on the `#incidents` row of the overview. | The wizard opens fixed on `#incidents`. The When step offers only Slack choices. The preview reads `When someone mentions Valet in #incidents, reply in a new thread.` Create stores a rule with policy `{ mode: "new" }`, and the `#incidents` row lists it. |
| P6 | Click **Add**, choose `On a schedule`, set weekdays at 9:00, a prompt, and a name. | The When step offers all four choices. The preview reads `Every weekday at 9:00, <name>: work in its own thread.` The row appears under `On a schedule` with `Every weekday at 9:00`, `Next <date and time>`, and **Fire now**. |
| P7 | Open R4 from its row. | The page shows a breadcrumb `Presence › acme/api › CI failures`, the sentence as the title, a fact strip (When, Do, Runs in, Appears as) with **Edit**, the problem line with the picker, then deliveries as sentences. |
| P8 | Pick a new thread in the picker, then return to `/presence`. | The problem line is gone, the sentence ends with the new thread's title, and the **Needs attention** banner is gone. |
| P9 | Click **Activity** in the header, choose the `Problems` chip. | `/presence/activity` lists the dead-lettered delivery as `Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver`. With the chip off, the C2 mention appears as `Mention in #incidents → replied in t-inc`. The breadcrumb reads `Presence › Activity`. |
| P10 | Open `/workflows`. | The Workflows page shows the workflow list and a Runs view at its own URL. The editor's panel lists this workflow's presence lines and routines as sentences, and its **Add** opens the wizard fixed on the workflow. |
| P11 | Open thread `t-inc`. | The thread context card shows `Fed by: Incident mentions, Channel watch` with links; `acme/api#12`'s header names its place, `acme/api#12`. |
| P12 | Visit `/events?tab=subscriptions`, `/events/<eventId>`, `/channel?key=slack:C900`, `/presence/listeners/<id>`, `/presence/routines`, `/presence/routines?routine=<id>`, `/presence/workflows`, `/presence/runs/<runId>`. | Each redirects: the first three into Presence, `/presence/listeners/<id>` to `/presence/rules/<id>`, `/presence/routines` to `/presence`, `/presence/routines?routine=<id>` to `/presence/routines/<id>`, the last two to `/workflows`. No URL returns a 404. |
| P13 | Open a proposal from its `Proposed` row and press **Turn on**. | The page shows `Proposed by the assistant.` and, when the proposal replaces a line, `Turning it on turns off <name>.` **Turn on** opens the edit dialog in review mode. After the reader confirms, the line is on, its row reads its sentence without `Proposed`, and the line it replaces is off. |
| P14 | As a user outside `sre`, open a `sre` line from the `sre` workspace. | On the overview row, the switch and the row menu's Edit, Appears as, and Delete are disabled. The line's page shows the `Team` mark, disables the switch, **Edit**, **Delete**, and the thread picker, and reads `Only members of SRE can change this.` |
| P15 | Delete the workflow of a routine that runs a workflow, then let the routine fire. | The routine is off. The **Needs attention** banner reads `<name> is off: Its workflow was deleted. Edit the routine and pick another workflow.` with an `Edit` link to `/presence/routines/<id>`. |
| P16 | With Slack, GitHub, and Linear all not connected, click **Add**. | The When step opens on `On a schedule`. `Something happens in Slack`, `Something happens on GitHub`, and `Something happens in Linear` are disabled, each with `Connect Slack first`, `Connect GitHub first`, or `Connect Linear first` linking to Integrations. |
| P17 | On the `acme/api` place page, click **View all** under **Recent activity**. | `/presence/activity?place=github:acme/api` opens with the removable chip `In acme/api` and lists only events whose place is `acme/api` or inside it. Removing the chip lists every event again. |

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
   values: `tab=triggers` to `/presence`, `tab=triggers&review=<id>` to
   `/presence/rules/<id>`, `tab=scheduled` to `/presence`,
   `tab=scheduled&review=<id>` to `/presence/routines/<id>`, and `tab=runs`
   to `/workflows/runs`. The two tabs held different objects, so each
   `review` id opens its own kind of page. Redirects carry their search
   params and live in one table.
5. `/presence` MUST land on the overview. It never lands on a place or on
   Activity.
6. The overview MUST read well at one column on a phone: blocks stack, the
   switch and the overflow menu stay on the sentence row, and nothing
   scrolls sideways.
7. The workspace switcher scopes the whole section.

## Part B: The overview

*Depends on: delivery threads spec Part D. Conformance: api, web.*

1. Header: the title, the workspace clause, the subtitle, and at the right
   the section's two actions as a pair: **Activity** (a secondary button
   linking to `/presence/activity`) and **Add** (the primary button). **Add**
   opens the wizard (Part H) on the When step with all four choices. The
   page has no other link to Activity.
2. **Needs attention** (Part F step 4): a ruled section under the header
   with a danger mark and the heading `Needs attention`, shown only when
   the workspace has at least one fault. Each item is one sentence that
   names the place (`In acme/api,`), states the fault, and carries its fix
   inline (an archived pin shows the thread picker open; a dead delivery
   links its event). A routine item reads `<name> is off: <reason>` with an
   `Edit` link to the routine's page. A line's or a dead delivery's lead
   renders through `Sentence` (Part K), so its place reads as a token that
   links the place page, and an archived pin's thread reads as a thread
   token. A routine item is plain text. The banner never shows a bare
   count.
3. Groups, in order: `Slack`, `GitHub`, `Linear`, `On a schedule`. A group
   heading is a small muted label on a hairline rule, led by the service's
   `ServiceMark size="md"` (Part K; the clock for `On a schedule`), with
   the group's count at the right (`2 places`, `1 routine`). A group renders only when
   it has at least one place.
4. The overview is a roster. Each place is one row of
   a two-column grid: the **place column** (the concrete name linking to
   the place page, then on separate lines an active mark with `<n> active
   threads` when threads wait there and `<time ago>` of the last activity)
   and the **sentence column**. A hairline separates places; nothing
   separates a place's own sentences; no place has a border, fill, or
   shadow of its own. A place appears for every mid-grain place (a Slack
   channel, a GitHub repository, a Linear team) that has at least one line
   of presence. A pull request or issue MUST NOT appear. Lines whose
   filters name no single place form one place per service named
   `Everywhere in Slack`, `Across GitHub`, or `Across Linear`, which links
   to the service page (Part C). These three names are the only names of
   the service-wide places: the row, the page title, and the Activity chip
   use them. In a team workspace, each Slack row (the service-wide row and
   each channel) carries an overflow menu `More for <place>` beside the
   place name. Its one item, `Choose channels`, opens the team channel
   dialog (`TeamSlackSetupModal`, the same dialog that the team
   dashboard's setup card opens).
5. A **sentence row** is the Part C step 2 sentence without its `<in|on>
   <place>` clause (the place column names it), set as the largest running
   text on the page and linked to the line's page, with the line's name
   under it in small muted text, and at the right a small on/off switch
   and the overflow menu (Edit, Appears as, Delete) from Part C step 2. The
   sentence renders through `Sentence` (Part K); a row carries no service
   mark, because its group heading has one. A team or org line carries a
   `Team` or `Org` badge under the sentence. An off line renders its
   sentence muted with `Off` under it; a proposal (Part D step 1) reads
   `Proposed` in place of `Off`. A faulted line carries the danger mark
   before its sentence and a **Pick another thread** button under it, which
   reveals the fix (Part C step 3); a viewer who may not change the line,
   or a fault with no picker, sees the fix text directly. A paused line
   reads `Paused: <team name> already listens for this.` with **Keep both**
   under the row.
   When any line of the place sets an appearance, one `Appears as <name>`
   line with the avatar follows the sentences. The sentence column ends
   with a quiet `+ Listen for…` that opens the wizard fixed on that place.
6. The `On a schedule` group uses the same grid: the schedule in words in
   the place column (`Every weekday at 9:00`, then the timezone's long
   name (`Pacific Daylight Time`) when it is not UTC, then `Next <time>` or `Off`), and in the sentence column the
   Part E step 1 routine sentence with **Fire now**, the switch, and the
   overflow menu, ending with `+ New routine`, which opens the wizard on
   the schedule step.
7. Color: the brand accent appears only on **Add**, links, and the active
   mark. Switches are the small variant, accent when on and line when off.
   Hover on a sentence row is the ink wash. Danger color appears only on
   faults and errors. Service marks and reference tokens carry their own
   brand washes (Part K); those washes are not accent and not danger. No
   other decoration.
8. Scale: with more than ten places, each group collapses to its heading
   with its count, a filter box `Filter places` appears above the groups
   and filters places by name, and a group with a fault stays open. Places
   within a group sort by last activity, newest first; places with no
   activity sort by name.
9. Empty state: a workspace with no place and no routine shows, in place
   of the groups, `Valet is not present anywhere yet.` and one paragraph:
   `Choose Add to have Valet act on a schedule. To have it listen somewhere
   too, connect Slack, GitHub, or Linear and Add again.` with `Slack`,
   `GitHub`, and `Linear` as links to Integrations. The header keeps
   **Add** and drops **Activity**. A schedule MUST be creatable with no
   integration connected.
10. Reads: `GET /api/presence/places` (every grain; the overview keeps the
    mid grain and the service roots), `GET /api/event-subscriptions` (the
    sentences), and the workspace's schedules, refreshed on every write the
    section makes and every 60 seconds. Loading reads `Loading…` in place of
    the groups; a failed read names its fix.
11. Phone width: the place column stacks above its sentence column; the
    switch and the overflow menu stay on the sentence row; nothing scrolls
    sideways.

## Part C: The place page

*Depends on: delivery threads spec Parts A and B. Conformance: web, api.*

1. Header: a breadcrumb `Presence › <name>`, the service's
   `ServiceMark size="lg"` (Part K) before the concrete name, the
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

   For a Slack mention, `<event in words>` names who mentions Valet. The
   api scopes a personal, org, or workflow mention line to its creator
   with an unlabeled `user` filter (see Deviations), and the sentence reads
   that scope:

   | Target and creator filter | `<event in words>` |
   |---|---|
   | personal assistant | `you mention Valet` |
   | org assistant or workflow, creator is the viewer | `you mention Valet` |
   | org assistant or workflow, creator is another member | `<creator> mentions Valet` |
   | org assistant or workflow, creator unknown to the directory | `the person who set this up mentions Valet` |
   | team assistant, or no creator filter | `someone mentions Valet` |

   Every other GitHub and Linear key reads in words from one table
   (`EVENT_WORDS`), never as its raw key. The sentence renders through
   `Sentence` (Part K): places, threads, workflows, and people render as
   tokens, and the rest is text.
3. A problem renders inline under its row, never as a badge alone. For an
   archived pin, the row shows the danger mark and **Pick another thread**,
   which opens `<thread title> is archived. Pick another thread:` with the
   thread picker; the **Needs attention** banner shows the picker open. A
   pick patches the line and clears the problem. A paused personal line
   reads `Paused: <team name> already listens for this.` (`the team` when
   the viewer's lines name no single team) with **Keep both**, which patches
   `{ pauseOnOverlap: false, enabled: true }`. A team or org line carries a
   `Team` or `Org` mark, and its Delete confirm names the owner. A proposal
   reads `Proposed` in place of `Off`. A viewer outside the line's owner
   reads who may change it: `Only members of <team name> can change this.`
   or `Only its owner can change this.` The web mirrors the server's gate:
   the owner of a personal line, the members of a team line, and any org
   member for an org line.
4. The **Listen for…** button opens the wizard (Part H) fixed on this place.
5. **Threads**: `Active now` (threads waiting here), `Following` (Slack
   threads bound here), and for a repository or team `One thread per pull
   request` or `One thread per issue` listing the subject threads; each a
   link.
6. **Appears as**: shown when any line here sets one.
7. **Recent activity**: the last ten rows for this place (Part F grammar)
   and `View all`, which opens Activity with `place=<place key>` (Part F
   step 2).
8. Empty state: a place that exists only because events or threads touched
   it reads `Nothing is set up here yet.` with **Listen for…**.

## Part D: One line of presence

*Conformance: web, api.*

1. `/presence/rules/$id` shows a breadcrumb `Presence › <place> › <name>`,
   the sentence as the title, a fact strip (When, Do, Runs in, Appears as)
   with **Edit** (the existing dialog, Runs in editable) and **Delete**
   (after a delete, the page opens `/presence`), the on/off switch, the
   problem line when present, then **Deliveries** as sentences
   (`<event in words> → <outcome>, <time ago>`) and, for admins, receipt
   stages under a disclosure. Do names the action only (`reply`, `work on
   it`, or `run <workflow>`) and Runs in names the thread, so the strip says
   each fact once.
   A proposal (off, and carrying `replaces` or an untouched `proposal-` id)
   opens with `Proposed by the assistant.`, then `Turning it on turns off
   <name>.` when it replaces a line, **Turn on** (the edit dialog in review
   mode) and **Delete**, in place of the switch. The page follows the Part
   C step 3 gate: for a viewer who may not change the line, the switch,
   **Edit**, **Delete**, and the picker are disabled, and the page reads
   `Only members of <team name> can change this.` or `Only its owner can
   change this.`
2. `EventSubscriptionWire` carries `problem?: string` (the pin text when
   the latest settled delivery since the line's last edit dead-lettered on
   its pin). The api offers `GET /api/event-subscriptions/:id/deliveries`
   and a `subscriptionId` filter on receipts.

## Part E: Routines

*Depends on: delivery threads spec Part A. Conformance: web, api.*

1. A routine row is one sentence: `<schedule in words>, <name>: <do>.` with
   `<do>` as `work in its own thread`, `work in a new thread each time`,
   `work in the <title> thread`, or `run <workflow>`; plus `Next: <time>`
   or `Off`, an on/off switch, and **Fire now**. The timezone's long name
   (`Pacific Daylight Time`) follows the schedule words when it is not
   UTC, in the row, the routine page title, the When fact, and the wizard
   preview. The rows live in the overview's `On
   a schedule` group (Part B step 6), where `Next <time>` sits in the
   place column.
2. `/presence/routines/$id` shows a breadcrumb `Presence › On a schedule ›
   <name>`, the sentence as the title, a fact strip (When, Do, Runs in),
   Edit, Delete, Fire now, the switch, the problem line from
   `disabledReason` (a reason with no picker carries **Edit the routine**),
   and its run or delivery history. Edit's Runs in lists the routine
   owner's threads.
3. A routine is created through **Add** → `On a schedule`, or `+ New
   routine` on the group, both of which open the wizard (Part H) on the
   schedule step.
4. `workflow_schedules` carries `disabled_reason`, set each time the
   scheduler disables a routine, and cleared on enable or a pin change;
   the wire exposes `disabledReason` and the routine's owner. Each reason
   names its fix: the pin text for an undeliverable pin, `Its prompt is
   empty. Edit the routine and add a prompt.`, `Its workflow was deleted.
   Edit the routine and pick another workflow.`, or `Its schedule does not
   parse. Edit the routine and fix the schedule.`

## Part F: Activity

*Conformance: web, api.*

1. Rows are dated sentences: `<event in words> in <place> → <outcome>`,
   with outcomes `replied in <thread>`, `delivered to <thread>`, `claimed
   by <thread>`, `started <workflow> run`, `skipped: <reason>`, `no one
   listening`, or the delivery's status line when pending, failed, or dead.
2. `/presence/activity` has a breadcrumb `Presence › Activity`. Chips
   filter the list: `All`, `Problems`, and one per service, each service
   chip led by its `ServiceMark size="sm"` (Part K). A text box labeled
   `Search`, with the placeholder `Search activity`, sends `q`. The search
   param `place=<place key>` asks `GET /api/events/log?place=` for the
   events whose natural subject's place is that key or lies inside it. The
   page then shows a removable chip above the list: `In <place name>`, or
   the service-wide place's own name (`Across GitHub`). A key that the
   places list does not hold reads by its last part (`In api`). Its remove
   button reads `Remove the place filter <chip text>`. Rows render through
   `Sentence` (Part K); the place token sits inside the row's link.
   Receipt stages and diagnostics sit under disclosures for admins. The
   event page keeps payload and redeliver. Its title is `<event in words>
   in <place>`, with the event's summary as a muted line under it, and each
   delivery links its line's name to the line's page.
3. A claim by a thread the viewer cannot open reads `claimed by another
   thread`; an archived thread renders a disabled link.
4. The **Needs attention** banner lists the workspace's distinct faults:
   lines with a problem, routines with a `disabledReason`, and lines with
   a dead delivery in the last day. A dead delivery counts once per line,
   and only when its line does not already list for its own problem, was
   not edited after the delivery, and no later delivery for the same event
   and line was delivered. The Log marks such a dead delivery with
   `supersededBy` and reads its event as delivered, so a redelivery clears
   the fault at once. A superseded dead delivery is not a fault. A routine
   item shows its `disabledReason` (Part E step 4), and each reason names
   its fix.

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
2. Step **When**: `Something happens in Slack`, `Something happens on
   GitHub`, `Something happens in Linear`, `On a schedule`, each led by its
   `ServiceMark size="lg"` (Part K). Launched from **Add**, all four show.
   A service that is not connected shows its choice disabled, with
   `Connect <service> first` linking to Integrations. The wizard opens on
   the first connected service in the order Slack, GitHub, Linear, and on
   `On a schedule` when none is connected. While the connection read is
   loading or has failed, no choice is disabled. Launched from a place,
   the place is fixed and only its service's choices show. Launched from
   `+ New routine`, the schedule step opens first. Launched from a
   workflow, the Do step is fixed on that workflow. Every event flow has
   four steps, and the header counts them (`Step 2 of 4`). A Reply flow
   reads When, Reply, Runs in, Review.
3. Step **What**: the event picker for the chosen service, headed `Which
   events?`, with filters. The service's common events come first under
   `Common`; the rest sit under a disclosure `More events (<n>)`. Each
   event reads in words. Raw event keys show only under `Advanced`. When
   the service is not connected, the step reads `Connect <service> to
   receive these events.` with an `Open Integrations` link.
4. Step **Do**: `Reply`, `Work on it`, `Run a workflow`. A non-Slack place
   never offers `Reply` or a Slack channel picker. The assistant choice
   reads `Your assistant`, `<team>'s assistant`, or `The organization's
   assistant`.
5. **Runs in** shows its default as a sentence with a `Change` link; the
   defaults are the thread policy spec's: mention → `new`; a notification
   or a workflow with a natural subject → `subject`; else `own`.
6. **Appears as** sits behind a disclosure.
7. Titles: `New routine` or `Listen for…`; the create button reads `Create`.
8. A preselected place filter stays through event changes; a filter the
   reader removed stays removed.
9. After Create, the overview MUST show the new row, and SHOULD scroll to
   and highlight its block.
10. The schedule step asks for days and a time: day toggles Monday to
    Sunday (weekdays by default), a time field (09:00 by default), and a
    time zone list that shows long names (`Pacific Daylight Time`), offers
    the browser's zone, and always offers UTC. A cron field sits under
    `Advanced`. When the reader types a cron, it wins and the day and time
    fields are disabled; the zone stays editable. The prompt is required:
    Next and Create stay disabled until it has text.
11. Review reads in words. The preview line at the top leads it, and the
    step lists When, Do, Runs in, and Appears as as facts, with no event
    keys, cron, or filters. The edit dialog opens with the line's sentence
    at the top. It hides the creator filter (Part C step 2) from the filter
    editor and shows it as `Only your own mentions`, or `Only mentions by
    <name>` when the viewer is not the creator. Save keeps the hidden
    filter.

## Part I: Threads

*Conformance: web.*

1. The thread context card's background section (event wakeups spec Part H)
   shows `Fed by: <names>`, each name a `line` token (`Ref kind="line"`,
   Part K) that links the line's or the routine's page, for every thread that a line or
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

## Part K: Marks and references

*Conformance: web.*

1. A **service mark** (`ServiceMark`) is a tinted tile with the service's
   glyph: the Slack hash, the GitHub mark, the Linear mark, and a clock for
   `On a schedule`. Each tile carries its service's brand wash, an alpha
   color over the page, so one value holds in light and dark themes. The
   sizes are:

   | Size | Tile | Glyph | Use |
   |---|---|---|---|
   | `sm` | 16px | 10px | Activity service chips, event picker group headings |
   | `md` | 24px | 14px | overview group headings |
   | `lg` | 28px | 16px | the place page header, the wizard's When choices |

   A mark is decoration: it is hidden from assistive technology unless it
   carries a label.
2. A **reference token** (`Ref`) names one thing inside a sentence. Its
   kinds are `place`, `thread`, `workflow`, `person`, and `line`. A `line`
   token names a line of presence or a routine: the proposal section's
   `Turning it on turns off <name>.` and the thread card's `Fed by` names
   use it. The token sits in the line of text at the text's size,
   in medium weight, on the ink wash, after a 12px mark for its kind. A
   place's mark is its service glyph in the service's hue, with no tile.
   A token is a link only when the thing has a page the viewer can open,
   and only outside a link or a dialog; otherwise it is plain text on its
   wash. A person has no page. A thread links only when the sentence knows
   its id.
3. `Sentence` renders a list of sentence parts: text parts and token
   parts. The sentence functions (`presenceSentenceParts`,
   `routineSentenceParts`, `activitySentenceParts`, `activityLeadParts`,
   `outcomeParts`) return the parts, and the string functions
   (`presenceSentence`, `routineSentence`, `activitySentence`) return
   `partsText` of those parts. So a
   test, a title, or an accessible name that reads the string reads the
   same words the page shows (INV-H7).
4. Marks appear on the overview group headings, the place page header, the
   wizard's When choices, the event picker's group headings, and the
   Activity service chips. Marks do not
   appear on place rows, because the group heading carries the mark, or on
   routine names, because a routine is not a workflow and has no token
   kind of its own.

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
- **INV-H7 A sentence's string equals its joined parts.** Mechanism: each
  string function is defined as the join of its parts function, so the two
  cannot differ. Vector: a test that renders fixture lines and routines
  through `Sentence` and compares the text with the string function.

## Testing

- Route tests for Part A step 4, one per row.
- Component tests for the sentence renderers (Part C step 2, Part E step 1,
  Part F step 1), one per `<do>` row and outcome.
- Overview tests: grouping and ordering (Part B steps 3, 4, 8), the
  sentence row without its place clause, the banner (Part B step 2, Part F
  step 4), the empty state, the scale rules at eleven places, the header
  pair, and a no-card assertion (no element in the roster carries a
  border radius or box shadow).
- The acceptance scenario as a router-level web test plus api integration
  (see Deviations).
- A copy lint for INV-H2 and a no-navigation test for INV-H5.

## Non-goals (normative boundary)

| Excluded | Why | Re-entry seam |
|---|---|---|
| Bulk enable or disable, line history, versioning | Beyond parity | A later spec |
| Pull requests or issues as rows on the overview | Transient; they live inside their repository's page | Part B step 4 |
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
  sets each time it disables the schedule. Enabling the schedule or
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
  loaded. The `Search` box sends `q`, which the server matches; the place
  filter is the server's `place` param (Part F step 2).
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
- **Needs attention follows the switcher (Part F step 4).** The banner
  lists the faults of the active workspace only: its lines, its routines,
  and its Activity rows. The banner changes when the reader switches
  workspace.
- **The breadcrumb separator is decoration (Part D step 1).** The `›`
  between crumbs is a hidden list item with padding. The breadcrumb's text
  is `Presence›acme/api›CI failures`, and each crumb is its own link or
  the current page.
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
  Part A step 4 lists its `tab` rows. Each `/workflows` row has a match
  condition, so a URL that no row takes serves the list.
- **Needs attention lists each fault once (Part F step 4).** A dead
  delivery names its line by `subscriptionId`. The banner adds that line
  only when the line has no `problem` and its `updatedAt` is before the
  delivery. So a line's problem and the dead delivery that caused it are
  one item, and a pick that fixes the line removes the item at once.
- **The empty state reads places and routines (Part B step 9).** The
  overview shows the empty state only when the workspace has no place
  row and no routine. A workspace with a routine is not empty: Valet
  already does something there on a schedule. The empty state shows only
  after both reads load.

Revision 3 deviations:

- **One appearance, said once (Part B step 5).** On the overview, when a
  line appears as the name and avatar that the place's `Appears as` line
  shows, its sentence drops `, as <appearance>`. A line with another
  appearance keeps the clause, so no line hides who it appears as. The
  place page keeps the clause on every line.
- **A service-wide row keeps the place clause for a line that names places
  (Part B step 4).** A line with `channel in [C1, C2]` names no single
  place, so it sits on `Everywhere in Slack`. Its sentence keeps `in #a or
  #b`, because `When someone mentions Valet, ...` would be false. A line
  with no place filter drops `in any channel`.
- **The schedule group does not count toward the threshold (Part B step
  8).** The threshold counts places only. Past ten places, `On a schedule`
  collapses with the other groups and stays open while a routine is off
  with a reason. The filter reads place names, so it never hides the
  schedule group, and filter text does not open it.
- **A line with no known service gets no row (Part B step 4).** A line
  whose event keys name no Slack, GitHub, or Linear key has no place and no
  service row. It shows on Activity and on its own page only.
- **Groups open on their own and never close on their own (Part B step
  8).** A collapsed group opens when it gains a fault, when the filter has
  text, or when a Create marks a row in it. It does not close when the
  fault clears or the filter empties, so a fix in progress or an open
  dialog stays in view. The reader's own toggle wins while the overview
  stays open.
- **A group the filter hides loses its open state (Part B step 8).** When
  the filter text matches no place in a group, the group leaves the page.
  When the text changes and the group comes back, it is collapsed again
  unless it has a fault. When the text matches no place at all, the
  overview shows `No place matches.` under the filter box.
- **A routine fault leads with the routine's name (Part B step 2).** A
  routine has no place, so its banner item reads `<name> is off: <reason>`
  with an `Edit` link. A line fault leads with `In <place>,` or with its
  service row's name (`Everywhere in Slack,`). A dead delivery leads with
  its line's place, else with the event's place.
- **Error alerts use danger color (Part B step 7).** A failed read
  (`Could not load Presence. Reload the page to try again.`) and a refused
  write show in danger color, because an error is a fault. Step 7 now says
  so.
- **A routine row leaves its schedule to the place column (Part B step
  6).** The place column reads `Every weekday at 9:00`, the timezone when
  it is not UTC, and `Next <date and time>`. So the sentence column reads
  `<name>: <do>.`, with the prompt as a muted line under it. The routine
  page and the Workflows panel keep the full Part E sentence. `Next` reads
  in the schedule's timezone on the row and on the routine page, so it
  agrees with the zone the row shows.
- **Activity offers Add only to an empty workspace (Part B step 9, Part F
  step 2).** The overview owns the onboarding paragraphs. Activity always
  shows its log. When the workspace has no place and no routine, Activity
  also shows an **Add** above the log, because it has no header pair.
- **The Create highlight goes through a module store (Part H step 9).**
  The header's **Add** lives in the section layout, outside the overview,
  so `created-highlight.ts` carries the new id from the wizard's
  `onCreated` to the overview. The overview marks the row only after the
  refetch lists the new id. A Create the overview never shows (a line with
  no row, or a row the filter hides) stays in the store until the next
  Create replaces it.
- **The `On a schedule` crumb may land at the top (Part E step 2).** The
  crumb links `/presence#schedule`. If the overview's lists are not cached,
  the anchor does not exist when the router scrolls, and the page opens at
  the top.
- **The section title shows on the overview only (Part A step 2).** The
  layout renders the `Presence` title, the workspace clause, the subtitle,
  and the action pair on `/presence` only. A detail page shows its
  breadcrumb, whose first crumb is `Presence`, and its own title as the
  page heading.
- **The banner's line item leads with its place (acceptance P2).** The
  item reads `In acme/api, Platform CI is archived. Pick another thread:`
  and does not name the line. The line's own row, under its place, carries
  its sentence and the same fix.

UX fixes (2026-10-18):

- **The web matches the old pin text too (Part C step 3).** The pin text is
  now `Pick another thread in Presence.` Lines dead-lettered before the
  change carry the old text, so the api's problem read and the web's
  `isPinProblem` match both texts.
- **Any org member may change an org line (Part C step 3).** The web
  mirrors the server's `canMutateSubscription`, which checks no admin role
  and no creator for an org line. A stricter rule must change the server
  first.
- **The paused team is a guess (Part C step 3).** The server does not
  record which team paused a line. The web looks for enabled team lines in
  the viewer's teams that share an event key, and names the team only when
  exactly one matches; otherwise it reads `the team`.
- **A proposal that replaces nothing is known only until edited (Part D
  step 1).** Without `replaces`, the web reads a `proposal-` id as a
  proposal only while `updatedAt` equals `createdAt`. An edit before Turn
  on makes the page read it as a plain off line.
- **Tokens inside dialogs are not links (Part K step 2).** The wizard
  preview and the edit dialog render `Sentence` without links, because a
  link would close the dialog and drop the draft.
- **The preview leads the review (Part H step 11).** The Review step does
  not repeat the sentence. The preview line at the top of the dialog is
  the sentence, and the step lists the facts under it.
- **A routine name has no glyph (Part K step 4).** A routine is not a
  workflow, and no routine token kind exists, so its name is plain text.
- **An Advanced cron reads as typed (Part H step 10).** A cron outside the
  common shapes reads `On the schedule <cron>` in the preview and the
  Review step. The reader typed it, so the wizard shows it back unchanged.
- **Names come from the org directory (Part C step 2).** The sentences read
  member names from `useOrgDirectory`, which every member may read.
  `useOrgMembers` answers only org admins, so a member would get 403.
- **The team Slack setup counts three steps (Part H step 2).** The team
  setup fixes the When step, so its header reads `Step n of 3`: Reply,
  Runs in, Review.
- **Supersession needs a later millisecond (Part F step 4).** A delivered
  row supersedes a dead row only when its `created_at` is strictly later.
  Two rows from the same millisecond keep the fault in view, which errs
  toward showing a fault.
- **The thread card says `active` (INV-H2).** The background section of the
  thread context card reads `Active: <name>`, and the composer's background
  status line counts `1 active` or `2 active`. Neither says `Event waiter`.
  The status line still names the oldest active thread's place as `waiting
  on <place>`, a verb and not the retired noun. This retires the revision
  2 deviation that kept the noun `wait`.
- **View all filters by place on the server (Part C step 7).** `View all`
  sends `place` and no longer searches a Slack channel by its id through
  `q`. This retires the revision 2 deviation for that search.
- **Tokens inside a linked row are not links (Part K).** A sentence row's
  sentence, an Activity row's lead, and a place page's activity row each
  sit inside one link. Their tokens render with `links={false}`, because an
  anchor inside an anchor is invalid HTML and splits the click target. The
  tokens in a page title, a **Needs attention** item, an Activity outcome,
  and `Fed by` do link.
- **Sentence links and headings carry a plain-sentence aria-label (Part
  K).** A token is an `inline-flex` box, so browsers and jsdom compute the
  accessible name of a token sentence with stray spaces (`acme/api ,`). A
  sentence link and a page `h1` that render tokens carry the sentence's
  `partsText` as `aria-label`, so a screen reader and a test read the
  plain sentence.

Revision 1 deviations that revision 2 retired: the All listeners view, the
place header's reach label, the empty service-wide row rule, and the
routine page as a tab child.

Revision 2 deviations that revision 3 retires: the rail's filter box and
collapse rules (replaced by Part B step 8), the plain group header for a
service without a service-wide row (a service block exists only when lines
name no place), the Activity landing, the `Activity` and `Routines` rail
counts (replaced by the banner), the `/presence/routines?routine=<id>`
page (now `/presence/routines/<id>`), and the ungated routine row switch
(the roster row reads `routineReadOnly`).
