# Presence hub

Date: 2026-10-16. Revised 2026-10-17 (rail layout, vocabulary), 2026-10-18 (overview landing; roster presentation), and 2026-10-22 (exclusion conditions). Status: implemented (revision 4); UX fixes 2026-10-18; revision 4 (line page and editor) 2026-10-18; review fixes 2026-10-19.

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
| Set up: "make Valet answer in #incidents" | first visit, then rarely | one **Add** button and an editor that reads back as a sentence |
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
| **Where**: the editor section and the How it works column that say where Valet works; `Runs in` is retired | thread policy |
| **active**: a thread currently waiting on this place | event waiter |
| **following**: a Slack thread whose replies reach a Valet thread | followed thread |
| **Activity**: what happened. On a line's page, each entry is **acted** (Valet did something, and where) or **skipped** (it did not, and why, in words) | events, deliveries, receipt decisions |
| **Diagnostics**: the stage-by-stage intake trail, for organization admins | receipts and their stages |
| **editor**: the full-height sheet that creates and edits a line or a routine | `LineEditor`; it replaced the wizard and the edit dialogs |
| **Needs attention**: the banner of things to fix | problems: an archived pin, a disabled routine, a dead delivery |
| **workflow**, **run** | unchanged; their own top-nav entry |

UI copy MUST NOT use "listener", "automation", "subscription", "trigger",
"subject", "rule", "event waiter", "delivery", "receipt", or "Runs in" for
these objects. "Event" appears
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
| P5 | Click **+ Listen for…** on the `#incidents` row of the overview, then pick `Someone mentions Valet`. | The editor opens full height with **When** expanded, Slack as the only service, and the condition `channel is #incidents` already set. The side pane reads `When someone mentions Valet in #incidents, reply in a new thread.` and the example `Someone mentions Valet in #incidents.`, `Valet reads the message.`, `It replies in a new thread, as Valet.` **Create** stores a rule with policy `{ mode: "new" }`, and the `#incidents` row lists it. |
| P6 | Click **Add**, choose `On a schedule`, set weekdays at 9:00, a prompt, and a name. | The editor's **When** offers the three services and `On a schedule`. The side pane reads `Every weekday at 9:00, <name>: work in its own thread.` The row appears under `On a schedule` with `Every weekday at 9:00`, `Next <date and time>`, and **Fire now**. |
| P7 | Open R4 from its row. | The page shows a breadcrumb `Presence › acme/api › CI failures`, the sentence as the title led by the GitHub mark, and a status line with the name `CI failures`, `set up by <creator> <time ago>`, and the switch reading `On`. The health strip reads `never` for `last acted`, `0` for `times in 30 days`, and `Needs attention` over `Platform CI is archived`, with a 30-day pulse. The problem line with the picker follows. **How it works** is the editor with every section open: When `a check completes on acme/api`, Do `work on it`, Where `in the Platform CI thread`, Appears as, and Name `CI failures`, with no `Change`. **Activity** shows the acted entry `Completed check on acme/api#14 → could not reach Platform CI, it is archived` with a filled mark, and chips `All`, `Acted`, `Skipped`. |
| P8 | Pick a new thread in the picker, then return to `/presence`. | The problem line is gone, the sentence ends with the new thread's title, and the **Needs attention** banner is gone. |
| P9 | Click **Activity** in the header, choose the `Problems` chip. | `/presence/activity` lists the dead-lettered delivery as `Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver`. With the chip off, the C2 mention appears as `Mention in #incidents → replied in t-inc`. The breadcrumb reads `Presence › Activity`. |
| P10 | Open `/workflows`. | The Workflows page shows the workflow list and a Runs view at its own URL. The editor's panel lists this workflow's presence lines and routines as sentences, and its **Add** opens the editor fixed on the workflow. |
| P11 | Open thread `t-inc`. | The thread context card shows `Fed by: Incident mentions, Channel watch` with links; `acme/api#12`'s header names its place, `acme/api#12`. |
| P12 | Visit `/events?tab=subscriptions`, `/events/<eventId>`, `/channel?key=slack:C900`, `/presence/listeners/<id>`, `/presence/routines`, `/presence/routines?routine=<id>`, `/presence/workflows`, `/presence/runs/<runId>`. | Each redirects: the first three into Presence, `/presence/listeners/<id>` to `/presence/rules/<id>`, `/presence/routines` to `/presence`, `/presence/routines?routine=<id>` to `/presence/routines/<id>`, the last two to `/workflows`. No URL returns a 404. |
| P13 | Open a proposal from its `Proposed` row and press **Turn on**. | The page shows `Proposed by the assistant.` and, when the proposal replaces a line, `Turning it on turns off <name>.` **Turn on** opens the editor in review mode: every section summarized, the side pane note `Proposed by the assistant. Turning it on turns off Reviews and checks.`, and **Turn on** in place of **Save**. After the reader confirms, the line is on, its row reads its sentence without `Proposed`, and the line it replaces is off. |
| P14 | As a user outside `sre`, open a `sre` line from the `sre` workspace. | On the overview row, the switch and the row menu's Edit, Appears as, and Delete are disabled. The line's page shows the `Team` mark, disables the switch, **Delete**, and the How it works form, hides the thread picker, and reads `Only members of SRE can change this.` |
| P15 | Delete the workflow of a routine that runs a workflow, then let the routine fire. | The routine is off. The **Needs attention** banner reads `<name> is off: Its workflow was deleted. Delete this routine and make a new one with another workflow.` with an `Edit` link to `/presence/routines/<id>`. |
| P16 | With Slack, GitHub, and Linear all not connected, click **Add**. | The editor's **When** opens on `On a schedule`. The Slack, GitHub, and Linear service choices are disabled, each with `Connect first`. The line under them reads `To use another service, connect it in Integrations.` and links to Integrations. |
| P17 | On the `acme/api` place page, click **View all** under **Recent activity**. | `/presence/activity?place=github:acme/api` opens with the removable chip `In acme/api` and lists only events whose place is `acme/api` or inside it. Removing the chip lists every event again. |
| P18 | On R4's page, choose the `Skipped` chip. | The timeline keeps only skipped entries, such as `Completed check on acme/web#8 → skipped, not for this line: the repository filter`, each with a hollow mark. Choosing `Acted` keeps only the acted entries. An organization admin also sees **Diagnostics**; a member does not. |
| P19 | On R4's page, under How it works, pick `Its own thread` in **Where**, and press **Save**. | The Where options read as cards with one explanation line each. The pick shows the bar with the sentence the change stores. After Save the page title ends with `work in its own thread.`, the health strip's `Needs attention` is gone, and the bar is gone. |
| P20 | Click **Add**, choose `A reply in one Slack thread`, and paste `https://acme.slack.com/archives/C900/p1750000000123456`. | The side pane reads `When someone replies in the Slack thread in C900, work in its own thread.` The link names the channel by its id, so the sentence does too. **Create** stores `slack.message` with the conditions `channel` `C900` and `thread_ts` `1750000000.123456`, and the policy `{ mode: "own" }`. |

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
   opens the editor (Part H) on the When section with all four choices. The
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
   of presence. A pull request or issue MUST NOT appear: the overview
   groups lines by `placeKey` (step 10). Lines whose
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
   When every line of the place shares one appearance, one `Appears as
   <name>` line with the avatar follows the sentences and the sentences
   drop their `as <appearance>` clause. When the lines differ, each
   sentence keeps its own clause and no row line shows. The sentence column ends
   with a quiet `+ Listen for…` that opens the editor fixed on that place.
