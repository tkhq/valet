# Thread edit and fork

Date: 2026-10-22. Status: built, piloted on one deployment. Revised on 2026-10-23
for compact version history, the fork command, and file isolation. The design
includes a parity review of Claude Code, claude.ai, Codex, Cursor, Cline,
Copilot, Replit, Devin, OpenCode, Amp, and Factory (decisions 7 to 12).

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
working directory is undone. Files in the working directory come back only
when the person chooses to undo them (decision 7); otherwise the note says
that the working directory keeps the changes.

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
team thread runs in its own execution session and sandbox, so its fork gets
the source's files at the fork point (decision 9).

A team fork keeps the source's audience, by the rules the thread read gate
uses (`threadAudience`). The fork records every Slack channel that gates the
source, including those of the threads above it, before any history is
copied. A thread private to one person, such as an Ask Valet or workflow
editor thread, cannot keep that audience as a new team thread, so its fork
is refused with the reason.

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

### 7. File checkpoints per turn, undone with the edit

Every other hosted and IDE agent that restores files lost data at some
point: missed shell edits, wiped staging, prunes that deleted files. Codex
and Amp gave up on it. Valet's agent works in its own server-side sandbox,
which removes the worst failure (touching a person's own checkout), and it
keeps exact records. So Valet restores files, under these rules.

- A turn that calls a tool marked `sideEffect: "files"` (`bash`, `write`,
  `edit`) snapshots each git repository under the working directory before
  its first such call, and again when the turn ends. A snapshot commits the
  whole working tree (tracked and untracked files, not ignored ones) through
  a temporary index. The person's index and files never change. The commits
  live under `refs/valet/checkpoints/<thread>/<entry>/`, so git keeps them for
  the life of the repository.
- The temporary index is a copy made with `cp -p`. A plain copy gets a new
  file time, and then git trusts stale stat data for a file rewritten in the
  same second at the same size ("racy git"). The first build had this bug;
  a test now holds the rule.
- The turn's user entry records each repository's two snapshots and the
  changed paths (`metadata.fileCheckpoint`).
- The edit bar offers "Also undo file changes (N files)", with the file
  list. It defaults on, and off when the replaced turns ran `git push` or
  opened a pull request: a local undo does not reach those.
- The undo touches only the paths the replaced turns changed. Each path goes
  back to its content before the first replaced turn that changed it, and
  only while it still holds what the last of them left. A path that someone
  else changed after them is left alone and listed. A personal assistant's
  threads share one sandbox, so a whole-tree restore would wipe another
  thread's work.
- A path that did not exist before is removed. That removal is an undo of
  a recorded creation, and it is recoverable: the undo takes a restore point
  of the working tree first, and the note records it.
- "Go back to this version" can bring the files back: it undoes the current
  version's own changes, then restores the undone paths from the restore
  point.
- A snapshot skips untracked files when they total over 50 MB, and gives up
  after 20 seconds. A failed snapshot never blocks the tool; that turn has
  no checkpoint, and nothing undoes its files. Directories that are not git
  repositories are not restored.

Rejected: a whole-tree restore (Cline's reset and clean). It is wrong for a
shared sandbox, and it destroys work that the records do not cover.

### 8. The edit bar previews the edit before Send

Call: `GET /api/threads/:id/edit-preview` returns what the branch note would
say: how many turns Send replaces, the actions and approval choices that
still stand, and the files that the undo can put back. A refusal (for
example, someone wrote after the message since) shows in the bar, and Send
stays off.

### 9. A fork keeps its files

Call: personal assistant forks and team forks run in a new execution session.
Each fork has its own working directory. A personal fork directory sits outside
the source directory, so source snapshots cannot include fork files. Recorded
paths that overlap are refused. Ordinary personal threads keep their
existing shared directory. The fork route bundles each changed
repository's last checkpoint at the fork point (`git bundle`, leaving out
what the remote holds, at most 50 MB) into the blob store. The fork's first
turn applies its own newest fork note before its model call: it checks out the snapshot's commit
and puts the snapshot's working tree on top, unstaged. The fork note then
says which repositories came along or why one failed. Repository paths are
stored relative to the working directory.

The bundle file sits in the repository's git directory while it is written
or read (`git rev-parse --git-path`). The sandbox file calls reach only the
working directory, and a file there never shows as an untracked change. A
repository that the source thread made itself has no remote, so workspace
prep does not clone it into the fork, and its bundle holds its whole
history. If nothing is at that path in the fork, the first turn starts an
empty repository there and applies the bundle. If the bundle needs commits
that the fork's copy does not have, the apply fails, the empty repository
is removed, and the note gives that reason.

### 10. Rewind is cache-safe

Call: a rewind keeps the system prompt and every message before the edit
point byte-identical, and the note follows that prefix. A test compares the
system prompt and the message list that the provider receives before and
after an edit. The first model call after a branch switch logs its
`cache_read` tokens and sets `valet.turn.after_branch_switch` on the turn
span.

### 11. A Slack edit becomes a note, with no reply

Call: Valet cannot rewrite a thread for a Slack edit, because the Slack copy
of the reply stays. A Slack `message_changed` event for a DM conversation or
a followed thread becomes a record-only signal: "edited in Slack, before,
after". A record-only queue item (`metadata.recordOnly`) appends its entry
in queue order and makes no model call; the next turn reads it. A link
preview that loads sends `message_changed` with the same text, which is not
an edit. A message from Slack still cannot be edited from the web; it can be
forked.

### 12. The note lists approval choices that still apply

Call: an approval choice beyond the engine's one-time approval (for example
"Always allow for me", "Approve for this session") outlives the branch it
was made on. The note lists each one, from the left branch's decision-gate
entries, so neither the person nor the model assumes the edit took it back.

