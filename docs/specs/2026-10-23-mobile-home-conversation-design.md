# Mobile Home and shared conversation components

## Scope

Valet opens to one ongoing, private conversation on a phone and, since
2026-11-02, on desktop. The person can ask it to work across their personal
workspace and teams they belong to.

The phone shell applies below 768 CSS pixels. It uses the same breakpoint as
Tailwind `md`. Resizing changes the shell, not the saved conversation or its
access rules.

| Surface | Below 768px | At or above 768px |
| --- | --- | --- |
| Home route | Conversation with Chat, Tasks, and Make | Threads layout with Home selected and a Tasks panel |
| Top navigation | Drawer toggle and account menu | Existing navigation, notifications, Settings, and Ask Valet |
| Thread navigation | App drawer on signed-in pages | Existing conversation rail on chat routes |
| Conversation components | Shared cards, plans, activity, and presence | The same shared components |
| Backend and Slack | Shared services and access checks | The same services and access checks |

The mobile-only boundary applies to navigation. It does not apply
to conversation cards, approval previews, durable plans, measured thinking
time, or agent processing feedback. These are shared thread features.
There are no reply buttons guessed from message text. Earlier quick replies showed Yes / No / Not now under any reply that ended in a yes-or-no question, so ordinary closing offers got buttons, and Not now did not persist. A decision with choices uses the `ask_question` tool, whose options become buttons and whose answer is saved.

The mobile conversation shell is shared by Home, `/chat`, `/threads/:id`,
and `/sessions/:id`. Opening a team thread from the drawer must keep the
same Chat, Tasks, and Make navigation as Home. The Chat tab returns to that
open thread; it does not substitute the private Home conversation.
Embedded panels retain their compact panel headers.

Workspace threads use a fixed compact header on phones. It names the team
and keeps viewer avatars visible. Model and thinking controls move into a
dialog opened from the thread menu. That menu also opens Browser, Terminal,
and VS Code when available. These views have a Back to chat button on a
phone. Sharing details stay in the thread menu and do not force the old
sandbox tab strip into a team conversation. Desktop keeps its existing
header, model picker, and sandbox tabs.

## Home, Tasks, and Make

Home uses the `home` thread in the person's personal assistant session.
Changing the workspace switcher does not change this conversation. It is
private to that person; it is not a team chat.

Tasks collects work across accessible workspaces, in three sections:
Waiting on you, In progress, and Done. Done holds tasks started from Home
that finished and that the person has not marked done. It starts collapsed.
An unread reply without a question is not a task, so Tasks does not list
it; the thread list shows it. Each row names its workspace and opens its
thread.

Only the person marks a task done, as in Claude Duet. Every row has a Mark
done control, so the person can cross out a task that is done or no longer
relevant. Crossing out writes a `home_task_dismissals` row and marks a saved
Home task done. It does not stop running work. The thread stays out of Tasks
until a question, approval, or failure newer than the cross-out needs the
person. When a Home task finishes, Valet asks "Mark it done?" in Home. The
`mark_task_done` tool crosses the task out, and it runs only on a turn the
person wrote. Task rows can show plan
progress, pull requests, and shared files. Approvals live in Tasks and have
a compact shortcut above the Home composer when action is needed. On a phone,
the shortcut shows only approvals from the person's personal workspace. Team and org
approvals appear in the team's own threads and in Tasks.

When the person answers the last waiting request in the shortcut, Home opens
that request's thread, where the work continues. While other requests still
wait, Home stays, and the answered request's notice links to its thread. A
request whose thread the person may not open never navigates.

The progress card above the composer hides once a turn settles with no tasks
and no tool calls. A finished card with tasks or calls stays, so the person
can review the steps and their sources.

A swipe to the right opens the phone drawer, which sits at the left edge. A
swipe to the left closes it. Mostly vertical moves, moves that start in a text
field or a horizontally scrollable element, moves that start within 24px of
the left edge, and moves under an open modal dialog are ignored.

