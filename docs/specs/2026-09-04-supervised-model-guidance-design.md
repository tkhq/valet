# Supervised model selection and runtime model context

## Purpose

Valet supervisors assign bounded tasks to children. Current prompts require L/XL before every code change, which defeats smaller drafting models.
Agents also lack an automatic statement of the model that executes each call.

## Decisions

1. Supervisors use L/XL for planning, task assessment, supervision, and final judgment. Short status and routing turns can remain small.
2. Supervisors select each child's tier explicitly. S handles mechanical work. M handles bounded implementation. L handles difficult implementation when justified.
3. Separate L/XL children review requirements and code quality. XL children review only. Drafting children address findings before review repeats.
4. Children retain their assigned model during normal work. A capability gap after meaningful attempts can justify the smallest sufficient escalation.
5. Children explain escalation. A routine failing test, long task, missing credential, or unavailable tool is insufficient evidence of a capability gap.
6. Review children report findings without implementing fixes. Supervisors retain ownership of delegation and completion checks.
7. These rules guide selection; they do not add runtime tier restrictions or change user model preferences.

## Runtime context

The engine appends a compact `Runtime model` section to the outbound system prompt for each agent model call.

The stable prompt prefix carries a fixed `Thread started` block (TKAI-584). It shows the persisted thread creation time as UTC to the minute, the weekday, and the user local time. The thread stamps the user timezone into its metadata when it is created, with `createdAt`, and never rewrites it. A later timezone change leaves existing threads alone, and new threads use the new value. If the timezone is not known, the block says so. The block never changes between calls or across restarts, so it does not break the prompt cache. It says the time is the thread start, not now. It points the agent to the newest `[sent: …]` line for the current time (see Message sent time), and to `date -u` when it has a shell tool. The memory snapshot header gives the date the snapshot was built, which is a different date. The host passes `userTimezone` and `resolveUserTimezone` from `users.timezone` for personal sessions. The web client reports the browser timezone once per account (`users.timezone_report_done`), so a clear in Settings stays cleared.

It reports the assigned model selection, active selection, actual provider and model ID, and any temporary override scope.
The assigned selection comes from the submission model, thread pin, or session default, in that order.
The engine captures it when the turn resolves its model. A later user pin change affects the next turn.
Tier tokens remain tokens. A concrete selection has no inferred tier because several tiers can resolve to the same model.

The active model comes from the model passed to the stream function, after resolution and role or agent overrides.
An agent switch takes precedence over a successful role override. Both overrides expire when the turn ends.
The context is recomputed for subsequent calls and restored sessions. Failed switches leave it on the model actually running.
The context does not mutate the durable prompt, transcript, thread pin, or session preference.
Its stable text preserves the existing system prefix and does not add timestamps or per-call counters.

### Message sent time

The thread start alone does not tell a turn the current time. An assistant thread or a Slack thread runs for days. The agent then took the date from the thread start or from earlier messages, and did "today", "tomorrow" and schedule math from the wrong day. So every user message in the model transcript starts with a `[sent: …]` line (`messageTimeLine`). It shows when the message was sent, in UTC with the weekday, and in the user local time when the timezone is known, for example `[sent: Thursday 2026-10-15 16:35 UTC; user local: Thursday 2026-10-15 09:35 PDT (America/Los_Angeles)]`. The newest line is the current time, and the `Thread started` block says so. The line applies to every user entry: prompts, Slack messages, workflow steps, schedule and event signals, messages delivered mid-turn, and the compaction continuation.

The line goes on the message, not in the system prompt. The system prompt is the first part of the cached prefix, so a per-call clock there makes every call a cache miss. The line depends only on two persisted entry fields: `createdAt`, and the timezone in `metadata.userTimezone` (`ENTRY_USER_TIMEZONE_KEY`). The engine reads the user's current timezone through `resolveUserTimezone` when it writes the entry and never rewrites it. So an earlier message renders the same bytes on every later call, on rehydrate, after a restart and after compaction. Only the new message adds tokens after the cache marker. The live turn and `entriesToAgentMessages` share one render function (`userContentBlocks`). A change of timezone affects only messages sent after it. An entry written before this line existed has no stored timezone and shows UTC only. A team or org session has no single user timezone and also shows UTC only.

The compaction summarizer input carries the same line on each user entry that has text, so a summary can keep when each request was made. An entry with no text gets no line, so it still adds nothing to the coverage check.

## Implementation boundaries

API prompt fragments own supervisor and coding guidance. Generic tool descriptions must agree with these fragments.
The portable engine owns runtime model context. It needs no API imports, provider lookup, migration, or new public endpoint.
Existing model switching and role application remain authoritative.

## Validation

Prompt tests cover the supervisor/child distinction and remove blanket escalation requirements.
Engine tests inspect outbound provider context for initial assignment, same-turn switches, rejection, next-turn reset, role overrides, and restore.
Tests also check that context is not duplicated or persisted and that an unchanged model keeps identical context.
Concurrent user pin changes must not relabel an active turn.
`model-context.test.ts` checks the `[sent: …]` line on a turn three days into a thread, the timezone current at each message, UTC only when the timezone is not known, and a serialized Anthropic history prefix that stays byte-identical after a restart.
Run the affected suites, typecheck, and the complete `make e2e` scorecard.