### Later

- Compare two versions: a files diff between two leaves' checkpoints, and
  each version's outside results.
- Try N ways: fork one message into parallel threads with separate sandboxes.
  It costs N times as much, so it needs an explicit choice.

Rejected: a model-written summary of the abandoned branch (Claude Code's
"summarize from here"). The record-based note is exact and costs no model
call.

## Parity

| Capability | Best elsewhere | Valet |
|---|---|---|
| Edit any earlier own message, prompt back in the composer | Claude Code, OpenCode, Copilot | Parity |
| Edit while a turn runs | Codex refuses; others stop first | Better: Send stops the turn |
| Old version kept and reachable | Replit, Copilot Redo | Better: "Go back", nothing deleted |
| Says what still stands outside | Nobody | Better: note, in model context |
| Undo files with the conversation | Claude Code, Cline, Copilot, Replit | Parity, path-scoped and recoverable |
| Preview before the rewind | Copilot CLI, Factory | Parity |
| Fork from any message, with files | Codex, Claude Code `/fork` | Parity |
| Cache-safe rewind | Claude Code, Codex | Parity, tested |
| Shared-thread rules | Factory, Amp, Claude in Slack | Parity |
| Slack edits | Claude in Slack | Parity |
| Compare versions, try N ways | Codex cloud, Cline | Later |

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

One edit waits at a time. A second edit is refused only while an earlier
edit has not written its note. Once the note exists, that edit has started,
and its turn can run on or wait for an approval while the person edits again.

### Compaction during a branch switch

Compaction reads the active path, summarizes it, then appends its entry. A
manual `/compact` can run outside a claimed turn, so an edit or a return can
move the thread while the summarizer runs. The append then checks, under the
store's compare-and-swap, that the active path still holds the leaf the
compaction read. If it does not, the summary describes the branch the thread
left, so the compaction drops it, returns `noop`, and sets
`valet.compaction.dropped` on its span.

## API

- An edit is a send: `POST /api/threads/:threadId/messages` with
  `editEntryId`. It keeps the send route's checks, attachments, and guest
  rules. An edit cannot run a slash command, reply, promote, or set a queue
  mode.
