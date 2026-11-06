# Shared task progress

## Goal

Show the same task progress in the web app and channel conversations. Keep one compact progress surface per turn. Keep the Slack interruption fix in its existing PR.

## Decisions

1. Derive progress from durable engine queue items, message tool parts, decision gates, and the existing thread plan. The engine owns these facts. A renderer cannot change task state.
2. Give plan steps stable IDs. Preserve IDs for unchanged steps across updates and reordering. Scope plans and progress to a queue item. Keep a bounded history of turn plans in thread metadata.
3. A shared snapshot has a turn ID, title, revision, update time, status, bounded tasks, and an omitted-task count. Task fields are ID, title, status, and optional public details, output, and sources. Status is pending, in_progress, waiting, complete, error, or interrupted.
4. An interrupted turn stays interrupted. A completed turn does not mark unfinished plan steps complete. Pending approvals and questions show waiting. Raw tool arguments, output, and model reasoning do not enter progress summaries.
5. The web app reads an authorized progress endpoint. Live events invalidate its snapshot. Reuse the existing plan surface and primitives. Collapse steps by default and fit phone width.
6. A channel transport can publish a progress snapshot. The host stores a durable delivery intent, native message reference, and last revision. Serialize updates per turn, coalesce bursts, bound recovery pages, and isolate organizations and destinations.
7. The revision covers only displayed fields: title, status, visible tasks, omitted count, and the plan flag. A timestamp or a hidden task alone does not change it. The publisher updates a card only when the revision changes, and at most once every 3 seconds per card. Slack asks for that rate, and approval cards share the chat.update limit. A failed update also waits 3 seconds before its retry.
8. A turn that settles before its first post gets no card. Its answer is already in the thread. A card posted earlier still gets its final update.
9. Create an intent before posting. Recover an uncertain creation by finding its existing native message. Do not create another card when the provider outcome is uncertain. Known message references are updated in place.
10. Slack renders native plan and task_card blocks through chat.postMessage and chat.update. This supports long turns without the ten-minute stream limit. Keep Slack block JSON and provider limits in the plugin. A task_card has only three states: in_progress, complete, and error. While a turn runs, the card shows started steps, and a context line counts the pending steps ("2 more steps planned."). After a successful turn, it omits unfinished steps and counts them ("2 more steps not done in this turn."). After a failed or interrupted turn, unfinished steps show as error with "Not completed in this turn."
11. Limit the first view to meaningful plan steps or safe tool labels. Show an omitted count for longer runs. Keep approvals and questions on their existing interactive cards.
12. Count plan steps when a plan exists. Do not count the tools used to complete those steps again. Keep unfinished steps distinct from completed steps after a turn stops.
13. Publish channel progress only for a turn that can reply to that destination. A manual or overheard signal does not authorize a progress message. A successful reply to the origin can authorize progress for that turn.
14. Retry a rejected creation only when the provider confirms that no message was created. Keep network failures and unknown outcomes in recovery mode. Hash internal delivery keys before sending them to a provider.
15. A snapshot lists the turn's tool call IDs (`callIds`), oldest first, at most 50, for a planned turn too. The list holds IDs only, so decision 4 still holds. The revision does not cover it, so a channel card does not change for a new call.
16. The web card shows the turn's calls as steps. It joins `callIds` to the tool parts that the thread's loaded messages already hold, and renders each with the message stream's step view: the service icon, a past-tense title, and the full tool card when the step opens. A run of alike calls folds into one step ("Read 4 memory files"). Steps start collapsed. A call that the messages do not hold keeps its engine task row. A planned turn shows its plan steps first and its calls under them, so the card shows the work on every model, whether or not the model calls `update_plan`.
17. A plugin action can name its own step. `PluginAction.label(args)` returns one past-tense line with the key inputs ("Searched Slack for “deploy”"). The catalog calls it only after a successful call and drops a label that throws. The label rides `details.label` on the persisted tool result; the model never reads it. Without a label, a step uses the agent's one-line purpose, then the service and action names.
18. A pending, running, or waiting web card carries the live status and elapsed time. Keep only its screen-reader announcement outside the card. Show the separate working row when no active card is visible, including a progress load error or a new turn after a finished card. Test this through the session view so its card and status wiring cannot drift.

## Implementation plan

- Engine and shared types: stable plan IDs and turn history; pure progress projection and store readers; tests for gates, interruption, failure, privacy, plan retention, and bounded tasks.
- Channel publisher: durable delivery ledger, coalesced event subscription, restart recovery, and host lifecycle; tests for retries, stale events, organization isolation, and uncertain creation.
- Slack adapter: native blocks, create/update/reconcile operations, plain accessibility text, mention safety, and fake-API tests.
- Web and API: authorized endpoint, query and event invalidation, compact progress component, phone layout, and API/component tests.
- Integrate, run root and web typechecks and relevant suites with at most three workers. Review independently. Check desktop and phone locally. Open a draft PR with validation.

## Shared contract

`TurnProgress` has `turnId`, `title`, `status`, `revision` (string), `updatedAt`, `tasks`, `omittedTasks` (number), and optional `callIds` (string array). `ProgressTask` has `id`, `title`, `status`, optional `details`, `output`, and `sources` (URL and title).

The engine exports `readTurnProgress(store, sessionId, threadId, turnId)` and `readLatestTurnProgress(store, sessionId, threadId)`. Both return a snapshot or null.

`ChannelTransport.publishProgress(conversationKey, progress, options)` returns `{ messageId }` or null. Options contain `threadTs`, `idempotencyKey`, optional `messageId`, and optional `recoverOnly`. Null means a recovery lookup found no message. Recovery never creates a new message.

## Validation

- The engine suite covers progress projection, plan history, interruption, gates, privacy, and browser imports.
- Publisher tests cover organization isolation, leases, retry limits, restart recovery, and uncertain creation. A host test uses a transport other than Slack.
- Slack tests use a fake API. No live messages are sent for validation.
- Local checks use two accounts. An unshared thread rejects a second account. A shared link receives progress changes and interruption through its event stream. Desktop and 375-pixel layouts have screenshots.

## Limits

The provider has no conditional message-update API. A database lease cannot cancel a remote request that has already started. An uncertain creation can stop after the bounded recovery attempts rather than create a duplicate. Progress reports execution state; it does not undo external actions.

## Sources

- https://docs.slack.dev/reference/block-kit/blocks/task-card-block/
- https://docs.slack.dev/reference/block-kit/blocks/plan-block/
- https://docs.slack.dev/reference/methods/chat.startStream/
- https://docs.slack.dev/reference/methods/chat.postMessage/