6. The `On a schedule` group uses the same grid: the schedule in words in
   the place column (`Every weekday at 9:00`, then the timezone's long
   name (`Pacific Daylight Time`) when it is not UTC, then `Next <time>` or `Off`), and in the sentence column the
   Part E step 1 routine sentence with **Fire now**, the switch, and the
   overflow menu, ending with `+ New routine`, which opens the editor on
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
   integration connected. The overview and Activity use one emptiness
   rule: no line, no routine, and no place; a place that only threads or
   events touched does not count as presence.
10. Reads: `GET /api/presence/places` (every grain; the overview keeps the
    mid grain and the service roots), `GET /api/event-subscriptions` (the
    sentences), and the workspace's schedules, refreshed on every write the
    section makes and every 60 seconds. Loading reads `Loading…` in place of
    the groups; a failed read names its fix. Each line on
    `GET /api/event-subscriptions` and on a place page's listeners carries
    `placeKey`: the row the places read lists it at, rolled up from a pull
    request or a Linear issue to its parent row. The overview groups a line
    by `placeKey`, so a line and its row's place page agree. Both reads
    pick the Slack workspace in one way: the org's bot credential, else the
    team of the org's newest Slack subject thread, else the team of its
    newest Slack event in the last 30 days. A Slack line
    has no `placeKey` while none of these names a Slack workspace; the
    overview then groups it by its filters. The places read issues a
    bounded number of queries regardless of how many conversations the
    workspace has. It judges visibility only for the threads a place can
    show (subject threads and the threads that follows and running waiters
    name), and it never selects an event's payload. The visibility query
    walks each linked session's parent chain once. Its `walked` CTE is
    `MATERIALIZED`, so PostgreSQL cannot inline it and repeat the walks
    for each thread row. A read slower than one
    second logs one line with its scope, duration, and session count.
    The places read also returns `channelNames`: the name of each Slack
    channel that an exact `channel` filter of the workspace's lines names,
    by channel id. A line over several channels lists at the Slack
    workspace, so each of its channels is a place only when a thread, a
    follow, a waiter, or a recent event names it. A channel's name comes
    from the bot's channel list (every channel it has joined, with no
    picker limit), else a filter's label or a recent event. The api keeps
    the list for five minutes, and a failed list for one minute. The list
    says which channels are private. A public channel on it shows its
    name with no further Slack call. A private channel that is no place
    keeps its id, because its name would take a membership check for each
    viewer. A channel the bot has not joined keeps its id too. The place
    page read does not name a line's channels, so it reads the list only
    for its channel places.
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
   | assistant, Reply (`follow: true`), `new` | `reply in a new thread` |
   | assistant, Work on it, `new` | `work in a new thread each time` |
   | assistant, `subject` | `work in one thread per <pull request \| issue \| channel>` |
   | assistant, `own` | `work in its own thread` |
   | assistant, `existing` | `work in the <title> thread` |
   | workflow | `run <workflow name>` |

   `reply` appears only for a Reply line (`follow: true`); every other
   assistant line reads `work`, in the sentence, in How it works, and in
   the line's Activity. A wildcard key reads in words: `slack.*` as
   `anything happens in Slack`, `github.pull_request.*` as `a pull request
   changes`. A place field with an operator other than `is` or `in` names
   no place; it reads as a condition (`on a repository that starts with
   acme/`, `in a channel that is not #random`). When the api scopes a line to its creator, that actor applies
   to every clause whose key carries `user` (`When you mention Valet or you
   post a message in #incidents`). A labeled sender on a mention line is
   the actor (`When Alice mentions Valet`). A Slack channel in `<place>`
   reads the filter's own label, then the channel's name from the places
   read (`#proj-valet`), then the raw channel id. The places read names
   every channel that a line's exact `channel` filter names, also a channel
   that is no place (Part B step 10).

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
   pick patches the line and clears the problem. When the switch's turn-on
   (or **Keep both**) returns a 409 because another line covers the same
   events, the row shows the server's text with **Turn on anyway**, which
   patches `{ enabled: true, allowCollision: true }`. A paused personal line
   reads `Paused: <team name> already listens for this.` (`the team` when
   the viewer's lines name no single team) with **Keep both**, which patches
   `{ pauseOnOverlap: false, enabled: true }`. A team or org line carries a
   `Team` or `Org` mark, and its Delete confirm names the owner. A proposal
   reads `Proposed` in place of `Off`. A viewer outside the line's owner
   reads who may change it: `Only members of <team name> can change this.`
   or `Only its owner can change this.` That text accompanies every
   problem, with or without a picker. The web mirrors the server's gate:
   the owner of a personal line, the members of a team line, and any org
   member for an org line.
4. The **Listen for…** button opens the editor (Part H) fixed on this place.
5. **Threads**: `Active now` (threads waiting here), `Following` (Slack
   threads bound here), and for a repository or team `One thread per pull
   request` or `One thread per issue` listing the subject threads; each a
   link.
6. **Appears as**: shown when every line here shares one appearance
   (Part B step 5).
7. The page lists its own lines and every line whose `placeKey` row is
   this place, so a pull request line appears on its repository's page
   and keeps its own page.
8. **Recent activity**: the last ten rows for this place (Part F grammar)
   and `View all`, which opens Activity with `place=<place key>` (Part F
   step 2).
9. Empty state: a place that exists only because events or threads touched
   it reads `Nothing is set up here yet.` with **Listen for…**.

## Part D: One line of presence

*Conformance: web, api.*

1. `/presence/rules/$id` is the line's page. Its parts, in order:
   1. Breadcrumb `Presence › <place> › <name>`.
   2. **Title**: the Part C step 2 sentence with its tokens (Part K), led
      by the service's `ServiceMark size="lg"`.
   3. **Status line**: the line's name, `set up by <creator> <time ago>`
      (the creator as a person token), the on/off switch with `On` or
      `Off`, and at the right the overflow menu with Delete. A `Team` or `Org` mark follows
      the name on a line the viewer's personal workspace does not own. A
      proposal has no switch and no Delete in the menu: its review
      (step 2) carries both.
   4. **Health strip**: one ruled row with `last acted` (`<time ago>` or
      `never`), `times in 30 days` (the count of acted entries), the fault
      (`Needs attention` with the fault text under it) when one exists, and
      at the right a 30-day pulse: one bar per day, height by the day's
      acted count, the last day emphasized. The strip reads from the line's
      Activity (step 3). It is informative on a routine page too (Part E).
   5. The **problem line** (Part C step 3) with its picker, when a fault
      exists.
   6. **How it works**: the editor's form (Part H) on the page, with
      every section open: **When**, **Do**, **Where**, **Appears as**, and
      **Name**. No section has `Change`, and no sheet opens. A change shows
      a bar at the bottom of the view with the sentence the change stores,
      the warnings, and **Cancel** and **Save**. Cancel drops the change.
      Leaving the page with a change asks `Leave without saving?`. The form
      reads the stored line at mount, and the patch diffs against that
      copy. A save moves the copy to the line as saved, so a change back
      to the first value still sends. While the form is clean, a refetched
      line that reads differently mounts a new form on it (filter row ids
      do not count); while the reader has a change,
      the form keeps it. A move to another line's page starts a new form,
      so a change is never saved to a different line. The form is locked
      while a save is in flight and until the line list is read again, so
      a later refetch never replaces a newer edit. After a save that stores the line with
      overlaps, the form is frozen and leaving does not ask. Delete opens
      Presence without asking, because the change has nothing to save into. Amended 2026-10-20: How it works was three
      read-only columns with an explanation each and a `Change` that opened
      the sheet on that section.
   7. **Activity**: one timeline, grouped by day, newest first, with chips
      `All`, `Acted`, `Skipped`. An **acted** entry carries a filled mark
      and reads `<event in words> on|in <place token> → <outcome>` with the
      outcomes `worked in <thread>`, `replied in <thread>`, `started
      <workflow> run`, `could not reach <thread>, it is archived`, `gave
      up after <n> tries`, `waiting for the first attempt`, and `failed,
      Valet tries again`. `replied in` appears only for a Reply line. The
      right column reads the time it took (`40 s`, `2 min`), or for a dead
      entry `gave up` in danger color, with the api's error and fix text
      once under it. A Slack place reads its channel name. A **skipped**
      entry carries a hollow mark and reads `<event in words> on|in <place
      token> → skipped, <reason>` with the reasons `not for this line: <the
      filter in words>`, `the sender is not allowed`, `the line was off`,
      `another line claimed it`, or the skip text the api recorded, with
      its leading `Skipped,` removed so the word appears once. `on`
      precedes a GitHub place and `in` a Slack or Linear place. `Show
      earlier` loads the next page. The timeline polls every 30 seconds
      while at most one loaded page holds entries. When a page is empty and a cursor
      follows, the page fetches the next one itself, at most three times,
      then reads `Nothing in the newest entries. To look further back,
      select Show earlier.` A chip that keeps no entry reads
      `Nothing skipped here yet. Choose All to see every entry.` or its
      `acted` form.
   8. **Diagnostics** (organization admins only): a closed disclosure that
      lists the intake records of the last 7 days that name this line:
      each event in words, this line's decision, and the last intake
      stage. A member sees no Diagnostics, and the page does not read
      them.
2. A proposal (off, and carrying `replaces` or an untouched `proposal-` id)
   shows, above the health strip, `Proposed by the assistant.`, then
   `Turning it on turns off <name>.` when it replaces a line, with **Turn
   on** (the editor in review mode, Part H step 10) and **Delete** in
   place of the switch. How it works edits the proposal in place. When the
   replaced line is gone or already off, the notice reads `The line this
   proposal replaces is gone. Delete this proposal and make a new line.`
   and only **Delete** is offered.
3. The page follows the Part C step 3 gate: for a viewer who may not
   change the line, the switch, **Delete**, and the How it works form
   are disabled, the picker is hidden, every problem carries the
   who-may-change text, and the status line reads
   `Only members of <team name> can change this.` or `Only its owner can
   change this.`
4. Api: `GET /api/event-subscriptions/:id/activity?before=<cursor>` returns
   the line's timeline: its deliveries as acted entries (with `tookMs` when
   known), and the receipt decisions that skipped it as skipped entries.
   A skipped entry for an event whose place the line does not name is
   returned only to an organization admin; the gate reads the exact set
   of places the line names, never their common parent, and falls back
   to the whole service only for a line that names no place. A pattern
   op on a place field (`repo prefix acme/`, `team contains EN`) names no
   place the gate can list, so a member gets no skipped entry for that
   service. A line that puts a condition on a place field of any service
   gets no service-wide fallback for its other services, so a Slack and
   GitHub line with `channel eq C1` gives a member no GitHub skips. Each acted
   entry carries `attempts`. Slack channels read their names. A cursor
   whose time is not a whole number is refused with a 400 that reads
   `Reload Activity and try again.` The response carries the
   counts the health strip shows (`actedLast30Days`, `lastActedAt`,
   `perDay`). The counts read the same rows the timeline lists as acted:
   every delivery that is not skipped and that no later delivery settled,
   whatever its status. Each row counts on the day it landed, or on the
   day it was created when it has not landed. `GET /api/event-subscriptions/:id/deliveries` stays for
   callers that want deliveries alone. `EventSubscriptionWire` carries
   `problem?: string` as before, on the list route and on a place page's
   listeners. `PATCH /api/event-subscriptions/:id` accepts `allowCollision`
   with `enabled: true` as POST does. The 409 text names the button for
   the write: `Create anyway` for a POST, `Turn on anyway` for a PATCH that
   turns the line on, `Save anyway` for any other PATCH.