- `undoFiles: true` on an edit also undoes the replaced turns' files.
- `GET /api/threads/:threadId/edit-preview?entryId=` returns what the edit
  replaces (decision 8). Guests with reply access may call it.
- `POST /api/threads/:threadId/branch/return` with `{ noteEntryId }`, and
  `restoreFiles: true` to bring files back.
- `GET /api/threads/:threadId/branch-preview?noteEntryId=...` reads the saved
  path with the thread's read permission. Cursor pages are bounded. Preview
  never moves the leaf, writes entries, or changes files.
- `POST /api/threads/:threadId/fork` with `{ entryId }`. Members only.
  Returns the new thread summary and, for a user message, the text for the
  composer.
- The REST message list projects a note as a system message with a
  `branch` field: `kind` (`edit`, `return`, or `fork`), the tool list, a
  files-changed flag, `canReturn`, the approval choices that still apply,
  the file undo's results, and a fork's file seed. A user message that an edit wrote
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
  after it. The bar shows the preview and the file undo choice. If the
  message had files, the bar says to attach them again: an edit carries the
  text and images only.
- After Send, the list hides those rows until REST no longer lists the
  edited message. If the server refuses the edit, the rows come back and the
  edited text stays in the composer with the server's reason.
- `useThreadEdit` holds this state for the main view and for a
  shared-thread guest's view.
- Consecutive branch notes share one divider ("3 earlier versions kept").
  It opens a bounded history panel. Each row shows the original message
  excerpt and time. Legacy notes use the note time. View selects one version
  and loads its transcript without changing the conversation or files.
  Only the selected version shows its lasting actions, file choice, and
  Restore this version action. Transcript pages contain at most 100 entries.
  Older pages load only when requested.
- `/fork` branches at the latest completed assistant reply and opens the
  new thread. `/fork <prompt>` also sends the prompt in that thread. Both
  use the message action's permission checks and file seed path. The source
  keeps a command result with a link; it makes no model call.
- Another viewer's list refetches on `branch_switched`, and rows still
  streaming on the old branch go. Their draft does not change.

## Limits

- File checkpoints also cover eligible regular files outside git repositories.
  A hidden object store holds these snapshots without making the working
  directory a git repository. Hidden paths, credentials, dependencies, caches,
  build output, and symbolic links stay outside this coverage. The snapshot
  has the same size and time bounds as repository checkpoints.
- Packages installed outside the working directory and running processes do
  not rewind. External actions do not rewind. A push, post, or deployment needs
  its service's recovery operation. A conversation restore never invokes one.
- A turn whose snapshot failed or timed out has no file undo. Its coverage
  gap blocks a restore across that target and prevents a stale fork seed.
- A repository created during a turn gets a fork snapshot afterward. Its
  files cannot rewind across that turn, because it has no earlier repository
  checkpoint. The note records that coverage gap.
- Fork bundles also carry the snapshots needed to edit copied history and
  use retained return notes. Only the copied path supplies these snapshots.
  A missing commit, tree, or blob fails the restore before any file changes.
- The separate object store ignores its own files. A later repository init
  and ordinary git add cannot stage the checkpoint store.
- Standalone sessions cannot fork into assistant execution directories without
  changing their tools and persona. The fork is refused with a reason.
  Personal and team assistant conversations support isolated forks.
- A message that came from Slack cannot be edited from the web. The person
  forks instead.
- Thread search, the auto-title, and the thread list's last-activity line
  still read every branch.
- A team fork copies files only for repositories that its working directory
  also has from the same remote, or that the source thread made itself with
  no remote.

## Validation

- Store contract: `appendBranch` moves the leaf from a non-leaf parent,
  refuses a stale `expectedLeafId`, and checks the fence.
- Engine: edit while idle, while running, while gate-blocked, with queued
  messages, of the first message, across a compaction, and go back. File
  checkpoints with real git: the index stays unchanged, the undo is
  path-scoped, a later change is skipped, the racy-git rewrite, a return
  brings files back, a team fork's files arrive, and a fork makes a
  repository that the source thread created. The test sandbox refuses file
  paths outside the working directory, as docker does. The rendered prefix is
  the same before and after an edit. A record-only signal makes no model
  call. Approval choices appear in the note. A second edit while the first
  edit's turn runs, and a compaction that an edit overtakes.
