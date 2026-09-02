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
   provider, when the host supplies one. Every attempt still emits
   `turn_transient_retry` and waits its full backoff FIRST — the wait is
   the failing provider's recovery window, and it puts the
   abort/supersession check ahead of the switch, so an aborted item never
   broadcasts a switch that does not run. A successful switch then emits
   `turn_failover`. When no candidate is usable, the retry stays on the
   same model, as before.

Within one retry cycle: a second switch attributes the failure to the
candidate that actually produced it (the active spec updates on every
switch), and when the candidate list runs out the cycle restores the
original model for the remaining same-model retries — the primary may
have recovered during the backoffs. Candidate resolution failures and a
failed candidate lookup are logged to the host process (never a red
banner: the turn is still recovering) and degrade to the same-model
retry.

The switch is per-turn only. `runItem` restores the baseline model and
clears the per-turn state in its `finally` block, and the next turn
re-resolves the persisted spec. Sticky failover would change the user's
model choice behind their back. The failing spec is tracked as the turn's
ACTIVE spec (`turnActiveModelSpec`): a role's model frontmatter overrides
the streaming model without touching the layered resolution, and a bare
role id is canonicalized to `provider/id` — the engine resolves bare ids
across providers while the api's `parseModelId` reads bare as Anthropic.

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

Equivalence = same capability tier. Tiers are S/M/L, classified from
distinct family markers first (haiku/mini/nano/lite → S, opus/pro/o1 →
L), then the catalog's output price ("gpt" and "gemini" span three orders
of magnitude of price, so a broad vendor word must not pre-empt a known
price), then M. This is a static policy map (TKAI-326 decision 4), not
configuration. A test asserts every `TIER_DEFAULTS` id is
catalog-resolvable and classifies as its declared tier, so registry churn
fails a test instead of silently shrinking coverage.

Candidate order derives from existing config (decision 2 — no new schema):

1. Org model preferences (`orgs.model_preferences`), most-preferred first,
   matched via model-catalog's `preferenceIndex` (the single encoding of
   the bare-id-means-Anthropic rule): entries on another vendor, same
   tier, active in the org catalog.
2. Static per-kind defaults (`TIER_DEFAULTS`), known kinds
   (model-catalog's exported `KNOWN_KINDS`) in fixed order, filtered
   against the live catalog.

Exclusion is by upstream VENDOR, not provider row: a custom
openai_compatible proxy fronting OpenAI (inferred from the model family)
and an OpenRouter selection of an Anthropic model (vendor prefix of the
model id) both count as their upstream vendor, so a failover can never
land on the vendor that is melting down. One candidate per vendor; at
most 3. The catalog's `active` flag already encodes "enabled row + usable
key", so credential checks never duplicate. The L defaults avoid the
ultra-priced "pro" reasoning models — a failover turn must not become a
cost spike.

`EngineHost` wires the seam per session build (`makeResolveFailoverModels`,
`packages/api/src/engine/host.ts`). `VALET_DISABLE_PROVIDER_FAILOVER=1` is
the deploy-level kill switch (`EngineHostOptions.disableProviderFailover`).

## Event and UI

New `EngineEvent`/wire event `turn_failover` `{threadId, fromModel,
toModel, reason}`. The web client stores it per thread
(`failoverByThread`, `packages/web/src/stores/stream.ts`) and renders a
neutral info strip under the transcript — not an error banner, and no
thread-status flip: the turn is recovering, not failing. Lifecycle: the
notice survives the whole failover turn, including its tool rounds
(`turn_end` fires per LLM round, so it cannot drive retirement). The
failover item's `submission.settled` arms it; the next `message_start` (a
new turn streaming on the original model) or a later item's settle (a
next turn that died before streaming) retires it; a composer send clears
it immediately. The notice is live-only by design: a reload re-seeds from
REST history, which does not carry the event — the same contract as the
error banner.

Channel surfaces disclose the switch too: the channel stream bridge
appends a footer note to the streamed reply when its stream closes
(`packages/api/src/channels/stream-bridge.ts`), and the CLI `chat`/`send`
renderers print a `[failover]` line. Non-streaming channel transports get
no disclosure yet — a known gap.

## Deferred (multi-sprint scope from TKAI-326)

- Per-user/team/org S/M/L/XL tier preference tables and a settings UI. The
  static tier map and org preference order stand in until then.
- Per-org failover budget caps. Bounded today by the retry budget itself:
  at most one failover turn per transient event (default `maxAttempts` 2).
- A per-org compliance opt-out surfaced in settings. The engine option and
  the deploy kill switch exist; no per-org toggle yet.

## Validation

- `pnpm --filter @valet/engine test transient-turn-retry` — failover
  switch, per-turn restore, restore-on-exhaustion, second-switch
  attribution, role-override and bare-role-spec canonicalization, opt-out,
  unusable-candidate skip.
- `pnpm --filter @valet/api test model-failover` — tier classifier,
  candidate walk, vendor exclusion, and the `TIER_DEFAULTS`
  self-consistency check (env keys stubbed; ambient keys change catalog
  activity).
- `pnpm --filter @valet/api test bridge` — wire mapping.
