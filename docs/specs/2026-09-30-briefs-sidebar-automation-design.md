# Briefs, thread origin, and automation setup

Status: implemented on 2026-09-30. This note records six changes from the briefs and sidebar review.

## Briefs

Brief evidence, active work, and **Waiting on you** leave out personal helper threads: each person's app-assistant helper thread, and workflow editor conversations. They also leave out archived threads. Each person's helper thread and editor conversation is separate, and the app shows it only to that person: the sidebar, its search, the archived list, and the approvals inbox leave out other members' ones. This is a display rule, not access control. Team members share one runtime, so the thread API still reaches every thread in it, as the "Shared with the team" notice on the thread page says. Active work and **Waiting on you** show the viewer's own editor conversations. Briefs are shared by every member, so they show none. One SQL helper (`sharedThreadKey` in `services/thread-read-state.ts`) holds this rule.

A brief covers a line of work: it combines at least two kinds of source, such as a conversation with its pull request, a workflow run, an artifact, or a sent message. A goal whose only evidence is conversations gets no brief, because the thread list and **Waiting on you** show those threads with exact state. The parser drops a single-kind group even when the model returns one.

Briefs show in two columns. A card shows a title, a status, the next action, and one line of links. The summary and the sources sit behind **Details**. The next action is one instruction of at most 12 words. Without one, the card says what its status means: open the thread for a brief that needs attention, or nothing waits on the reader.

Brief text is written by the organization's `s` model tier, resolved like a workflow model step: the org's tier map picks the model, and the org's stored provider key is used before any instance key. `VALET_BRIEFING_MODEL` overrides the choice with a model id or another tier. The usage is not yet written to the organization's usage record; that is a follow-up shared with thread auto-titles. The prompt asks for a teammate's status note: plain nouns, no filler, and no process verbs such as "Clarified" or "Identified". The card links to its conversation with **Open thread**. When the work started in Slack, the card also links to that Slack thread with **Open in Slack**.

A brief finds its conversation in this order:

1. A collected conversation among its sources.
2. Any other source that names a thread in the same workspace, such as a workflow run started from a conversation.

A workflow source carries the conversation that started the run only when that conversation belongs to the same workspace. A team brief never links to a person's private thread.

A brief with no conversation links its newest run with **Open run**. This covers runs that a schedule or an event started.

The briefs cache keeps a snapshot per workspace. When the evidence changes, the API returns the old snapshot marked `refreshing` and regenerates it in the background. Each read still checks that the viewer can read every source. A snapshot younger than five minutes is kept, so an active conversation does not start a model call on every check. Only the first snapshot for a workspace makes the request wait.

A source carries `originUrl` for a Slack origin. A thread keyed `slack:{channel}:{thread_ts}` links to `https://slack.com/archives/{channel}/p{ts}`. A run that a Slack event started links to that event's thread. The briefing cache version changed, so cached briefs regenerate with the new fields.

**Dismiss** hides a brief for the person who dismissed it. The `briefing_dismissals` table stores one row per person, workspace, and brief. A brief's id is a hash of its sources, so new activity produces a new brief that shows again. Rows older than 30 days are removed when the same person dismisses again.

In a personal workspace, dismiss also archives the brief's threads. In a team workspace the threads are shared, so dismiss only hides the brief for the person who dismissed it. The server reads the brief's threads from its own cached copy of the brief, not from the request, and refuses a brief it does not know. A thread waiting on an approval stays open, because archiving it would withdraw an approval that someone may still answer. The response reports how many threads were archived and how many stayed open.

## Needs attention

A thread waits on a reply (`GET /api/workspaces/:workspace/waiting`) when a person acted in it, the newest agent message came after that action, and nobody replied or archived it since. A thread with queued, running, or gated work is left out, because active work lists it. The window is 14 days.

Each waiting thread carries what the agent's last message asks. The question is its last sentence that ends with a question mark, as plain text. Without one, the row shows the message's last sentence.

