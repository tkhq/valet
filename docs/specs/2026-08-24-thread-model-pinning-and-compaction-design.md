# Thread model pinning and compaction visibility — design

Status: implemented (TKAI-201). This document was authored with the 2026-08-24
spec suite, referenced from `2026-08-24-small-fixes-design.md`, and committed
with the implementation.

## Problem

Two related gaps in the v2 model/compaction stack:

1. **A chat does not keep the model it started with.** The durable per-thread
   pin exists end to end (`engine_threads.model`, `Thread.setModel`, the PATCH
   thread route, `/model`, `switch_model`), but no thread ever receives a pin
   at creation. Every thread silently tracks the session default, so a session
   model change retroactively rewrites what model old chats run on. When a pin
   does exist but stops resolving, the turn silently falls back to the session
   default. `QueueItem.model` is persisted and traced but never consulted, so
   a workflow session node's model choice is silently ignored.
2. **Autocompaction is invisible and mis-budgeted.** Compaction runs and
   persists a `CompactionEntry`, but the bridge drops `compaction_start` and
   `compaction_end`, REST drops the entry, and the UI shows nothing. All five
   budget sites read `session.options.model`, so a thread pinned to a
   small-context model overflows before compaction triggers. The proactive
   trigger state (`lastAssistantUsage`) is lost on restart, so the first
   post-restart turn is unprotected. `/compact <instructions>` echoes the
   instructions but never sends them to the summarizer.

## Decisions

### 1. `Session.thread()` stamps the pin at creation

`Session.thread()` is the single creation seam — default (`web:default`),
web-created (`web:{nonce}`), channel, signal, and workflow threads all funnel
through it; rehydration constructs `Thread` from persisted data and never
stamps. At creation the thread's `model` is set to the session's effective
spec (`options.modelSpec ?? options.model.id`). One chat keeps the model it
started with; a session default change affects only future threads.
`setModel(null)` still clears the pin, which returns the thread to tracking
the session default — the escape hatch is explicit, never silent. Threads
created before this change have no pin and keep their old inherit behavior.

### 2. `QueueItem.model` is a real precedence layer

Turn model resolution becomes: **item model → thread pin → session default**.
`turnModelSpec` and both resolution paths take the running item. This makes
the workflow session-node `model` field effective. One shared
`validateModelSpec` serves `submitPrompt` admission and `setModel` (resolver
null → reject; `NoCredentialsError` → accept, a model is selectable before
its key is configured; a spec naming the session's own effective spec or the
thread's current pin is valid by construction). A workflow node whose model
fails admission settles that NODE `failed` — the interpreter's submission
seam contains the `ValidationError` so a definition error cannot poison the
whole run drive. A role's frontmatter model still overlays the resolved turn
model for that one turn, unchanged.

### 3. A dead pin fails the turn loud

`resolveTurnModel` no longer falls back to the session default when the pin
stops resolving; it throws, and the error names the corrective action
(`/model <id>` or clear the pin). `resolveTurnModelForTurn` throws when the
host resolver returns null for the effective spec, matching
`applyResolvedKeyForResume`'s existing loud-fail contract — silently
proceeding would continue the turn on a model and credentials the user never
chose. The turn settles `failed` with the message in the transcript.

One carve-out: a pin that names the session's own effective spec resolves to
the live session model object without a registry lookup. The session already
holds that model, and it may not be in pi-ai's static registry at all
(custom providers, test doubles) — requiring resolution there would break
every stamped thread of such a session. Only a DIVERGENT pin resolves (and
can fail) on its own. Non-turn sites that must not throw (transcript
rehydration) use a lenient helper that falls back without throwing.

### 4. Budget sites use the thread's effective model

Compaction always runs inside a claimed turn (proactive after `runAgent`,
reactive inside it, manual via the in-turn command path), so
`agent.state.model` holds the resolved effective model — including
resolver-only specs the internal registry cannot resolve. All five budget
sites switch to it: the proactive trigger (`shouldCompactProactive`), the
reactive overflow check (`isContextOverflow`), the summarizer fallback model,
cut-point selection, and the post-compaction transcript rebuild.

### 5. The proactive trigger rehydrates from the DAG

On rehydrate, the thread arms a one-shot pre-turn check flag
(`rehydratedCheckPending`) whenever the rebuilt transcript is non-empty.
(TKAI-305 replaced the original `lastAssistantUsage` seeding: the trigger
now estimates the rehydrated transcript directly, so no usage value is
carried over and a trailing `CompactionEntry` needs no special case — the
estimate already reflects the summary-plus-tail context.)

The flag needs its own consumer: the regular proactive check runs only
post-turn, so the flag alone would never protect the first post-restart
turn. `runItemInner` therefore runs a one-shot PRE-turn check when the flag
is set — if the rehydrated transcript's estimate already exceeds usable,
the thread compacts before the turn's LLM call. Two ordering rules keep the pass correct: it
runs BEFORE the turn's user entry is appended (compaction rebuilds the agent
transcript from the DAG, so an already-persisted user entry would enter the
rebuild AND be prompted again — the model would see it twice), and it
suppresses both the proactive auto-continue follow-up and the
`skipNextProactiveCheck` cool-down (there is no follow-up turn; arming the
cool-down would eat the same turn's legitimate post-turn check).

### 6. `/compact` instructions reach the summarizer

`compactThread` accepts `instructions`; the manual command passes its
argument text through, and `summarize` appends the instructions to the
summarizer prompt.

### 7. Compaction crosses the wire

- `compaction_start` / `compaction_end` become `WireEvent` variants (threadId
  only). The engine balances the pair with a `finally` that spans the
  summarizer AND the persist/rebuild steps, so a mid-compaction throw still
  emits `compaction_end`. The web stream store tracks a per-thread
  compacting flag and, on `compaction_end`, bumps a nonce that invalidates
  the messages query so the divider appears without a reload. The flag is
  transient: the `init` frame clears it on reconnect, because an api crash
  between the two frames orphans the start with no end ever coming.
- `entryToMessage` projects `CompactionEntry` as a `role: "system"` message
  with a `compaction` field: `{ summary, tokensBefore, tokensAfter,
  coveredEntryIds }`. `coveredEntryIds` is deliberately on the wire: it is
  the seam a future DAG explorer needs to roll a thread back to (or forward
  from) a compaction boundary. REST stays the authoritative history source
  (locked decision 3).

### 8. Web UI

- The session-header model picker becomes thread-scoped: it shows the active
  thread's effective model and PATCHes the thread. The session default stays
  API-patchable and governs new threads.
- Thread rows show a pin chip when the thread's pin differs from the session
  default (full model id in the tooltip).
- The message list renders a compaction divider for messages with
  `compaction`: a rule with token counts and a collapsible summary.

## Out of scope

- DAG exploration UI (roll back / roll forward across compaction boundaries).
  The wire projection carries `coveredEntryIds` so that UI can be built
  without another wire change.
- Backfilling pins onto pre-existing threads.
- A UI for the session default model beyond the existing PATCH route.

## Coordination

This change edits the same `makeResolveModel` seam as the spend-limits spec —
whichever lands second rebases. The small-fixes spec (2026-08-24) defers its
split-brain candidates 2 and 5 and its silent-downgrade fix to this document.
