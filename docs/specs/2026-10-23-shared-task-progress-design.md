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
7. Create an intent before posting. Recover an uncertain creation by finding its existing native message. Do not create another card when the provider outcome is uncertain. Known message references are updated in place.
8. Slack renders native plan and task_card blocks through chat.postMessage and chat.update. This supports long turns without the ten-minute stream limit. Keep Slack block JSON and provider limits in the plugin.
9. Limit the first view to meaningful plan steps or safe tool labels. Show an omitted count for longer runs. Keep approvals and questions on their existing interactive cards.
10. Count plan steps when a plan exists. Do not count the tools used to complete those steps again. Keep unfinished steps distinct from completed steps after a turn stops.
11. Publish channel progress only for a turn that can reply to that destination. A manual or overheard signal does not authorize a progress message. A successful reply to the origin can authorize progress for that turn.
12. Retry a rejected creation only when the provider confirms that no message was created. Keep network failures and unknown outcomes in recovery mode. Hash internal delivery keys before sending them to a provider.

## Implementation plan

- Engine and shared types: stable plan IDs and turn history; pure progress projection and store readers; tests for gates, interruption, failure, privacy, plan retention, and bounded tasks.
- Channel publisher: durable delivery ledger, coalesced event subscription, restart recovery, and host lifecycle; tests for retries, stale events, organization isolation, and uncertain creation.
- Slack adapter: native blocks, create/update/reconcile operations, plain accessibility text, mention safety, and fake-API tests.
- Web and API: authorized endpoint, query and event invalidation, compact progress component, phone layout, and API/component tests.
- Integrate, run root and web typechecks and relevant suites with at most three workers. Review independently. Check desktop and phone locally. Back up and deploy on the latest pilot build. Open a draft PR with validation.

## Shared contract

`TurnProgress` has `turnId`, `title`, `status`, `revision` (string), `updatedAt`, `tasks`, and `omittedTasks` (number). `ProgressTask` has `id`, `title`, `status`, optional `details`, `output`, and `sources` (URL and title).

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
