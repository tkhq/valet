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
The resolved-label view follows merge chains and deduplicates multi tags.
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
An enqueue during classification survives acknowledgement of the older job version.
No exception payload or subject text is stored in jobs.

One prompt template serves every dimension.
Closed dimensions cannot create keys.
Invalid single output becomes `other`.
Invalid multi keys are dropped.
Rules bypass the provider and record confidence 1 with model `rule`.
New key creation schedules one bounded retry for up to 50 existing `other` subjects.
Each such subject is retried at most once.
The default registry limit is 100 non-merged keys.
At the limit, proposals stop and the registry reports consolidation due.

The host resolves the configured XS tier through the existing provider path.
No new API key is required.
Model usage enters the existing engine usage projection.
A batch's tokens and cost are divided among its user/team billing principals.
Archived accounting sessions use the `tagger:` prefix.
The same usage and scope queries include that spend.
Labels retain null actors for automated team calls.
Their accounting sessions reuse the existing team runtime principal because session rows require an identity.

## Usage UI

The Tool usage view shows a purpose chart and key definitions.
Provisional keys share an Emerging bar with a per-key drill-down.
The key filter applies to call counts, top tools, clients, and recent intents.
The purpose chart retains its full distribution while a key is selected.
Surface, period, and personal/team/org filters still apply.
Individual intents retain the existing team-admin visibility rule.
Registry edits and merges require the existing organization-settings admin permission.
No examples or classifier input text are exposed by the registry API.

## Validation limits

The targeted tests cover registry behavior, mocked classification, durable jobs, scope filters, and the UI.
The 12-intent golden set tests the integration contract, not live-model accuracy.
Local smoke calls use the actual HTTP, engine, telemetry, queue, and provider-resolution paths with deterministic completions.
Live-model accuracy and latency remain unmeasured without an accessible provider credential.
Desktop is visually checked at 1280 by 800.
Mobile remains unverified because the installed browser cannot resize.
