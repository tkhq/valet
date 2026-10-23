# Tagger library

Related: TKAI-656. PR2 stacks on the shared tool-intent contract.

`packages/api/src/tagging` classifies caller-rendered subjects.
It does not read telemetry or sessions in the generic classifier or worker.
Dimensions define single or multi mode, an open or closed registry, seeds, instructions, and optional deterministic rules.
Every dimension includes `other`.
The initial dimension is `tool_intent`.

## Persistence and execution

Registries are isolated by organization and dimension in `tag_keys`.
Labels live in `tag_labels`, not in `external_calls`.
A partial unique index enforces single-mode assignments.
Merges retain the original label rows.
Usage resolves a small registry map once per request instead of recursively scanning labels.
The generic resolved-label view remains available for multi-label library aggregates.
Classifier keys start provisional and activate at five assignments or two distinct users.

The caller registers a renderer for each subject type.
Renderers supply capped text and billing ownership.
The library enforces a conservative 1,024-byte text cap.
The input hash covers capped text and deterministic-rule metadata.
`tag_subjects` caches unchanged inputs, including empty multi-label results.

Telemetry writes enqueue durable subject references in `tag_jobs`.
The existing event dispatcher drains at most four organization/dimension pairs per tick.
Each pair handles at most 50 subjects per run.
A database lease serializes classification across API replicas.
Expired workers cannot publish labels.
Provider failures retry with exponential delay, up to five attempts.
The fifth failure deletes the job and increments `valet.tagging.dead_letters`.
Enqueue skips organizations without a tagging model, using a cached provider-resolution check.
Drains select the four oldest due organization/dimension pairs without an active lease.
An enqueue during classification survives acknowledgement of the older job version.
No exception payload or subject text is stored in jobs.

One prompt template serves every dimension.
Batches contain one owner principal: one team or one personal user.
New keys require at least two distinct proposing users and no personal subjects.
Labels are capped at 60 characters and definitions at 200.
Key examples store subject references, never intent text.
Retention nulls intent after 90 days but keeps key labels.
Forced re-tagging skips empty text without deleting existing labels.
Closed dimensions cannot create keys.
Malformed or truncated output retries without caching its input hash.
Valid unknown keys become `other`.
Invalid individual predictions do not discard valid neighbors.
Invalid multi keys are dropped.
Rules bypass the provider and record confidence 1 with model `rule`.
New key creation schedules durable retries for existing `other` subjects in batches of 50.
Each such subject is retried at most once.
The default registry limit is 100 non-merged keys.
At the limit, proposals stop and the registry reports consolidation due.

The host resolves the configured XS tier through the existing provider path.
No new API key is required.
Model usage enters the existing token/cost accounting rail as the separate `tagging` use case.
Internal accounting facts contain no request or response text.
A batch's tokens and cost are divided among its user/team billing principals.
No placeholder agent sessions are inserted.
The same usage and scope queries include that spend.
Labels retain null actors for automated team calls.
Spend keeps the same nullable user and team ownership.

## Usage UI

The Tool usage view shows a purpose chart and key definitions.
Provisional keys share an Emerging bar.
Only organization admins can read provisional or merged labels and definitions.
Unlabeled calls have a separate bar.
Top tools group by tool name and surface, not by purpose key.
Purpose error rates use only completed `ok` and `error` calls as their denominator.
The blank CLI `status` rule maps to `other`.
The key filter applies to call counts, top tools, clients, and recent intents.
The purpose chart retains its full distribution while a key is selected.
Surface, period, and personal/team/org filters still apply.
Individual intents retain the existing team-admin visibility rule.
Registry edits and merges require the existing organization-settings admin permission.
The merge editor uses the shared Select primitive.
No examples or classifier input text are exposed by the registry API.

## Validation limits

The targeted tests cover registry behavior, mocked classification, durable jobs, scope filters, and the UI.
The 12-intent golden set tests the integration contract, not live-model accuracy.
Local smoke calls use the actual HTTP, engine, telemetry, queue, and provider-resolution paths with deterministic completions.
Live-model accuracy and latency remain unmeasured without an accessible provider credential.
Desktop is visually checked at 1280 by 800.
Mobile remains unverified because the installed browser cannot resize.
