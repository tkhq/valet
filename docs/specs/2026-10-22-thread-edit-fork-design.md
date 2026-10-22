# Thread edit and fork

Date: 2026-10-22. Status: built, piloted on one deployment.

## Problem

A person who sees the agent go the wrong way stops the turn and types a
correction. The wrong turn stays in the model's context, so the next turn
starts from a polluted transcript. The transcript is already a DAG
(TKAI-211): every entry has a `parentId`, and the thread row holds
`activeLeafEntryId`. Nothing writes a second branch yet, and the
`branch_summary` entry type (from pi) has no writer.

This change adds two operations on that graph:

- **Edit**: rewrite one of your own earlier messages. The thread continues
  from just before that message. The old branch stays in the store.
- **Fork** ("Branch into a new thread"): copy the active path up to a message
  into a new thread.

## Decisions

### 1. Edit any of your own messages, in one step

Call: each of your own user messages has an Edit action, not only the
latest one. Edit puts the message text and images back in the composer with
an "Editing your message" bar. The transcript dims the message and
everything after it while you edit, so you see what Send replaces and can
still read it. Send commits the edit. Cancel, or Escape, ends the edit and
gives back the draft you had before.

The rewind commits on Send, not on Edit. A person who opens Edit and then
leaves changes nothing.

If a turn is running, Send stops it. The person no longer has to press Stop
and retype, which is the habit this feature replaces.

