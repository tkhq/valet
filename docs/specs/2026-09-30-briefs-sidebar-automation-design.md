# Briefs, thread origin, and automation setup

Status: implemented on 2026-09-30. This note records six changes from the briefs and sidebar review.

## Briefs

A brief card is compact: a small title, a short summary, and one line of links. The card links to its conversation with **Open thread**. When the work started in Slack, the card also links to that Slack thread with **Open in Slack**.

A brief finds its conversation in this order:

1. A collected conversation among its sources.
2. Any other source that names a thread in the same workspace, such as a workflow run started from a conversation.

A workflow source carries the conversation that started the run only when that conversation belongs to the same workspace. A team brief never links to a person's private thread.

A brief with no conversation links its newest run with **Open run**. This covers runs that a schedule or an event started.

The briefs cache keeps a snapshot per workspace. When the evidence changes, the API returns the old snapshot marked `refreshing` and regenerates it in the background. Each read still checks that the viewer can read every source. A snapshot younger than five minutes is kept, so an active conversation does not start a model call on every check. Only the first snapshot for a workspace makes the request wait.

A source carries `originUrl` for a Slack origin. A thread keyed `slack:{channel}:{thread_ts}` links to `https://slack.com/archives/{channel}/p{ts}`. A run that a Slack event started links to that event's thread. The briefing cache version changed, so cached briefs regenerate with the new fields.

**Dismiss** hides a brief for the person who dismissed it. The `briefing_dismissals` table stores one row per person, workspace, and brief. A brief's id is a hash of its sources, so new activity produces a new brief that shows again. Rows older than 30 days are removed when the same person dismisses again.

Dismiss also archives the brief's threads that belong to the workspace. A thread waiting on an approval stays open, because archiving it would withdraw an approval that someone may still answer. The response reports how many threads were archived and how many stayed open.

## Thread sidebar

Each thread row shows its origin: Slack, another channel, web chat, an automation, or another agent. The origin comes from the engine thread key (`packages/web/src/lib/thread-origin.ts`). The sidebar options menu has **Show threads from**, with a count for each origin. An active filter shows above the list with a **Clear** link. The browser remembers the choice.

## Automation

The **Workflows** nav item and page heading are now **Automation**. URLs stay under `/workflows`.

The new-workflow dialog asks how the workflow starts: manually, on a schedule, or when an event happens. For a schedule or an event, the workflow page opens with the Triggers drawer and a new trigger of that kind, already bound to the new workflow (`/workflows/$workflowId?newTrigger=schedule|event`).

Workflow run history names each run by what started it and when: Manual run, Automatic run, or Batch run N. The run id stays available as a tooltip.

## Team Slack setup

The team card asks where Valet should listen and opens a channel list. This team's channels show as **Listening**. A channel where another Valet already answers mentions shows its owner and cannot be selected, because two listeners would both reply to one mention. A rule with no channel filter counts as listening in every channel. The server refuses the same collision on write.

Saving creates one team reply rule: `slack.app_mention`, a channel filter for the selected channels, a team orchestrator target that follows the thread, and the organization audience. This is the rule that the advanced wizard creates. The wizard stays available behind **Advanced setup**.

## Not in this change

1. A deterministic table of threads with no terminal action (open pull requests, unmerged branches) in place of written summaries.
2. One **Needs attention** notification type in place of approval, question, and escalation.
3. A list view of workflow steps as an alternative to the node canvas.
