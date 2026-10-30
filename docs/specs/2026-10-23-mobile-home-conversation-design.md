# Mobile Home and shared conversation components

## Scope

Valet opens to one ongoing, private conversation on a phone. The person can
ask it to work across their personal workspace and teams they belong to.

The shell change is limited to viewports below 768 CSS pixels. It uses the
same breakpoint as Tailwind `md`. Resizing changes the shell, not the saved
conversation or its access rules.

| Surface | Below 768px | At or above 768px |
| --- | --- | --- |
| Home route | Conversation with Chat, Tasks, and Make | Existing personal or team dashboard |
| Top navigation | Drawer toggle and account menu | Existing navigation, notifications, Settings, and Ask Valet |
| Thread navigation | App drawer on signed-in pages | Existing conversation rail on chat routes |
| Conversation components | Shared cards, plans, activity, and presence | The same shared components |
| Backend and Slack | Shared services and access checks | The same services and access checks |

The mobile-only boundary applies to Home and navigation. It does not apply
to conversation cards, approval previews, durable plans, measured thinking
time, or agent processing feedback. These are shared thread features.
Quick replies are shown only in the mobile layout.

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

Tasks collects work across accessible workspaces. Needs you appears before
working tasks, unread replies, and finished tasks started from Home. Each
row names its workspace and opens its thread. Task rows can show plan
progress, pull requests, and shared files. Approvals live in Tasks and have
a compact shortcut above the Home composer when action is needed.

Make provides routes to workflows, skills, memory, and files. It also links
to Presence and integrations. These browse the selected workspace. Settings
and Security remain reachable through the account menu on a phone.

The Home conversation stays mounted when switching between Chat, Tasks,
and Make, so its draft survives. Wider screens keep the existing dashboard,
notifications bell, and Ask Valet dock.

## Task access and reports

`start_task` creates a normal work thread and submits the instruction as the
person. Team tasks use a team execution session. Team membership is checked
when starting work. `read_task`, `message_task`, task listing, and completion
reports also check the thread's current audience. A saved `home_tasks` row
is a pointer to work, not permission to read it.

Task listing checks visibility before fetching plans or outputs. Saved tasks
also get a bounded live-state query, so a task outside the workspace's first
active-work page is not labeled finished while it is still working.

Home-driven turns and selected background completions can report back to
Home. Reports name the task and outcome. Home must call the access-checked
`read_task` tool to fetch a result. Reports stay quiet while the person is
viewing the task. Background-only reports have a ten-minute minimum gap.

On first Home use, Valet creates a daily morning brief at 08:00 in the
person's timezone, or UTC if none is set. It posts into Home and can be
edited or paused as a routine. Briefs and task reports cover personal work
as well as team work; a team is not required.

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

Processing feedback covers the gap before text or tools stream. Slack work
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
session, thread, and report state. The Postgres schema and startup repairs
create the table and indexes. Plans and thinking timing use engine metadata.

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

Home records the morning-brief offer in persistent thread metadata before provisioning it once.
Opening Home never overwrites an existing prompt or restores a renamed or deleted routine.
If initial provisioning fails, Home remains available and logs the failure without retrying on later opens.

Widget validation rejects cycles, more than 100 elements, nesting beyond 24 levels, and expansions beyond 256 elements.
The web checks persisted widget specs with the same validator before rendering them.
Desktop keeps its dashboard. The web sidebar pins a Home row above the thread list in the person's own workspace, with the same unread, question, and work marks as a thread row. Home is never an ordinary row, but thread search finds it when its content matches.
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
