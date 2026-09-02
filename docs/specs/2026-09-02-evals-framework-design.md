# Evals framework: engine wrapper with trajectory scoring

Status: Implemented (TKAI-213; sub-issues TKAI-328 through TKAI-336, TKAI-334).
Owner: `packages/eval` (`@valet/eval`).

## What this is

An eval framework that wraps `@valet/engine` in-process. It sends case
prompts through real LLM calls, captures the agent's trajectory from the
persisted engine entries, scores the trajectory with deterministic checks
and LLM-as-judge checks, and prints a scorecard with baseline comparison.

Run it with `make eval` (loads `.env`, requires `ANTHROPIC_API_KEY`):

```bash
make eval                                     # full starter suite
make eval EVAL_ARGS="--filter memory"         # subset by case id
make eval EVAL_ARGS="--save-baseline"         # record baselines
make eval EVAL_ARGS="--model anthropic/claude-sonnet-5"
make eval EVAL_ARGS="--json"                  # machine-readable output
make eval EVAL_ARGS="--pull-flagged"          # harvest 👍-rated sessions
```

## Architecture decision

The driver wraps the engine directly: in-memory providers
(`InMemorySessionStore`, `InMemoryEventStream`, `InMemoryCredentialStore`,
`InMemoryBlobStore`, `VirtualSandboxProvider`), one fresh `Engine` per
case, no API server, no HTTP, no Docker (except `profile: full`).

An earlier draft (`2026-08-24` evals-harness notes, discussed on TKAI-213)
argued for driving the product through its public HTTP/WS routes instead.
TKAI-213 settled on the in-process wrapper: the framework measures AGENT
behavior (tool selection, sequencing, output quality, token spend), and the
engine is the layer that owns that behavior. Product-surface coverage stays
with `make e2e`. If a scorecard ever needs to certify the product surface,
add a drive-through-the-API mode; do not bend this one.

## The case format

YAML files in `evals/cases/`, one case per file, loaded and validated by
`packages/eval/src/case-loader.ts`. Fields: `id`, `description`, `turns`
(array of `{role: user, content}`; single-prompt cases use one element),
`model`, `timeout_ms`, `tools` (restrict the toolset), `session_type`
(`default` | `orchestrator`), `profile`, `mock_tools`,
`required_credentials`, `checks`.

Later user turns may interpolate the previous agent output:
`{{last_output_match(/id: (\w+)/)}}` resolves to the first capture group.

### Profiles

- `unit` (default): built-in tools + Map-backed `mem_*` stand-ins, virtual
  sandbox. Free of external dependencies.
- `mock`: adds `[list_tools, call_tool]` backed by REAL plugin manifests
  (`@valet/api/plugins`) with canned responses from `mock_tools`. Tests
  reasoning about integrations with no credentials or network.
- `integration`: real plugin actions restricted to riskLevel `low` (the
  read-only subset), credentials seeded from `.env.eval`. Cases declare
  `required_credentials`; missing ones SKIP with the env var named.
- `full`: every plugin action plus a Docker sandbox with a scratch host
  workspace. SKIPs when Docker is down. Point `full` credentials at
  throwaway resources — approvals are auto-allowed (runs are unattended).

`.env.eval` is the only credential source (process env as fallback). The
loader rejects known production variables (`DATABASE_URL`, ...) outright.

## Trajectory

`packages/eval/src/trajectory.ts` extracts a `Trajectory` from persisted
entries: prompt, model, turns (one per assistant entry, with usage/cost),
tool calls (name, args, result, status, order), final output, aggregate
usage/cost, duration, stop reason. Plugin-catalog calls also carry
`actionId` (from `call_tool`'s `tool_id` or a pinned tool's name), so
checks can name `github.list_pull_requests` regardless of invocation route.

Orchestrator cases (`session_type: orchestrator`) get a persona, `mem_*`
tools, and a `childSpawner`; each spawned child becomes a nested
`Trajectory` in `children[]`, linked by `spawnedByCallId`.

## Checks

