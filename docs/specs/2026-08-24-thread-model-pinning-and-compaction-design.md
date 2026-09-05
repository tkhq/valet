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

Turn model resolution becomes: **agent escalation → item model → thread pin →
session default**.
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

### 9. Oversized inbound input spills to a file; an un-compactable tail fails loud

Compaction summarizes older turns and keeps the newest turn verbatim. A single
message larger than the model's context window is therefore un-compactable: it
overflows, compaction summarizes the (small) head, the retry re-sends the same
oversized tail, and the turn overflows again. Left unhandled this loops forever.
It shipped as a real incident: a pasted session transcript of about 240k tokens
bricked a 200k-window thread, which looped `compact 43.7k -> 1.1k` then `400
prompt is too long` on every turn.

Two layers fix it:

- **Spill (primary).** When one inbound user message exceeds
  `compaction.maxInputTokens` (default 60% of usable context; `0` disables),
  `appendUserEntry` writes the full text to `<workspace>/.valet/large-inputs/
  <entryId>.txt` in the sandbox. The persisted entry keeps the FULL text in
  `content` (durable, REST-visible, so the transcript still shows what the user
  said) plus the file path in metadata (`valetSpilledInputPath`). Only the LLM
  view becomes a pointer: `runAgent` prompts a marker, and
  `entriesToAgentMessages` renders the same marker on reload, so hot and cold
  transcripts agree and neither re-overflows on the paste. The model pages the
  file with the read and bash tools. Signals are exempt (bounded, and their XML
  envelope must render verbatim). If the sandbox write fails, the full text
  stays in context (nothing is truncated or dropped) and the fail-safe below
  surfaces a clear error if it overflows.
- **Fail-safe (defense in depth).** For a tail that still exceeds the window
  (an oversized tool result, or a spill that could not write), `compactThreadInner`
  checks the kept tail after cut-point selection. It measures the POST-prune
  view: a tool result the prune pass just elided is fittable now, so counting
  it at full size would wrongly abandon the turn. When `selectCutPoint` returns
  `fallbackToFloor` (it could not fit even the last turn in the tail budget)
  AND that post-prune tail still exceeds usable context, compaction cannot
  help. It returns the new `"insufficient"` outcome and emits one
  `context_overflow_unrecoverable` error naming the size and the fix (shorten,
  split across turns, or attach as a file). The reactive path stops instead of
  retrying; the proactive path feeds the circuit breaker without re-emitting.
  The `fallbackToFloor` gate keeps this off the normal small-model path, where
  the tail-budget floor legitimately exceeds a tiny usable window.

## Amendment (2026-09-03, TKAI-338): agent escalation is turn-scoped

The original design gave `switch_model` and the user's own controls one field,
`engine_threads.model`. Two writers on one field produced a defect: the
orchestrator persona told the agent to escalate before it designed or spawned,
so a routine turn rewrote the user's setting, the picker reported the new
model, and the thread stayed on the expensive model for every later turn.

Worse, the escalation did not do the thing it was for. `Thread.setModel` wrote
the pin but never touched `agent.state.model`, and pi-agent-core snapshots the
model into its loop config once per run. The turn that called `switch_model`
finished on the model it started with. Escalation applied only to the turns
that followed — the exact inverse of the intent. A turn that suspended at a
decision gate behaved differently again, because `applyResolvedKeyForResume`
re-read the spec and did apply it.

The amendment splits the two writers by scope:

- **User writes** (`PATCH .../threads/:threadId`, `/model`) keep
  `modelOverride`: persisted, applied from the next turn, unchanged.
- **Agent writes** (`switch_model`, marked by a `tool:` reason) go to
  `Thread.agentModelSwitch`: in-memory, never persisted, ranked first in
  `turnModelSpec`, and dropped when the turn settles.

`Thread.setModel` now retargets the live agent for an agent write, and
`buildAgent` wires pi-agent-core's `prepareNextTurn` hook to re-read
`agent.state.model` between loop iterations. Together those make the tool's
advertised contract — "takes effect on the next LLM call" — true for the first
time. `agent.state.model` is what carries the switch across a live decision
gate: the gate blocks inside the agent loop and never unwinds `runItem`, so
the loop resumes on the model it was retargeted to. The `turnModelSpec`
ranking is the correct precedence for any future site that re-derives the
spec mid-turn, not the mechanism that makes the gate case work.

Consequences worth stating:

- An escalation no longer survives the turn. An agent that needs a strong
  model on a later turn calls `switch_model` again. Work that needs one
  throughout should set the child session's `model` at spawn.
- A restart mid-turn resumes on the user's model, because the escalation was
  never persisted. That is the safe direction: the fallback is always the
  model a human chose.
- The picker needs no special read. `modelOverride` holds only the user's
  choice, so the picker, `/status`, and the runtime agree by construction
  rather than by a display-time rule.
- `model_switched` carries `scope: "turn" | "thread"`. A turn-scoped switch
  ends when the turn settles and emits no matching switch back, so a consumer
  that rebuilds the current model from the event stream must not treat it as
  durable. The web stream store skips its refetch for turn scope: the picker
  reads the user's pin, which a turn-scoped switch never changes.

## Amendment (2026-09-04): agents receive their current model