## Part E: Routines

*Depends on: delivery threads spec Part A. Conformance: web, api.*

1. A routine row is one sentence: `<schedule in words>, <name>: <do>.` with
   `<do>` as `work in its own thread`, `work in a new thread each time`,
   `work in the <title> thread`, or `run <workflow>`; plus `Next: <time>`
   or `Off`, an on/off switch, and **Fire now**. The timezone's long name
   (`Pacific Daylight Time`) follows the schedule words when it is not
   UTC, in the row, the routine page title, the How it works When column,
   and the editor's side pane. The rows live in the overview's `On
   a schedule` group (Part B step 6), where `Next <time>` sits in the
   place column. A routine that runs a workflow of its own name leaves out
   `<name>: `, so the name reads once: `Every day at 6:00, run Nightly
   memory sweep.` A template install names its routine after the workflow
   it installs, with the same install count (`Nightly memory sweep (2)`).
   The count is one more than the highest number in use, so deleting an
   earlier install never makes a later one repeat a number. The count reads
   the owner's workflow names and routine names, because a renamed workflow
   keeps its routine's name. Installs of one
   template for one owner run one at a time. The row keeps the routine's own
   name as written (`iOS release check`); only the leadless `Run <workflow>`
   form gets a capital.
2. `/presence/routines/$id` follows the line page's anatomy (Part D step
   1): breadcrumb `Presence › On a schedule › <name>`, the sentence as the
   title with the clock mark, the status line (name, `set up by <owner>`
   for a personal routine, the switch, `Next: <time>` while on, **Fire
   now**, the overflow menu with Delete), the health strip
   (`last fired`, `times in 30 days` as the sum of the pulse's bars, the
   fault, the pulse), the problem line from `disabledReason` (after a re-pin that clears
   the pin reason while the routine stays off, the line reads `Pinned.
   Turn the routine on to resume.` beside the switch), **How it works** as
   the editor with every section open (Part D step 1.6; a routine has no
   Appears as), and **Activity** as its firings
   without chips (each `Fired → worked in <thread>` or `Fired → started
   <workflow> run`). When the viewer may open the routine's thread, `its
   own thread` links that thread in the title and in the
   firing row, and a `new` routine's firing row links the thread that
   firing landed on (`a new thread`). The words do not change. An archived
   thread shows as a disabled link. Without a thread the viewer may open,
   the words stay plain text. A workflow routine's firings are the runs
   it started among the workflow's last 50 runs, each with the time it took; **Fire
   now** refreshes them. Where lists the routine owner's threads.
3. A routine is created through **Add** → `On a schedule`, or `+ New
   routine` on the group, both of which open the editor (Part H) with
   **When** set to `On a schedule`.
4. `workflow_schedules` carries `disabled_reason`, set each time the
   scheduler disables a routine. The wire exposes `disabledReason` and the
   routine's owner. Each reason names its fix: the pin text for an
   undeliverable pin, `Its prompt is empty. Edit the routine and add a
   prompt.`, `Its workflow was deleted. Delete this routine and make a
   new one with another workflow.` (a routine's workflow cannot change),
   or `Its schedule does not parse. Edit the routine and fix
   the schedule.` An enable clears any reason. An edit of the field a
   reason names also clears it: the schedule or its timezone for the
   schedule reason (through the editor or a repository sync), and the
   prompt for the prompt reason. A thread change
   clears the pin reason. A PATCH cannot change a routine's workflow, so
   the workflow reason clears only on enable.
5. `workflow_schedules` carries `last_fired_session_id` and
   `last_fired_thread_id`, two new nullable text columns edited in place
   in `0000_app.sql`, with a matching `SCHEMA_REPAIRS` entry for each. The
   scheduler and **Fire now** write them from the thread each
   assistant-prompt firing lands on. A workflow routine writes neither,
   because its firings are runs. No backfill runs. The triggers list
   gives each schedule `lastFiredThread` (`sessionId`, `threadId`,
   `title`, `archived`): the recorded thread, or, for the `own` policy
   with no recorded firing, the thread keyed `schedule:<id>` in the
   owner's assistant. The list checks the thread as the event page checks
   its thread links (`readableThreads`). A thread the viewer may not open
   reads as null. The recorded pair belongs to the policy that chose it: a
   change of the thread policy clears both columns, and a firing writes
   them only while the row still holds the policy the firing read. The
   list reads the recorded pairs by thread id and the `schedule:<id>`
   keys by the owners' assistant sessions, in two queries, so neither
   scans `engine_threads`.

## Part F: Activity

*Conformance: web, api.*

1. Rows are dated sentences: `<event in words> in <place> → <outcome>`,
   with outcomes `replied in <thread>`, `delivered to <thread>`, `claimed
   by <thread>`, `started <workflow> run`, `skipped: <reason>`, `no one
   listening`, or the delivery's status line when pending, failed, or dead.
   A delivered row follows its line's stored action, as the line page does
   (Part D): it reads `replied in` only for a Reply line (`follow: true`).
   The Log reads the workspace's lines (`repliesByListener`). Only a row
   whose line is gone falls back to the event key: a conversational key
   reads `replied in`.
2. `/presence/activity` has a breadcrumb `Presence › Activity`. Chips
   filter the list: `All`, `Problems`, and one per service, each service
   chip led by its `ServiceMark size="sm"` (Part K). A text box labeled
   `Search`, with the placeholder `Search activity`, sends `q`. The search
   param `place=<place key>` asks `GET /api/events/log?place=` for the
   events whose natural subject's place is that key or lies inside it. The
   page then shows a removable chip above the list: `In <place name>`, or
   the service-wide place's own name (`Across GitHub`). A key that the
   places list does not hold reads by its last part (`In api`). Its remove
   button reads `Remove the place filter <chip text>`. With no row, the
   list reads `Nothing happened in <place name> in the last 30 days.` when
   only the place filters, `Nothing matches. Choose All or remove the
   place.` when the place and another filter are set, and `No activity
   yet.` only when nothing filters. Rows render through `Sentence` (Part
   K), keyed by delivery; the place token sits inside the row's link. A
   dead delivery in **Needs attention** renders through the same parts.
   **Diagnostics** (the intake trail, stage by stage, with each line's
   decision) sits under one disclosure for organization admins, above the
   list. It replaces the `Receipts` disclosure of earlier revisions and
   the `Show diagnostics` checkbox: every reader sees the disclosure,
   which adds incoming events and the organization's problems to the
   list, and an admin also sees the intake trail. Its open state is
   `diagnostics=1` in the URL. When a service chip leaves no loaded row
   and more pages exist, the list reads `No <service> events in the loaded
   rows. Load more to look further.` and keeps **Load more**. When the
   place filter's scan reaches its limit with no row, the api returns the
   cursor at that point so **Show more** continues. The event page
   keeps payload and redeliver, and lists the intake trail under `Intake
   stages`. Its title is `<event in words>
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
   **Add** opens the editor fixed on the workflow (`fixedWorkflowId`): Do
   is locked on `Run a workflow` and the picker is read-only. The editor's
   **More** menu has **Delete**, with the list's confirm. `GET
   /api/workflows/:id/webhook` answers `200 { webhook: null }` when no
   webhook exists.

## Part H: The editor

*Conformance: web.*

1. One **editor** creates and edits a line or a routine. To create, to
   review a proposal, and to edit from a row, it is a full-height
   sheet (a modal that fills the viewport height, up to 1180px wide) with
   two panes: the **form** on the left (seven twelfths) and the **side
   pane** on the right (five twelfths). On a phone the panes stack, the
   side pane's sentence first as a sticky header. The sheet closes on Esc
   and on Cancel; a draft with changes asks `Discard your changes?` first.
   Esc and a click outside do nothing while a request is pending. On
   close, focus returns to the control that opened the sheet. The form
   reads the line or routine once, at open, and the patch diffs against
   that copy, so a refresh while the sheet is open never reverts another
   person's change. After a save that stores the line but reports
   overlaps, the form freezes, the overlap notice stays, and the footer
   offers one **Done**, which closes the sheet.
2. The form is a list of **sections**, each one row: its name in a fixed
   left column (`When`, `Do`, `Where`, `Appears as`, `Name`), its summary
   in words, and `Change` (or `Close` when open). A section opens in place
   under its row; one section is open at a time. On create, **When** opens
   first and the others show their defaults as summaries; on edit, every
   section shows its summary. A launch point MAY name the section to open
   (a row's `Appears as` opens its own section). A line's or a routine's
   own page holds the same form inline, every section open, with no
   sheet (Part D step 1.6). A routine has no **Appears
   as**. A line that runs a workflow shows **Where** as `Set by the
   workflow`, with no `Change`. The sheet's heading is the line's or the
   routine's name on edit. On create it is the name or the suggested
   name, and `New` until one exists.
3. **When**: a row of service choices (`Slack`, `GitHub`, `Linear`, `On a
   schedule`), each a `ServiceMark size="md"` with its name; a service that
   is not connected is disabled with `Connect first`, and a line under the
   choices links to Integrations. Launched from a place, the service is
   fixed and the place is a condition already set. On edit, the service
   is the line's own and cannot change; a routine stays a routine.
   Under the service, **Events**: the common events as checkboxes in words
   (`A pull request is opened`) and `More events` as a disclosure; raw
   event keys only under `Advanced`. Under the events, **Only when**: the
   conditions as removable pills in words (`repository is acme/api`,
   `channel is #incidents`, `author is jack`) and `+ Add a condition`,
   which offers the fields these events carry. A condition compares with
   `is`, `is one of`, `is not`, `starts with`, `doesn't start with`,
   `contains`, `matches`, or `doesn't match`. `is not` (`not_in`),
   `doesn't start with` (`not_prefix`), and `doesn't match` (`not_regex`)
   skip the events they name, so the pill `bot is not B0123ABCD` keeps that
   app's posts from starting a turn. An event with no value for the field
   still matches an exclusion. `is one of` and `is not` take a
   comma-separated list. Only `is` picks its value from a list such as the
   channels or users; every other comparison takes typed text. The hidden creator scope
   (Part C step 2) shows as a pill `your own mentions` (or `mentions by
   <creator>` on another person's line) that cannot be removed. A mention
   with no channel condition offers `Any channel`; Save refuses both
   together. For Slack, a **Listen for** choice comes first: `A mention or
   other events` (the events and conditions) or `A reply in one
   Slack thread`, which takes a `Paste the thread's link` field. A thread
   follow stores `slack.message` with `channel` and `thread_ts`
   conditions, and its Where defaults to `Its own thread`. For `On a
   schedule`, this section holds the day and time control (step 7).
4. **Do**: three cards, `Reply` (Slack only, enabled once a mention is
   picked, with `Reply answers a mention. To reply, pick the mention in
   When.` until then), `Work on it`, `Run a workflow`, each with one
   explanation line; `Run a workflow` shows the workflow picker. A routine offers `Work on it` and `Run a workflow`.
   Under the cards, **Instructions (optional)** as a multi-line field, at
   least six rows high and growing with its text, with the hint `Plain words. Valet also receives the event itself.` The
   instructions take no inserts. Under `Advanced`, **Event message
   (optional)** holds the message template, with a menu `Insert a detail
   from the event` that lists the event's summary, its text, and the
   fields the picked events carry, and inserts the template for the
   chosen one. For a routine that runs the assistant, the field reads
   **Instructions (required)**. The assistant choice (`Your assistant`,
   `<team>'s assistant`, `The organization's assistant`) shows only when
   the workspace offers more than one. A team assistant's `Reply` adds
   `Who can mention it`. On edit, Do shows only the stored choice, as one
   card with `This stays fixed. To change it, delete this line and make a
   new one.` inside it, so the note never reads as the instructions'
   placeholder. The assistant choice is disabled.
5. **Where**: the thread policies as cards with one explanation line each:
   `One thread per <pull request | issue | channel>` (`Each pull request
   gets its own thread; every event for it lands there.`), `A new thread
   each time` (`Every event starts fresh.`), `Its own thread` (`One running
   thread for this line.`), and `The <title> thread` (`An existing thread
   you pick. If it is archived, this line stops until you pick another.`)
   with the thread picker inline (`Pick a thread` until one is
   picked). A routine reads `Every run starts fresh.` and `This routine's
   thread`. The default follows the thread policy spec. For a personal
   line that a team line may also cover, a sub-option `When <team> also
   listens` offers `Pause this line` or `Keep both`.
6. **Appears as**: display name and avatar URL with a live avatar chip;
   collapsed by default. **Name**: a text field with a suggested name from
   the sentence (`CI failures`) that the reader can keep or change.
7. The schedule control (in **When** for `On a schedule`): day toggles
   Monday to Sunday (weekdays by default), a time field (09:00 by default),
   and a time zone list with long names, the browser's zone selected and
   UTC always offered. A cron field sits under `Advanced`; a typed cron
   wins and disables the day and time fields. Instructions (step 4) are
   required for a routine that runs the assistant.
8. The side pane shows, top to bottom: **This line reads** with the Part C
   sentence and its tokens, updated with every change; **For example**, a
   three-step worked example from the current choices (`A check
   completes on acme/api.`, `Valet reads the event and your
   instructions.`, `It works in Platform CI, as Valet.`); warnings (a
   collision: `<line> also acts on <events> for <place>. Both will run.`
   with the line as a token; a not-connected service; a missing name or
   event); the
   permissions note `Uses this workspace's existing access. Saving grants
   nothing new.`; and the footer with `Edited <time ago>` or nothing,
   **Cancel**, and **Create** or **Save**. Create and Save are disabled
   with the reason beside them until the draft is valid. The client
   refuses what the api refuses, in UI words: a mention mixed with another
   Slack event, a `user` condition on a personal mention line, a variable
   other than `{{event.key}}` in Instructions, an Event message variable
   whose event is not picked, `Any channel` with a channel condition, Reply
   without a mention, and run input that is not JSON.
9. The sentence in the side pane equals the stored sentence (INV-H7 holds
   for the draft). After Create, the overview MUST show the new row and
   SHOULD scroll to and highlight it. After Save from a line's page, the
   page reflects the change without a reload.
10. Review mode (a proposal's **Turn on**): the editor opens with every
    section summarized, a notice `Proposed by the assistant. Turning it on
    turns off <name>.` (or `It stays off until you turn it on.`) in the
    side pane, and **Turn on** in place of Save. When the replaced line is
    gone or already off, the notice reads `The line this proposal replaces
    is gone. Delete this proposal and make a new line.` and there is no
    **Turn on**.
11. A preselected place condition stays through event changes; a condition
    the reader removed stays removed.

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
   | `sm` | 16px | 10px | Activity service chips |
   | `md` | 24px | 14px | overview group headings, the editor's When choices |
   | `lg` | 28px | 16px | the place page header, the line and routine page titles |

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
4. Marks appear on the overview group headings, the place page header,
   the line and routine page titles, the editor's When choices, and the
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
  the editor's live sentence, and Where.** Mechanism: the Non-goals table. Review
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
- **INV-H8 One editor.** One component, `LineEditor`, creates and edits
  lines and routines. Mechanism: a test opens it from Add, from a place
  row, from a workflow, from a line's Edit, and from a proposal's Turn on
  and asserts the same section list; a second test asserts that the
  wizard and the edit dialog files are gone.
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
- Editor tests for the exclusion conditions: an `is not` pill renders in
  words and saves as `not_in`, and a `doesn't match` condition on a field
  with a picker takes typed text.

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

- **Problem state source (Part D step 1.5, Part E step 4).** The list route
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
- **The workflow editor's lines come from the rules list (Part G step 2).**
  The panel reads `GET /api/event-subscriptions` and keeps the rules whose
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
- **Cron in words covers common forms (Part E step 1).** Other expressions
  read `On the schedule <expr>`.
- **A preselected place's filter follows the events (Part H step 11).** An
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
  test files, and the `idPrefix` attribute. The api has a second lint
  (`packages/api/src/copy-lint.test.ts`) with the same banned words. It
  reads every text with a space in the event and workflow services and
  the events, presence, and workflow-triggers routes, and skips log lines
  and the files only the model reads.
- **A routine page is read-only until it knows the viewer (Part E step 2).**
  Team and org routines are editable only by a member with access.
- **The place page edits Appears as in the editor (Part C step 6).** The
  overflow menu item `Appears as` opens the editor on its **Appears as**
  section. The section shows each line's name and avatar with `Set by
  <name>`, and has no inline form.
- **A Slack channel's own threads keep their title (Part C step 5).** The
  subject group reads `One thread per pull request` on a repository and
  `One thread per issue` on a Linear team. On a Slack channel it reads
  `Threads for <channel>`.
- **A workflow line has no thread (Part D step 1.6).** A workflow target
  starts a run and no thread. How it works reads its Where as `in a
  workflow run`, and the editor shows Where as `Set by the workflow`.
- **The service chips filter in the browser (Part F step 2).** The log
  route has no service filter. A service chip keeps the loaded rows whose
  event key starts with `<service>.`, so a page can show fewer rows than it
  loaded. The `Search` box sends `q`, which the server matches; the place
  filter is the server's `place` param (Part F step 2).
- **Receipts leave the chips (Part F step 2).** Admins open the intake
  trail under a `Diagnostics` disclosure above the list (see the Revision
  4 rename). The old `status=receipts` value and the
  `/events?tab=receipts` redirect open the whole Log.

Revision 2 deviations that still hold:

- **The routine sentence uses the Part E renderer (acceptance P6).** The
  editor's side pane reads a routine through the sentence renderer every
  list uses: `Every weekday at 9:00, <name>: work in its own thread.`
  Before the reader types a name, it reads `this routine`.
- **Following a Slack thread lives under When (Part H step 3).** Revision
  2 put `Follow a Slack thread` under Do. The editor offers it under When
  for Slack as `A reply in one Slack thread`, with a `Paste the thread's
  link` field. It keeps the revision 1 outcome: a line that listens to one
  Slack thread from a pasted message link.
- **The side pane names the service until an event is picked (Part H step
  8).** Before the reader picks an event, the side pane reads `When
  something happens on acme/api, <do>.` or `When something happens on
  GitHub, <do>.` A Slack draft with no event reads the mention, because
  `Reply` to a mention is Slack's default. Only the team Slack setup starts
  with the mention picked.
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
- **A thread follow has its own sentence (Part C step 2).** `A reply in
  one Slack thread` stores a `slack.message` line with `channel` and
  `thread_ts` filters. A line whose keys are all Slack messages and that
  has a `thread_ts` filter reads `When someone replies in the Slack thread
  in <channel>, <do>.` The channel is its label, or its id when the line
  has no label. The editor's side pane reads the draft through the same
  renderer, so it equals the stored sentence.
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
  so `created-highlight.ts` carries the new id from the editor's
  `onSaved` to the overview. The overview marks the row only after the
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
- **Tokens inside dialogs are not links (Part K step 2).** The editor's
  side pane and its section summaries render `Sentence` without links,
  because a link would close the editor and drop the draft.
- **A routine name has no glyph (Part K step 4).** A routine is not a
  workflow, and no routine token kind exists, so its name is plain text.
- **Names come from the org directory (Part C step 2).** The sentences read
  member names from `useOrgDirectory`, which every member may read.
  `useOrgMembers` answers only org admins, so a member would get 403.
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

Revision 4 deviations:

- **Do is fixed on edit (Part H step 4).** A PATCH cannot change a line's
  target kind, owner, or `follow`. On edit, the Do cards and the
  assistant choice are disabled, with `To change what Valet does, delete
  this line and make a new one.` A routine's text says `routine`.
- **Reply follows only a mention (Part H step 4).** `Reply` sends `follow:
  true` only when `slack.app_mention` is picked. A `slack.message` line
  sends `follow: false`. The wizard's `Keep following the thread` toggle
  is gone.
- **The event message holds the inserts (Part H step 4).** The api allows
  only `{{event.key}}` in the instructions (`systemPrompt`), so text from
  an event never becomes an instruction. The Instructions field has no
  insert menu. `Insert a detail from the event` sits on the Event message
  field under `Advanced`. It inserts `{{event.summary}}`, `{{event.body}}`,
  and `{{payload.<field>}}`, which the api's template pattern accepts.
- **When choices use the medium mark (Part K step 1).** The editor's
  service choices use `ServiceMark size="md"`, because a 24px tile fits a
  pill button. The size table listed `lg` before revision 4; it now lists
  `md`.
- **An Advanced cron reads as typed (Part H step 7).** A cron outside the
  common shapes reads `On the schedule <cron>` in the When summary, the
  side pane, and the routine's sentence. The example's first step reads
  `The schedule <cron> comes due.` This replaces the UX-fixes bullet that
  described the wizard.
- **An assistant routine shows only its last firing (Part E step 2).** The
  api records only `lastFiredAt` for a routine that runs the assistant.
  Its Activity holds that one firing with no time taken, the health strip
  hides `times in 30 days`, and the pulse shows that one day. An api that
  records each firing is a follow-up.
- **A routine has no setup time (Part E step 2).** Routines carry no
  `createdBy` or `createdAt`. A personal routine's status line reads `set
  up by <owner>` with no time. A team or org routine shows no `set up
  by`.
- **Older receipts carry no place (Part D step 4).** Ingest records an
  event's place on its receipt for every service from revision 4 on. A
  receipt written before then carries a place only for Slack. A member
  sees an older GitHub or Linear skip only on a line that names the
  whole service.
- **Skipped entries reach back 7 days (Part D step 4).** Receipts expire
  after 7 days, so skipped entries reach back 7 days. Acted entries reach
  back as far as the line's deliveries.
- **The admin panels say Diagnostics (Part F step 2).** The copy lint bans
  "receipt" and "delivery" (INV-H2). The Activity disclosure `Receipts`
  became `Diagnostics`, and the event page's stage list became `Intake
  stages`.
- **The editor opens on a named section (Part H step 2).** `EditorMode`
  carries `initialSection`. `Appears as` in a row's overflow menu opens
  **Appears as**. The pages edit inline, so they name no section.
- **The team Slack setup opens the editor (Part H step 3).** `EditorMode`
  carries `preselected.team`. The team Slack setup and the teams panel
  open the editor on a Slack mention line for that team, with the team's
  assistant fixed.
- **Slack channel alternatives use separate rules (2026-10-23).** Conditions
  within one rule remain ANDed. Exact channel selections use `channel` with
  `eq` or `in`. New Slack name comparisons use `channel_name` with `prefix`,
  `contains`, `regex`, `not_prefix`, or `not_regex`. Selecting Channel after
  a name comparison resets the comparison to `eq` and clears its value.
  Other services keep their field semantics. Opening or renaming a saved
  rule never converts its ID conditions into name conditions.
- **Slack setup lists channel-name rules.** Exact selections and name rules
  are separate alternatives. `Add channel-name response` opens the editor with
  a name prefix and the team's reply target. The prefix entry explains future
  channels; Continue grants `Any channel` consent for that pattern. The reader
  reviews the conditions before creation. Conditional exact rules do not
  justify automatic ID exclusions, which could lose matching mentions.
  Future exact additions and other name rules use the existing collision
  workflow. The setup dialog does not bypass collision checks.
- **Pattern rules keep their place clause.** A name pattern remains on the
  Slack workspace row, without an invented channel place. The row sentence
  shows the pattern. A Slack workspace row containing a `channel_name` rule
  uses the heading `Slack channel responses`, including groups with unscoped rules.
  Groups without channel-name rules retain `Everywhere in Slack`.
  Pattern rules have edit actions in Slack setup.
- **A proposal's row Edit opens edit (Part D step 2).** The overview row's
  Edit on a proposal opens the editor in edit mode. Only the page's **Turn
  on** opens review mode.
- **The default appearance is plain text (Part D step 1.6).** How it works
  reads a custom display name in Do as a person token (`reply as Ops
  Bot`). The default `Valet` is plain text, because it names no person.
- **A mention line says where it replies under Where (Part D step 1.6).**
  `Valet replies where it was mentioned.` starts the Where explanation of
  a mention line. Do reads `Valet reads the message and replies.`
- **The pulse counts UTC days (Part D step 1.4).** The api counts `perDay`
  by UTC day, and the strip draws those counts. The Activity timeline
  groups entries by the viewer's local day. Near midnight one entry can
  sit on a different day in each.
- **Launch-point tests use a stub editor (INV-H8).**
  `editor/test-editor-stub.tsx` renders the editor's mode as one line of
  text, so a launch point's test asserts the mode without the editor's
  reads. It lives in `src`, so the copy lint and `tsc` read it. The
  acceptance test mounts the real editor.

Review-fix deviations (2026-10-19):

- **Scheduled run ids hash the whole routine id (Part E).** `wfrun_sch_`
  takes a 14-character hash of the full schedule id from
  `packages/shared/src/schedule-run-id.ts`, on the api and the web. The
  old 8-character cut collided for proposal and repository routines. The
  format changed for every routine: firings before this change no longer
  match a routine's page, and a fire in flight at deploy can run once
  more.
- **Receipt stages say handoff (Part D step 1.8).** The stage marker
  `delivery X:` became `handoff X:`. A retried delivery of an event
  received before the change may add its stage once more.
- **The health strip counts attempts, not successes (Part D step 1.4).**
  The strip, the pulse, and `lastActedAt` count every acted entry the
  timeline lists (any delivery status, not skipped, not superseded), so
  the strip and the Acted chip agree.
- **The filter-options cache keeps its reason (Part H step 3).** A
  no-credential answer reads `Connect the integration on the Integrations
  page to choose from a list. Type the value instead.` on a cache hit
  too, so the free-text field stays available. A GitHub source reads the
  org's App installation token, and with no installation it reads `Install
  the Valet GitHub App for this organization on the Integrations page to
  choose from a list. Type the value instead.`
- **A Create hidden by the filter keeps its mark (Part B step 8).** The
  highlight is computed from the rows the filter shows; a row the filter
  hides keeps its store entry and shows nothing until the filter reveals
  it.
- **The sentence's glued punctuation reads from a hidden span (Part K).**
  A plain period node reads with a space because the token is its own
  layout box. So the token holds a visually hidden (`sr-only`) span with
  its text and the punctuation, such as `Ops Bot.`, and its visible text
  and the visible punctuation are `aria-hidden`. A linked token keeps the
  hidden span inside the link, so the link's name is `acme/api,`. No
  generic element carries a name. The hidden span is not selectable, so
  a copied sentence holds its text once. `textContent` holds the text
  twice; tests read `visibleText` from `test-fixtures.ts`.
- **The delivered body heading reads `Instructions for this line:`.** The
  copy lint reads every api string with a space, so the heading the model
  receives uses Presence words too.

Deviations that revision 4 retires: the wizard's Review step and its
preview (the side pane replaces both), the team Slack setup's three steps
(it opens the editor), the wizard's Advanced cron wording (replaced
above), the `Runs in` fact and the line page's fact strip (How it works
replaces them), the line page's Deliveries and Receipts lists (Activity
and Diagnostics replace them), and `Follow a Slack thread` under Do (now
under When).

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

Presence copy uses response for these entries. A name condition reads as a channel whose name matches the condition.

### Complete channel summaries (2026-10-23)

Show every channel condition in the response sentence, including exclusions.
Join separate conditions with `and`, as the event matcher does.
An exact channel heading does not replace additional channel conditions.
This also applies to responses that follow a Slack thread.
Name comparisons say `channel name`. Saved non-exact ID comparisons say
`channel ID`. The editor explains how these fields differ without changing
saved conditions.

The overlap notice must fit the side pane. Long response names wrap within
the reference. They must not hide the rest of the notice or widen the pane.

### Filtered channel groups (2026-10-23)

A single exact channel keeps its channel name as the overview heading.
Compound channel conditions list at the Slack workspace row.
Use `Filtered channels` when every response in that row has channel conditions.
Use `Slack responses` when the row also has an unrestricted response.
Keep the full conditions in each response sentence.
This changes display grouping only. Event matching and channel coverage stay the same.
The channel picker contains no response cards or name-response creation form.
Use Advanced setup or an existing Presence entry to edit conditions.