- API: authorship rules, guests, Slack messages, fork of each message kind,
  the preview, and Slack edits from a DM and from a followed thread. A team
  fork of a private thread is refused, a fork keeps its source's Slack
  channels, and an attachment on a version an edit left still downloads.
- Web: the edit bar, hidden rows, history panel, read-only version preview,
  older-message pages, restore success and errors, and command navigation.
  The history list renders 20 versions at a time.
- Fork commands retain trailing return and compaction notes, exclude an
  unfinished turn, preserve raw prompt text, and refuse reply guests.
- Personal forks keep their owner, model, reasoning, and private audience.
  Forks of forks apply the new seed. Retained assistants with a different
  persona are refused. Root thread lists include isolated forks after reload.
- Local check with two accounts at desktop and phone width, in docker
  sandboxes: an edit with "Also undo file changes" left the agent reading
  the earlier file content; Go back brought the changed files back; a second
  Go back undid them again; a team fork read the source's commits, its
  uncommitted change, and its untracked file. A teammate's edit preview of
  another person's message is refused.

### Fork command integration

`/fork` copies the source thread through its latest completed assistant reply.
An empty thread creates a fork with no copied messages. An unfinished tail
stays in the source thread. `/fork <prompt>` then submits the raw prompt in
the new thread. Quotes and line breaks in that prompt stay intact.

The message route supplies a request-scoped engine command hook. Both the
hook and the fork endpoint call the same authorized fork operation. That
operation checks membership, keeps the source audience, and uses the same
file seed export. Personal forks use separate execution sessions, as team
forks do. Unsupported standalone sessions return a corrective error.

A successful command persists a link in the source thread and returns its
destination as `SendPromptResponse.fork`. The web composer opens that thread.
CLI callers can use the link. Channel hosts without the authorized hook
return a command failure with a link to continue in the app. They do not
copy session history through a separate engine path.

### Local check on 2026-10-23

The production web build showed the compact history panel at desktop and
375-pixel phone width. Viewing a version kept the active conversation unchanged.
Restore returned to that version and closed the panel. The command menu listed
`/fork`. Two fresh test accounts checked the private history boundary.

A live file check created and changed a text file outside Git. Edit with file
undo restored its earlier content. `/fork <prompt>` copied that content into a
disjoint personal directory. A change in the fork left the source file unchanged.
The second account could read neither the personal fork nor its saved history.

### Release safety review

- Copy Slack channel gates to an isolated fork's governing thread before copying history or files. Sandbox resource access uses this boundary too.
- Recheck edit ownership on the snapshot used for the branch compare-and-swap. A newly arrived message from another author must stop the edit.
- Commit the branch note before file restoration. Save each restore point and planned bases on that note before changing files. An interrupted restore keeps a recovery record.
- Do not use a partial checkpoint pair for automatic undo or fork seeds.
- Refuse restore paths with symlink ancestors before reading or deleting files.
- Record actual sandbox file writes. Allow automatic undo only when the write's preimage and result match the checkpoint blobs and file modes. Skip concurrent, legacy, and opaque shell changes without this evidence. Keep those changes available in complete fork snapshots.
- Carry earlier branch notes' external actions, lasting grants, and file coverage context into later edits. Retain provenance to avoid counting the same action twice.
- A completed undo note establishes the current fork file state, even when the replacement turn makes no file-tool call. An interrupted restoration cannot establish a seed.

Safe restoration requires Python 3 and directory handles that refuse symlinks.
If the sandbox lacks them, restoration leaves files unchanged and reports the missing requirement.
Content and mode conflict checks are best effort against external writers; they do not provide a shared filesystem transaction.
Shell and binary writes without an observed file-write receipt are not undone automatically.