Rejected: rewind on Edit (Claude Code's double-Escape rewind). An abandoned
edit leaves the thread rewound with no message, and a second viewer sees the
transcript cut for no reason.

Rejected: an inline editor inside the message bubble. It duplicates the
composer (attachments, model picker, drafts) and is cramped at phone width.

### 2. Keep the old branch: move the leaf, never delete

Call: an edit appends a branch note whose parent is the edited message's
parent, and moves `activeLeafEntryId` to it. The edited message and its
answers stay in `engine_entries` on the old branch. Nothing is deleted.

### 3. A branch note says what still stands

Call: every leaf move writes a `branch_summary` entry, the branch note. The
note lists the tools that ran on the branch you left and the confirmed
outcomes they reported (for example a pull request URL). Nothing outside the
chat is undone. If a tool that can change files ran, the note says that the
working directory keeps any changes, because the sandbox cannot rewind.

The engine builds the note from the left branch's tool calls. It makes no
model call. The note text enters the model's context as a
`<branch-note>` block, so the model knows that a pull request it opened on
the old branch still exists.

A tool definition says what its calls leave behind in the optional
`ToolDef.sideEffect`. `"none"` marks a tool that leaves nothing outside the
conversation, such as `ask_question` and `ask_approval`. `"files"` marks a
tool that can change the working directory: `bash`, `write`, and `edit`. A
read-only tool (`concurrencySafe`, no approval) counts as `"none"`. The note
omits `"none"` tools and failed calls, and it lists every other completed
call. Only a `"files"` call adds the working-directory line, so a memory
write is listed without it. Memory reads, `list_tools`, and `focus_tools`
are `"none"`. Every plugin action call is listed: an action's `riskLevel`
is not a read marker, because `low` actions include Slack DMs and
reactions. The note labels a plugin action call by its
`summary` argument, or by its `tool_id` when the summary is missing.

Rejected: a model-written summary (pi's `/tree` summaries). It adds a model
call to every edit, it can fail, and it can invent an outcome. The tool list
is exact and immediate.

### 4. Fork copies the active path into a new thread

Call: "Branch into a new thread" is on every message.

- On an assistant reply, the fork copies the path through that reply.
- On a user message, the fork copies the path up to just before it, and the
  new thread's composer holds that message's text. A teammate who cannot
  edit someone else's message uses this to try a different wording.

The copy gets new entry ids, re-linked parents, and remapped compaction
coverage. Copies drop `queueItemId`, `usage`, and `cost`, so usage views
never count one model call twice. Decision-gate entries stay behind. Their
gate rows belong to the source thread. The fork ends with a fork note. The
note names the source thread, and it says the copied actions already ran. A
team thread runs in its own execution session and sandbox. For a team thread,
the note also says that the source thread's files are not in this
thread's working directory.

The fork keeps the source thread's model and reasoning level.

### 5. No "2 of 3" version arrows

Call: no version switcher. The branch note has one action, "Go back to this
version". It moves the leaf back to the old branch's leaf and writes a new
note for the branch it leaves. So the person can always return.

Rejected: ChatGPT-style version arrows. Agent branches are not equal: one
branch opened a pull request and the other did not. Arrows suggest that
switching is free, and agent products drop them for this reason.

### 6. Only the author edits; others fork

Call: only the author of a message may edit it. An edit is also refused when
another person wrote a message after it on the active path, because the edit
would remove that person's message from the conversation. The person can
fork instead. "Go back" follows the same rule for the branch it leaves.

A shared-thread guest with reply access may edit their own messages under
the same rule. A guest cannot fork, because a fork creates a thread in the
owner's workspace.

## Engine

### Store contract: `appendBranch`

`appendEntries` always moves the leaf to the last appended entry, and
`saveThread` never moves the leaf. A leaf move needs a compare-and-swap:

```ts
appendBranch(sessionId, threadId, entries, {
  expectedLeafId: string | null; // the leaf the caller read
  fence?: WriteFence;
}): Promise<boolean>;
```

The first entry's `parentId` may name any entry of the thread, or null. The
store appends the entries and moves the leaf to the last one only while the
leaf still equals `expectedLeafId`. Otherwise it writes nothing and returns
false. The fence check is the same as `appendEntries`. The in-memory and
Postgres stores implement it. The shared store contract tests both paths.

The thread calls it inside its entry-append chain, so a local append cannot
interleave. A false return means another process wrote to the thread. The
operation fails with a clear error. It does not retry.

### Admission: steer scope `active`

`admitSubmission` gets a third steer scope, `active`. It supersedes only the
running or gate-blocked item. It keeps queued siblings and inserts the new
item at the runnable head. This scope is the existing promotion scope
without a source item.

### Edit: `Thread.editMessage`

`editMessage(entryId, content, opts)` validates the target, then admits a
queue item with the `threadEdit` metadata key and steer scope `active`.

Validation, in order:

1. The entry is on the active path, and it is a typed user message (not a
   signal, not a command result).
2. The editor is the entry's author.
3. No other author wrote a user message after it on the active path.
4. The message did not come in through a channel such as Slack. The Slack
   copy cannot change, so the person forks instead.
5. No other edit is waiting on the thread.

The supersession stops the running turn and withdraws its pending approval
and question cards, like steer does. Queued messages stay queued and run
after the edited message. They are the person's own pending intent, and the
queued rows keep their Cancel controls.

### The leaf moves at claim time

The leaf moves when the edit's queue item is claimed, before anything else
in the turn. At that point the superseded turn has settled, so none of its
late writes can land on the new branch. `applyEdit`:

1. Reads the thread snapshot. If a note for this queue item exists, the
   edit already applied (a retried attempt), and it returns.
2. Finds the edited entry on the active path. If it is gone, the turn fails
   with "The message you edited is no longer in this conversation. Edit it
   again from the current version."
3. Builds the note from the entries after the edited message's parent.
4. Calls `appendBranch` with the note, under the turn's fence.
5. Rebuilds the agent transcript from the new path and emits
   `branch_switched`.

`appendUserEntry` calls `applyEdit` first too, so the credential-cap path
cannot append the edited message to the old branch.

### Go back: `Thread.returnToBranch`

`returnToBranch(noteEntryId, actor)` moves the leaf to the note's
`branchLeafId`. It runs only while no turn runs on the thread. It finds the
common ancestor of the two paths, writes a `return` note for the branch it
leaves, and emits `branch_switched`. It never stops a turn: the person stops
it first.

### Fork: `Thread.forkPath` and `Thread.copyPath`

`source.forkPath(lastEntryId)` returns the active path through
`lastEntryId`. It refuses a path that holds a tool call that is still
running. The API calls it before it creates the new thread, so a refused fork
leaves no empty thread. `target.copyPath(path)` fills the empty thread with
copies and appends the fork note, through `appendBranch` with a null
expected leaf.

### Path walk: notes are roots of new history

An edit of a thread's first message writes a note with a null parent: a
second root. `walkTranscriptDag` keeps a legacy prefix of null-parent
entries before a path's root, for transcripts written before TKAI-211.
Only this change writes `branch_summary` entries, so a path whose root is a
branch note is never legacy. The walk skips the legacy prefix for such a
path.

### Reads follow the active path

`Thread.readEntries` returns the active path unless the query names a
`queueItemId` or sets `allBranches`. So the REST message list, the recap,
reply validation, and the `thread_read` tool read the version the model
sees. The sandbox file route reads all branches, so a file attached on the
old branch stays downloadable.

A thread that never branched has one path. The thread metadata key
`branched` marks a thread whose leaf moved. `editMessage` and
`returnToBranch` set it before the leaf can move. Until then
`readEntries` keeps the bounded store read, so threads that never use this
feature read exactly as before. A branched thread reads the active path from
one store snapshot. Several routes already read every entry of a thread, so
this adds no new class of query.

While an edit waits to start, the read path already ends before the edited
message. The client hides those rows at Send, and a refetch before the
claim must not bring them back. Another viewer sees the old version go at
the same moment.

## API

- An edit is a send: `POST /api/threads/:threadId/messages` with
  `editEntryId`. It keeps the send route's checks, attachments, and guest
  rules. An edit cannot run a slash command, reply, promote, or set a queue
  mode.
- `POST /api/threads/:threadId/branch/return` with `{ noteEntryId }`.
- `POST /api/threads/:threadId/fork` with `{ entryId }`. Members only.
  Returns the new thread summary and, for a user message, the text for the
  composer.
- The REST message list projects a note as a system message with a
  `branch` field: `kind` (`edit`, `return`, or `fork`), the tool list, a
  files-changed flag, and `canReturn`. A user message that an edit wrote
  carries `editOf`, and the UI marks it "edited". A user message that came
  in through a channel carries `channelType`, and the UI offers no Edit.
- A `branch_switched` wire event tells every viewer of the thread to refetch
  its messages.

## Web

- The message action row gets Edit (own messages) and "Branch into a new
  thread". On phone width the actions are always visible, at 44-pixel
  targets.
- Edit uses the existing composer with an "Editing your message" bar, like
  the reply bar. While editing, the list dims the message and everything
  after it. If the message had files, the bar says to attach them again: an
  edit carries the text and images only.
- After Send, the list hides those rows until REST no longer lists the
  edited message. If the server refuses the edit, the rows come back and the
  edited text stays in the composer with the server's reason.
- `useThreadEdit` holds this state for the main view and for a
  shared-thread guest's view.
- A branch note renders as a divider, like the compaction divider. It
  expands to the tool list and the "Go back to this version" button.
  Consecutive edit and return notes, as repeated edits of one message
  leave, share one divider ("3 earlier versions kept"), which lists each
  version newest first. A person who retries five times sees one row, not
  five.
- Another viewer's list refetches on `branch_switched`, and rows still
  streaming on the old branch go. Their draft does not change.

## Limits

- The sandbox does not rewind. The note says so.
- A message that came from Slack cannot be edited. The person forks instead.
- Thread search, the auto-title, and the thread list's last-activity line
  still read every branch.
- A fork of a team thread starts with an empty working directory.

## Validation

- Store contract: `appendBranch` moves the leaf from a non-leaf parent,
  refuses a stale `expectedLeafId`, and checks the fence.
- Engine: edit while idle, while running, while gate-blocked, with queued
  messages, of the first message, across a compaction, and go back.
- API: authorship rules, guests, Slack messages, fork of each message kind.
- Web: the edit bar, the hidden rows, the note divider, fork navigation.
- Local check with two accounts at desktop and phone width.