- A thread whose agent asked a question is listed under **Needs attention**, with "Valet asks:" and the question.
- Other waiting threads are listed under **Unanswered replies**, with the last sentence.

Each row has **Reply**, which opens the thread, and **Done**, which archives it. An unread dot marks a thread the viewer has not opened since the agent wrote.

## Thread sidebar

An amber dot marks a thread whose newest agent message asks a question that nobody has answered yet; its tooltip shows the question. It takes the place of the unread dot. A thread waiting on an `ask_question` or approval gate is amber through its status dot.

`ask_question` is a built-in engine tool, the V2 port of V1's question tool. It opens a `question` decision gate: the question, optional detail, and up to six options. Each option becomes a button on the web card and on the Slack card, and the web card also takes a typed answer. A channel reply cannot answer a question, so a Slack or Telegram card for a question with no options has no buttons and tells the reader to answer in Valet. The tool returns the answer to the model, or tells it to continue without asking again when the question expires.

The threads sidebar no longer links to a Briefing view: the workspace home page shows the briefing.

A blue dot marks an unread thread: its newest agent message is later than the viewer's last read and last action. The `thread_reads` table stores one read time per person and thread. Opening a thread marks it read, and so does a new reply while it is open. **Mark all as read** in the sidebar options menu marks every thread in the session. The endpoint marks every thread only for an empty body; a malformed body is refused.

A thread that created a pull request shows its state: open, merged, or closed. The `thread_pull_requests` table stores each pull request with its thread. A `gh pr create` in the terminal and the GitHub `create_pull_request` action both put a `pull_request_created` outcome on the engine `tool_end` event, and the API records it. Only a pull request URL on the configured GitHub host (`GITHUB_URL`, github.com by default) is recorded. A GitHub `pull_request` webhook updates the state. If no webhook arrives, listing threads checks up to five open pull requests that were not checked in the last 10 minutes.

Each thread row shows its origin: Slack, another channel, web chat, an automation, or another agent. The origin comes from the engine thread key (`packages/web/src/lib/thread-origin.ts`). The sidebar options menu has **Show threads from**, with a count for each origin. An active filter shows above the list with a **Clear** link. The browser remembers the choice.

## Automation

The agent names a workflow by what it does, in 3 to 7 plain words, and replaces a placeholder name such as "Untitled workflow" as soon as it knows the goal. It calls workflows by name, not by their `wf_` ids. A new workflow's first message is exactly what the person typed. The editor conversation's system context carries the workflow id and the build instructions.

The **Workflows** nav item and page heading are now **Automation**. URLs stay under `/workflows`.

The new-workflow dialog asks how the workflow starts: manually, on a schedule, or when an event happens. For a schedule or an event, the workflow page opens with the Triggers drawer and a new trigger of that kind, already bound to the new workflow (`/workflows/$workflowId?newTrigger=schedule|event`).

Workflow run history names each run by what started it and when: Manual run, Automatic run, or Batch run N. The run id stays available as a tooltip.

## Team Slack setup

The team card shows where the team's Valet listens, with an ear icon. Before any channel is set, it asks where Valet should listen. After that, it lists the channels and offers **Edit channels**.

The channel list edits one rule per team: a `slack.app_mention` rule whose only filter is the channel, with a team orchestrator target that follows the thread and the organization audience. The team's channels start checked. Checking more adds them to that rule, and unchecking every channel removes the rule. A team can listen in any number of channels.

A channel where another Valet already answers mentions shows its owner and cannot be selected, because two listeners would both reply to one mention. A rule with no channel filter counts as listening in every channel. The server refuses the same collision on write. A channel that this team listens in through an advanced rule shows as listening, and only **Advanced setup** changes it.

The personal home page no longer shows a teams card. The workspace switcher lists the teams.

## Not in this change

1. A deterministic table of unmerged branches. Open pull requests show on thread rows, and waiting threads show under **Needs attention**.
2. One **Needs attention** notification type in place of approval, question, and escalation.
3. A list view of workflow steps as an alternative to the node canvas.
