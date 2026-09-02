# Provider failover on transient errors (TKAI-326)

Date: 2026-09-02
Status: shipped (first slice)

## Problem

When a provider returns a transient error (for example Anthropic's
`overloaded_error`), the turn-level retry (TKAI-319) retries the same model
twice and then fails the turn. An org with a second provider key loses the
turn anyway. Valet had no equivalent-model failover.

## Behavior

The transient turn retry in `Thread.retryTransientTurnError`
(`packages/engine/src/thread.ts`) now runs in two phases:

1. Attempt 1 retries the same model after the first backoff (10s default).
2. Attempt 2 and later switch the turn to an equivalent model on another
   provider, when the host supplies one. The engine emits a `turn_failover`
   event and skips the backoff — the alternate provider is not the one
   melting down. When no candidate is usable, the retry stays on the same
   model, as before.

The switch is per-turn only. `runItem` restores the baseline model and
clears the per-turn key in its `finally` block, and the next turn
re-resolves the persisted spec. Sticky failover would change the user's
model choice behind their back.

Failover only runs where the retry runs: unattended sessions
(orchestrator, workflow, child) or sessions with an explicit `turnRetry`
config. It only fires on errors `isRetryableAssistantError` classifies as
transient — quota, billing, and auth failures never fail over.

## Engine seam

`CreateSessionOptions` gains two fields (`packages/engine/src/types.ts`):

- `resolveFailoverModels?: (spec: string) => Promise<string[]>` — host
  policy. Returns ordered equivalent-model specs for the turn's effective
  spec. Absent means no failover. This replaces the dead `modelFailover`
  field (declared in TKAI-319 groundwork, never read).
- `allowProviderFailover?: boolean` — per-session opt-out (default true)
  for orgs that must never run on another provider (data residency, cost
  control).

Each candidate resolves through the existing `resolveModel` seam at switch
time. A candidate that fails to resolve (revoked key, disabled provider,
unknown spec) is skipped, never fatal. A failed candidate lookup emits
`failover_lookup_failed` and degrades to the same-model retry.

## API policy (`packages/api/src/services/model-failover.ts`)

Equivalence = same capability tier. Tiers are S/M/L, classified from the
model id's family name (haiku/mini/nano/lite → S, opus/pro/o1 → L,
sonnet/flash/gpt/gemini → M), then an output-price band for unknown ids,
then M. This is a static policy map (TKAI-326 decision 4), not
configuration.

Candidate order derives from existing config (decision 2 — no new schema):

1. Org model preferences (`orgs.model_preferences`), most-preferred first:
   entries on another provider, same tier, active in the org catalog.
2. Static per-kind defaults (`TIER_DEFAULTS`), known kinds in fixed order
   (anthropic, openai, google), filtered against the live catalog.

One candidate per provider; at most 3. The catalog's `active` flag already
encodes "enabled row + usable key", so credential checks never duplicate.
The L defaults avoid the ultra-priced "pro" reasoning models — a failover
turn must not become a cost spike.

`EngineHost` wires the seam per session build (`makeResolveFailoverModels`,
`packages/api/src/engine/host.ts`). `VALET_DISABLE_PROVIDER_FAILOVER=1` is
the deploy-level kill switch (`EngineHostOptions.disableProviderFailover`).

## Event and UI

New `EngineEvent`/wire event `turn_failover` `{threadId, fromModel,
toModel, reason}`. The web client stores it per thread
(`failoverByThread`, `packages/web/src/stores/stream.ts`) and renders a
neutral info strip under the transcript — not an error banner, and no
thread-status flip: the turn is recovering, not failing. The notice
survives the recovered turn's streaming and clears on the user's next
prompt, which runs on the original model again.

## Deferred (multi-sprint scope from TKAI-326)

- Per-user/team/org S/M/L/XL tier preference tables and a settings UI. The
  static tier map and org preference order stand in until then.
- Per-org failover budget caps. Bounded today by the retry budget itself:
  at most one failover turn per transient event (default `maxAttempts` 2).
- A per-org compliance opt-out surfaced in settings. The engine option and
  the deploy kill switch exist; no per-org toggle yet.

## Validation

- `pnpm --filter @valet/engine test transient-turn-retry` — failover
  switch, per-turn restore, opt-out, unusable-candidate skip.
- `pnpm --filter @valet/api test model-failover` — tier classifier and
  candidate walk (env keys stubbed; ambient keys change catalog activity).
- `pnpm --filter @valet/api test bridge` — wire mapping.