Each outbound agent call receives a `Runtime model` section after its system
instructions. The engine supplies these facts at the stream boundary:

- Assigned selection, captured when the turn resolves its model.
- Active selection, including a successful role override or agent switch.
- Actual provider and model ID from the model passed to the stream function.
- Temporary override source and its expiry at the end of the turn.

The assignment uses the submission model, thread pin, then session default.
Capturing it prevents a concurrent user pin change from mislabeling a running
turn. The active selection uses an agent switch, then a successful role model,
then that assignment. A failed role lookup or model switch does not change it.
Selections retain tier tokens when available. The engine never infers a tier
from a concrete model ID because several tiers can resolve to the same model.

The engine recomputes this section for every call, including continuations and
restored sessions. It does not store the section in messages or mutate the base
system prompt. Context estimation and cache telemetry include the added text.
The text has no timestamp or per-call counter, so unchanged facts remain stable.

The [supervised model guidance](2026-09-04-supervised-model-guidance-design.md)
replaces blanket escalation advice. Supervisors select drafting and review
tiers. Children retain their assignment unless evidence supports escalation.
These prompt rules do not change model resolution, persistence, or user pins.

## Amendment (2026-09-04): show the active turn model without changing the pin

The turn-scoping change fixed persistence, but it made the session header
incorrect during an escalation. `switch_model` emits the active turn model on
the wire. The web stream store discards that event, and the picker trigger
continues to show the persisted thread pin. The trigger calls that value the
current model even while the agent uses a different model.

The UI must represent two model values:

- **Configured model:** The thread pin that the user controls. The picker rows,
  check mark, and reasoning controls continue to read and write this value.
- **Active model:** The model spec used by the current turn. The closed picker
  trigger shows this value while it differs from the configured model. The
  tooltip names both values so the temporary switch cannot look like a saved
  setting change.

The engine keeps a transient active-model state for each running submission.
It sets the queue-item model before pre-turn compaction can make an LLM call,
then replaces the state after a role overlay changes that concrete model. An
agent switch replaces the state after it retargets the live agent. Restart
continuations that bypass the normal turn runner also set the state after
model and credential resolution and before calling `agent.continue()`. Every
state transition uses the current attempt fence while one exists, so a stale
attempt cannot publish over its successor. If that fenced publish detects a
stale attempt before an LLM call, the caller stops instead of invoking the
provider or continuation under lost ownership. That skip still flows through
the path's existing restoration, settlement checks, active-state clearing,
and claim cleanup; it is not an early return around ownership cleanup. The
state includes the queue item id, clears before that item settles or leaves
its recovery path, and adds no persisted field.

Publishing and snapshot reads share a serialized transition queue. The thread
updates its committed in-memory snapshot only after the fenced event append
succeeds, and its asynchronous snapshot method waits for any pending
transition. A reconnect therefore cannot observe a candidate model whose
attempt later fails fence validation.

`model_state` is correctness-critical rather than best-effort. Its emit opts
into append-error propagation while other engine events keep their existing
logging behavior. A failed initial, role, or recovery publication prevents the
next model call; an agent-switch failure restores the previous live model and
key before reporting the tool failure. Settlement removes the matching item
from the handshake-visible snapshot before it attempts the idle event and
tracks idle-delivery retries separately. A reconnect therefore cannot revive a
settled item while an idle append is being retried.

The engine emits `model_state` when it sets, replaces, or clears this state.
The wire maps the event to `model.state` with `threadId`, `queueItemId`, and a
nullable concrete catalog id. Active frames carry string values for both
fields. Idle frames carry `queueItemId: null` and `model: null`; the two fields
never mix active and idle values. The engine forms the concrete catalog id as
`{model.provider}/{model.id}`. This preserves the provider namespace that the
provider-wire `model.id` omits, including a custom provider row id and a nested
OpenRouter model id. The web uses its existing Anthropic normalization when it
compares this id with a bare configured pin. The API CLI recognizes and yields
the new wire member like every other `WireEvent`. The WebSocket handshake also
sends one snapshot per thread after it subscribes to live events and completes
durable replay. This order closes the race between reading the snapshot and
receiving a concurrent switch or settlement. A null value clears stale state
after reconnect. `model_switched`
remains the audit event that distinguishes temporary agent switches from saved
changes.

The web stream store keeps `activeModelByThread`, including its queue item id:

- A `model.state` frame replaces or clears the active model.
- An `init` frame clears the whole transient map before handshake snapshots
  reseed it.
- A matching `submission.settled` frame clears the active model as a fallback.
- A settlement for a different queued or merged item does not clear the
  running submission's model.
- Durable session and thread switches keep their existing query invalidation.

`ModelPicker` accepts a separate display id. The display id changes only the
closed trigger. `currentId` remains the configured selection and continues to
control row check marks, approval handling, and reasoning support.

Two smaller alternatives do not meet the requirements. Persisting an agent
switch regresses TKAI-338 and can strand a thread on an expensive model.
Passing the runtime model as `currentId` makes a temporary value look saved and
changes which reasoning setting the dropdown edits. Refetching REST data alone
cannot work because the active model is intentionally not persisted. Tracking
only `model_switched` also misses queue-item and role model overrides that are
already active when a client connects.

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
