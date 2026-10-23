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
The UI does not expose private reasoning text.

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
