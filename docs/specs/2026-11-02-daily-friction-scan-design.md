# Daily friction scan

Related: TKAI-656 (session outcome classes), `diagnostics.list_tool_failures` (`docs/specs/2026-10-22-tagger-library-design.md`).

The friction scan finds where people got stuck with Valet in the last day. It reads two things the API already records: the outcome label on each thread, and each tool call's result. It does not read transcripts beyond a thread title and a short excerpt of the first request.

This spec covers the `diagnostics.list_thread_outcomes` read tool and the `diagnostics.daily-friction-scan` workflow template. It does not cover outcome classification itself (the tagger spec) or artifact pages (`artifact_publish`).

## `diagnostics.list_thread_outcomes`

The Usage card shows outcome counts only. This tool returns the threads behind those counts, so an agent can name the threads that ended without the work done.

Parameters:

- `hours`: 1 to 168. Default 24.
- `outcomes`: the outcome keys to return. Default: every key except `completed`.
- `limit`: 1 to 200 threads. Default 50.

The data has five parts:

- `outcomes`: the count of labeled threads for each outcome key in the period, `completed` included.
- `threads`: the matching threads, newest label first. Each thread has its link, outcome, owner workspace (personal or team), person, a child-session flag, main tool intent, tool calls, tool errors, and up to three error codes by tool.
- `groups`: the matching threads grouped by person and main tool intent, larger groups first. A group has its thread count, outcome counts, tool error total, and up to five links.
- `truncated`: true when more threads matched than `threads` holds.
- `note`: a sentence about missing labels, a truncated read, or a missing public URL. It is an empty string when there is nothing to say.

`scope`, `since` and `until` name what was read.

### Which threads count

The tool uses the Usage card's thread rules. A thread counts when its latest `session_outcome` label was written inside the period. Deleted sessions and workflow-step sessions (`wf:`) are left out. Child-session threads count, and carry `child: true`. One call reads at most 500 matching threads. `groups` counts all of them, and `threads` returns the newest `limit`.

Tool counts cover the thread's calls inside the same period. The main tool intent is the thread's `tool_intent` key with the most calls, with ties broken by key. A thread with calls but no intent label gets `unlabeled`. A thread with no calls gets `no_tool_calls`.

The person is the session's member. For a team session that a team run started, the person is the team.

### Access

- An organization admin in a private conversation reads the whole organization.
- A team workflow run (`team:{id}`) reads the sessions that team owns.
- Any other caller gets an error that names the corrective action. That includes a member, an admin in a conversation other people read, and an external Slack sender.

The tool is read-only and writes nothing.

### Transcript text

A thread title (120 characters) and an excerpt of the first user message (160 characters) come only from threads the caller can open in Valet:

- the caller's own personal threads;
- a team thread, when the caller is a member of that team and the thread-audience rules (`visibleThreadIds`) allow it. An organization admin opens a team's sessions only as a member (`canViewSession`), so admin rights alone do not count. A team run counts as a member of its own team.

Every other thread returns its counts and link with no title and no excerpt. No other message text, tool result or attachment leaves the tool.

### Limits

- The tool reads only what the outcome classifier wrote. The classifier needs the `xs` model tier and labels a thread ten quiet minutes after it settles. When no thread has a label, `note` says how to set the tier.
- There is no backfill. Threads that settled before classification shipped have no label.
- Links use the deployment's public URL. Without one they are `/threads/<id>` paths, and `note` says so.