Deterministic (`checks/deterministic.ts`, pure functions): `tool_called`
(count/min/max, optional `after` anchor), `tool_not_called`,
`tool_result_matches`, `tool_result_not_matches`, `tool_args_match` (JSON
subset), `output_contains`, `output_not_contains`, `all_terminal`,
`no_errors`, `max_turns`, `max_tokens`, `max_cost`, `max_duration`.

LLM-as-judge (`checks/judge.ts`): `judge_output`, `judge_trajectory`,
`judge_equivalence` (needs a baseline). The judge model defaults to a cheap
grading model, returns `{score, reason}` JSON, passes at score >= threshold
(default 4). Every judge failure mode becomes a FAIL result with the reason
in `detail`, never a crash.

## Scorecard and baselines

`scorecard.ts` prints PASS/FAIL/SKIP per case with duration, cost, and
checks passed, plus totals. `--save-baseline` writes
`evals/baselines/{case-id}/{model}_{date}.json`; a later run loads the most
recent baseline for the case and model (any-model fallback, noted) and
reports regressions, improvements, token/cost deltas, and tool-sequence
changes. `evals/baselines/` is tracked; `evals/results/` is ignored.

## Rating pipeline (TKAI-334)

Session-level 👍/👎 in the session header is the primary eval-seeding
signal; message-level 👍/👎 on assistant replies is finer-grained feedback.
Ratings live in the app `ratings` table (one row per user+target; null
clears). `make eval EVAL_ARGS="--pull-flagged"` reads rated sessions
straight from the database (DATABASE_URL, or the PGlite data dir — stop the
api first) and writes one trajectory file per session under
`evals/baselines/flagged/`.

## The hard suite (model comparison)

`evals/cases/hard/` holds cases tuned to separate model tiers. The loader
reads one directory and does not recurse, so the default `make eval` never
loads them and stays green on the cheap default model. The comparison demo
is a two-run pair:

```bash
make eval EVAL_ARGS="--cases evals/cases/hard --save-baseline"   # small model
make eval EVAL_ARGS="--cases evals/cases/hard --model anthropic/claude-sonnet-5"
```

The second run compares against the first run's baselines and prints
improvements (fail -> pass), regressions, and token/cost deltas, with the
baseline model named.

Empirical results from tuning (2026-09-02, haiku-4-5 vs sonnet-5):

- Calendar reasoning (`hard-date-math`) is the most reliable separator:
  haiku failed every attempt, sonnet passed every attempt.
- `hard-calendar-count` and `hard-string-pipeline` separate weakly (haiku
  fails or flakes, sonnet mostly passes).
- `hard-letter-index` is an INVERSE separator: haiku always passed, sonnet
  repeatedly miscounted vowels. Kept deliberately — it demonstrates the
  regression detector on a real behavior difference.
- Single-skill puzzles (multi-digit arithmetic, base conversion, ciphers,
  logic grids) do NOT separate these tiers: haiku passes them. They stay
  as headroom cases.
- Exact-counting cases were near coin-flips on BOTH tiers and were removed;
  a case both models fail (or pass) randomly carries no model signal.

Rules for adding hard cases: compute every expected value with a script
(never mental arithmetic — a wrong expected value makes a case impossible
and looks like a model failure), and re-run against both tiers before
trusting a new case. The hard suite is a comparison instrument, not a
gate: a red row on the small model is the point, so never wire it into CI
as a pass/fail check.

## Known limitations

- `mem_*` tools in eval sessions are Map-backed stand-ins: production
  `mem_*` calls the memory HTTP routes, which need a server. Names and the
  path surface match, storage semantics do not.
- `integration` approximates "read-only" as riskLevel `low`. An action
  mislabeled low that mutates would run; riskLevel is the field to fix.
- The Docker sandbox drives readiness with unref'd timers; the runner holds
  a keepalive handle per case so node cannot exit mid-provision.
- One suite run is sequential. Parallel case execution is possible (each
  case owns its engine) but unimplemented.
- CI wiring is a follow-up: stabilize the suite first, then add a workflow.