Make provides routes to workflows, skills, memory, and files. It also links
to Presence and integrations. These browse the selected workspace. Settings
and Security remain reachable through the account menu on a phone.

The Home conversation stays mounted when switching between Chat, Tasks,
and Make, so its draft survives. Wider screens keep the notifications bell
and Ask Valet dock. See [Home on desktop](#home-on-desktop).

## Task access and reports

`start_task` creates a top-level assistant thread and submits the instruction
as the person. Team tasks use a team execution session. Team membership is
checked when starting work.

A task thread has no repository checkout and no git credentials, because an
assistant session has no sandbox spec. Only a `task` child with `repo` gets a
clone, the git credential helper, and `gh`. The server adds a fixed note to
the first message of every task. The note tells the thread to start a child
with `repo` for work that reads or changes a repository. The `start_task`
description and the Home context tell Home to name the repository and branch
in the instructions. `read_task`, `message_task`, task listing, and completion
reports also check the thread's current audience. A saved `home_tasks` row
is a pointer to work, not permission to read it.

Task listing checks visibility before fetching plans or outputs. Saved tasks
also get a bounded live-state query, so a task outside the workspace's first
active-work page is not labeled finished while it is still working.

Home-driven turns and selected background completions can report back to
Home. Reports name the task and outcome. Home must call the access-checked
`read_task` tool to fetch a result. Reports stay quiet while the person is
viewing the task. Background-only reports have a ten-minute minimum gap.

Home creates no routine. The Tasks tab shows what is in progress and what
needs the person. When the person asks what is going on, Home calls
`list_tasks` and shows the answer with `show_brief`. Briefs and task reports
cover personal work as well as team work; a team is not required.

Earlier builds created a daily 08:00 "Morning brief" routine that posted into
Home. Each run sent the whole Home conversation to the model again, after the
prompt cache expired. In production, one run cost $1.10 to $1.47 for its first
request as Home grew from 136k to 183k tokens. At startup,
`removeStockMorningBriefs` deletes each of those routines that nobody changed.
A paused routine, or one with an edited name, prompt, cron, or thread, stays.

## Shared conversation components

Consecutive tools collapse into an activity line with an expandable trace.
Child agents have a compact progress summary. Output cards, structured
widgets, approval payload previews, and plans use reusable components.

`update_plan` stores a plan in thread metadata. The pinned plan updates in
place and persists across reloads. Transcript entries record plan updates.

Approval cards show the operation and its relevant inputs, including message
or email content where available. A completed gate becomes an outcome notice.
Ordinary interactive team approvals wait on the requester. Consent to borrow
a shared account instead waits on the account lender. The lender's consent
does not replace separate action-policy permission.

`show_widget` accepts a validated, bounded catalog of components. Widgets
persist in tool results and render on replay. A widget button submits its
reply as a normal user message; it cannot bypass tool approval policy.

Thinking duration comes from measured provider events and saved timing
metadata. Adjacent reasoning intervals combine into one timing line.
Historical messages without timing metadata do not receive invented times.
A thought line opens to the provider's reasoning summary. The model's own reasoning text is not stored, and the summary is never sent back to the model.

Processing feedback covers the gap before text or tools stream. While a thread compacts its context, during a turn or between turns, the
same status line reads "Valet is compacting context…" with the pulse and the
elapsed time. A pending response still takes priority. It replaces the
separate compaction strip. Slack work
status is tracked separately from response streaming and cleared when work
settles, fails, or stops.
On phones the composer status is a muted text line with a small Valet mascot,
no background or border, and space above and below it. Desktop keeps the
existing status treatment.

## Multiplayer presence

Shared threads retain live viewer avatars, a tappable list of names, and
human typing indicators above the composer. Drawer rows also show viewers.
Presence includes people using mobile or desktop; it is scoped to the thread
both people are viewing. Private Home does not expose teammate presence.

## Storage and verification

`home_tasks` records the requesting user, organization, workspace owner,
session, thread, and report state. `home_task_dismissals` records when each
person crossed a thread out of Tasks. The Postgres schema and startup repairs
create the tables and indexes. Plans and thinking timing use engine metadata.

Regression tests cover the exact media-query breakpoint, switching back to
desktop, saved-task audience changes, active-work paging, requester versus
lender approvals, and viewer and typing components. The UI stress gallery
includes narrow-screen cards and catalog-limit fixtures.
Team-thread regression tests also cover shared mobile navigation, draft
retention while switching views, viewer visibility, model controls, and
returning from Browser without the old sandbox tab strip.

Channels with standing instructions, teammate mentions, and persistent allow
choices on expired approval cards remain outside this change.


### Phone settings and viewport bounds

The phone model dialog embeds the model list and thinking options in one panel.
Selecting a model keeps the panel open for thinking changes.
It uses the same catalog, approval scope, and callbacks as the desktop picker.
The desktop picker remains a dropdown.

The signed-in phone shell fixes the document viewport and contains scroll gestures.
Only content regions scroll. The visual viewport sets shell and model-dialog bounds
when Safari opens the keyboard or pans a focused field. Public pages and desktop
retain normal document behavior. Viewport listeners and variables clear on desktop.

The model dialog initially focuses its container, so opening settings does not
open the phone keyboard. The model list has a bounded scroll region. On short
viewports, the dialog also scrolls so the list and thinking controls stay reachable.


The phone panel shows one Thinking field with the current level. It reuses
ReasoningSelect and the native platform picker. Model-supported levels intersect
with the organization limit; unavailable saved values remain labeled until changed.
Default still clears the override. The desktop button group stays unchanged.
This follows the single effort entry and list patterns in Claude and Codex.
The phone field uses an inset chevron and reserves space between the label and arrow.
Other ReasoningSelect fields keep their native appearance.

The phone dialog opens with five size choices, their resolved model names, and a selected checkmark.
Thinking uses one plain row. Normal help text and model counts do not appear in this view.
More models opens the searchable catalog inside the same dialog. Back restores focus to More models.
Custom current models remain labeled without marking an unrelated size as selected.
The catalog keeps role and organization restrictions. Restricted size choices require an approved target.
Search and default actions stay in the catalog view. Desktop keeps its existing picker.

### Home delivery and routine preferences

Home queues turns as follow-ups. Task reports never supersede active work.
New Slack DM roots use separate engine threads. Replies use the saved conversation binding.
Existing dedicated conversations keep their thread. Slack conversations already in Home continue there.
A plain-text question reply from Slack must match the question submission's original conversation.
DM edits record the correction in the thread that holds the original conversation without sending a reply.
Existing Home history remains in Home and stays accessible through the desktop Home row.
The routing change does not move or delete that history. Existing Home gate cards and command replies retain their original Slack destination.
See the [Slack conversation routing design](2026-10-23-slack-conversation-routing-design.md).
The host marks a linked person's direct channel input separately from background signals.
Only that verified input supplies an interactive actor; replay retains its original channel context.
Workflow and child turns cannot inherit this authority.


Widget validation rejects cycles, more than 100 elements, nesting beyond 24 levels, and expansions beyond 256 elements.
The web checks persisted widget specs with the same validator before rendering them.
The web sidebar pins a Home row above the thread list in the person's own workspace, with the same unread, question, and work marks as a thread row. Home is never an ordinary row, but thread search finds it when its content matches.
The API names the home thread Home in every thread response and never auto-titles it, so the web, the CLI, and agents show one name.

The Home queue default persists before admission and survives engine restarts. Widgets use explicit elements; state-driven repeat expansion is rejected.

Processing recovery scans bounded organization-scoped pages without casting message text to PostgreSQL JSON.
Slack processing status is limited to DM conversations; silent channel work does not announce activity.
External senders and guests in personal shared threads cannot update the persistent plan.
Approval surfaces distinguish the requester from a shared-account owner.
Legacy unmarked team approvals retain member-authorized behavior after restart.
New requester gates use their stored approver, and explicit actor-only and shared-account approvals stay restricted.
Requester gates retain their one-shot marker for bulk approval; shared-account gates remain excluded.


### Mobile conversation controls

Home and workspace threads place thread controls beside Chat, Tasks, and Make.
The thread menu keeps browser access, sharing, and the thread audience visible.
Embedded assistant panels retain their own close and host controls.
Each project shows a touch-sized New thread button. Creation expands a collapsed project.

Questions use one response area within the available phone viewport. Ordinary approvals leave the composer available.
The composer stays mounted but hidden while a response form is expanded, preserving its draft with input shortcuts inactive.
Folding or resolving the request restores the composer. Folding keeps the answer text and attachments mounted for Show. Desktop keeps its existing layout.

The phone composer places message text above an action row with attachments, a model-and-thinking pill, and Send.
The pill opens the existing thread-scoped model settings. Context usage remains available in those settings.
People without model administration access retain the context control beside the composer.
The phone thread menu omits sandbox configuration. Desktop retains those controls.
Assistant reply, rating, copy, and branch actions appear together below the response on phones.

### Phone sidebar and sheets

Added 2026-11-03. These rules apply below 768px only. Desktop does not change.

- The drawer uses the sidebar's type tiers at touch size. Rows are 44px tall
  with 15px text, section labels are 12px, and New thread and Search are 44px
  targets. Home is a top-level row with the same neutral selected fill as the
  sidebar. The drawer lists each space's pages, its Settings row, and every Recent.
- The drawer slides in from the left. A swipe left closes it.
- The thread summary opens as a bottom sheet with a grabber, not a popover. A
  swipe down closes it when its content is scrolled to the top.
- Thread controls beside Chat, Tasks, and Make are 44px wide.
- A breadcrumb header ("Space / Page") stays on one line. The space name
  truncates before the page title. A title without a space step wraps.
- Tasks stays a tab beside Chat and Make. It is a full-height view, so it
  needs no separate sheet.

### Home on desktop

Added 2026-11-02, revised 2026-11-03. Desktop opens Home inside the Threads
layout, the way a chat app opens on its conversation list. This replaces the
earlier rule that Home changes only below 768px.

- `/` shows the thread sidebar (New thread, Home, Projects, Recents) with
  Home selected, and the Home conversation in the main pane. Every thread is
  one click away. The logo also opens `/`. The sidebar is app-wide; see the
  [team workspace design](2026-08-17-team-workspace-ui-design.md).
- The sidebar pins the Home row in every workspace. The row links to `/`.
  Home starts fresh: no tasks nest under it. Tasks that Home started stay in
  the Tasks panel and in their own workspace's thread list.
- While Home is idle, an idle view covers the transcript. It shows a
  greeting with the starters and Show conversation. What waits on the person is in the Tasks panel, not here. Typing, a starter, Show conversation, or a running turn removes
  the idle view until the person leaves Home.
- A starter sends a complete request as the person's message, so Valet starts
  at once. The starters are What needs me today?, Catch me up on Slack since
  yesterday, and Prep me for my next meeting.
- The thread header has a Tasks button with the count of items that need the
  person. It opens a collapsible Tasks panel beside the conversation. The
  panel header, the thread header, and the sidebar's top row share one height,
  so their bottom borders form one line. The sidebar divider is a 1px hairline.
  `?view=tasks` opens the panel; closing it clears the parameter.
- The panel is open by default on Home. Once the person opens or closes it,
  browser storage keeps that choice, and the choice wins on later visits. A
  link or the approvals dock can open it without storing a choice. The Tasks button shows the count of
  items that need the person ("Tasks · 3") whether the panel is open or not.
- The New thread button starts a thread. It has no create menu (removed
  2026-11-03). The workspace dashboard at `/overview` is deleted; the path
  redirects to `/`.
- The wider layout uses the full thread header. The model picker and thread
  menu stay the same as on `/chat`. An expanded question in the approvals
  dock does not hide the desktop composer.
- Phones keep Chat, Tasks, and Make unchanged.
