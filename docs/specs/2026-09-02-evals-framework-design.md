# Evals framework: engine wrapper with trajectory scoring

Status: Implemented (TKAI-213; sub-issues TKAI-328 through TKAI-336, plus TKAI-334 and TKAI-352).
Owner: `packages/eval` (`@valet/eval`). Developer quickstart: `packages/eval/README.md`.

## What this is

The eval framework wraps `@valet/engine` in-process. It sends case prompts
through real LLM calls, captures the agent's trajectory from the persisted
engine entries, scores the trajectory with deterministic checks and
LLM-as-judge checks, and prints a scorecard with baseline comparison.

Run it with `make eval`. The target loads `.env` and requires
`ANTHROPIC_API_KEY`:

```bash
make eval                                     # full starter suite
make eval EVAL_ARGS="--filter memory"         # subset by case id
make eval EVAL_ARGS="--save-baseline"         # record baselines
make eval EVAL_ARGS="--model anthropic/claude-sonnet-5"
make eval EVAL_ARGS="--reasoning high"        # reasoning effort for the suite
make eval EVAL_ARGS="--runs 3"                # pass@k sampling for the suite
make eval EVAL_ARGS="--json"                  # machine-readable output
make eval EVAL_ARGS="--pull-flagged"          # harvest thumbs-rated sessions
make eval EVAL_ARGS="--prune-baselines 3"     # keep 3 baselines per case+model
```

## Architecture decision

Two drive modes share one case format, one trajectory shape, and one check
vocabulary.

`drive: engine` is the default. The driver wraps the engine directly:
in-memory providers, one fresh `Engine` per case, eval stand-ins for
`mem_*`, no API server. It is fast and cheap, under lab conditions.

`drive: product` boots the real api in-process per case, on a fresh
scratch PGlite with no cross-case state. It ensures the real orchestrator
over `POST /api/orchestrator` and drives every turn over the public
message route. The agent runs with the production persona, the HTTP-backed
`mem_*` tools, the real plugin catalog and policy, and the real
ChildWatcher. Settlement and trajectory extraction read the engine store
the harness owns: drive through the front door, read through the back door
(the shape from the original TKAI-213 harness discussion). Product cases
require `session_type: orchestrator` and an API key, and SKIP without one.

Use `engine` for volume (deterministic checks, model comparison at scale).
Use `product` for fidelity (the trajectory a user's session would produce).
A production-behavior claim needs a product-drive case.

## The case format

Cases are YAML files in `evals/cases/`, one case per file, loaded and
validated by `packages/eval/src/case-loader.ts`. Core fields: `id`,
`description`, `turns` (array of `{role: user, content}`; single-prompt
cases use a one-element array), `model`, `timeout_ms`, `tools` (restrict
the toolset), `session_type` (`default` or `orchestrator`), `drive`,
`profile`, `mock_tools`, `required_credentials`, and `checks`.

Later user turns may interpolate the previous agent output:
`{{last_output_match(/id: (\w+)/)}}` resolves to the first capture group.

Sampling and rigor fields:

- `runs: N` samples the case N times (pass@k). `pass_threshold` sets the
  passing fraction; the default is 1, so a flaky case is a failing case.
- `temperature` pins sampling where the model allows it.
- `reasoning` sets thinking effort (`minimal` to `max`) for the model under
  test. The CLI's `--reasoning` overrides a whole suite. See "Reasoning
  effort" below.
- `allowed_actions` restricts the plugin catalog to named action ids from
  the inside. The `tools:` pin cannot see past `call_tool`; this can.
- `variants: [{suffix, ...overrides}]` expands a document into sibling
  cases and emits only the variants. This is the anti-contamination shape:
  a memorized single answer no longer passes the group.

Multi-run entries carry per-run token statistics. The baseline comparator
uses means when statistics exist, labels token deltas `[significant]` or
`[within noise]` against a 2-sigma band from the recorded per-run standard
deviation, and reports pass-rate movement. A single-run-to-single-run delta
stays unlabeled because there is no variance estimate to judge it against.

Judge checks majority-vote across 3 samples and report the median score.
The judge sees the full conversation alongside the rubric: user turns,
tool calls, and assistant replies grouped by submission (trajectories
recorded before the linkage existed fall back to a flat tool-call list).
This grouping is what makes turn-scoped rubrics ("did not fix during the
investigation turn") judgeable from evidence; before it, the judge
guessed turn attribution from global order and failed compliant runs. The implicit
default judge escalates to a stronger model rather than grade its own
model. A live calibration bank in the test suite pins the default judge's
verdicts on labeled good and bad outputs.

### Profiles

- `unit` (default): built-in tools plus Map-backed `mem_*` stand-ins, on a
  virtual sandbox. No external dependencies.
- `mock`: adds `[list_tools, call_tool]` backed by real plugin manifests
  (`@valet/api/plugins`) with canned responses from `mock_tools`. Tests
  reasoning about integrations with no credentials or network.
- `integration`: real plugin actions restricted to riskLevel `low` (the
  read-only subset), with credentials seeded from `.env.eval`. Cases
  declare `required_credentials`; a missing credential SKIPs the case and
  names the env var to set.
- `full`: every plugin action plus a Docker sandbox with a scratch host
  workspace. SKIPs when Docker is down. Point `full` credentials at
  throwaway resources; approvals are auto-allowed because runs are
  unattended.

`.env.eval` is the only credential source (process env as fallback). The
loader rejects known production variables (`DATABASE_URL` and similar)
outright.

## Reasoning effort (TKAI-352)

The engine forwards `CreateSessionOptions.sampling.reasoning` to pi-ai's
`StreamOptions.reasoning` on every turn, defaults-not-overrides, the same
rule as the retry and cache knobs in `Thread.buildAgent`. pi-ai maps the
level per provider: OpenAI `reasoning_effort`, Anthropic thinking budgets,
OpenRouter `reasoning.effort`.

Unset keeps provider defaults. For OpenAI reasoning models the default is
minimal effort, which produced the TKAI-352 finding: GPT-5.6 Terra scored
below Haiku on the hard suite because it answered in roughly 1,300-token
snaps with wrong arithmetic. At `--reasoning high`, Terra went 9/15 to
15/15 and Luna went 6/15 to 15/15 (for $0.039, the cheapest perfect suite
measured). Effort moves both pass rate and cost, so treat it as part of a
run's identity: the effective level is stamped into trajectory metadata.

Models absent from the static pi-ai catalog resolve through a small
extra-models table in `packages/eval/src/runner.ts` (first entry:
`claude-fable-5-1`, confirmed against the live `GET /v1/models`). Clones
carry a zeroed cost, which every surface renders as "unpriced". Do not
borrow a related model's price: a borrowed price is a wrong price.

## Trajectory

`packages/eval/src/trajectory.ts` extracts a `Trajectory` from persisted
entries: prompt, model, user turns (content per user input), turns (one
per assistant entry, with usage, cost, and the turn's assistant text),
tool calls (name, args, result, status, order), final output, aggregate
usage and cost, duration, and stop reason. Each turn AND each tool call
carries its `queueItemId`, which links it to the submission that produced
it.
Plugin-catalog calls also carry `actionId` (from `call_tool`'s `tool_id`
or a pinned tool's name), so a check can name
`github.list_pull_requests` regardless of invocation route.

Orchestrator cases get a persona, `mem_*` tools, and a `childSpawner`.
Each spawned child becomes a nested `Trajectory` in `children[]`, linked
by `spawnedByCallId`. `aggregateUsage` sums usage, cost, tool calls, and
turns recursively across children; the scorecard and the budget checks
report that recursive total, so spend delegated to children counts.

## Checks

Deterministic checks (`checks/deterministic.ts`) are pure functions:
`tool_called` (count, min, max, optional `after` anchor),
`tool_not_called`, `tool_result_matches`, `tool_result_not_matches`,
`tool_args_match` (JSON subset), `output_contains`, `output_not_contains`,
`all_terminal`, `no_errors`, `max_turns` (optional `per_submission`
scope), `max_tokens`, `max_cost`, `max_duration`, and `verify_command`
(builder cases, below). Compaction-elided tool results are reported as
elision, not as a behavior mismatch.

LLM-as-judge checks (`checks/judge.ts`): `judge_output`,
`judge_trajectory`, and `judge_equivalence` (needs a baseline). The judge
model defaults to a cheap grading model and returns `{score, reason}`
JSON; a check passes at score >= threshold (default 4). Every judge
failure mode becomes a FAIL result with the reason in `detail`, never a
crash.

## Builder cases (`verify_command`)

Builder cases have the agent write code and produce a codebase in a real
Docker sandbox (`profile: full`). Verification is harness-run: after the
agent settles and before sandbox teardown, the runner executes each
`verify_command` check in the same sandbox and scores the real exit code
and output (`expect_exit_code`, default 0; `expect_output` regex). The
command runs outside the agent loop against whatever files the agent
wrote, so the agent cannot pass by echoing expected output.

`verify_command` needs `profile: full` (the virtual sandbox only simulates
exec) and the engine drive (product-drive orchestrator sessions are
sandbox-less). The loader rejects both misuses. Write verification
commands against workspace-relative paths, and prefer running the produced
code (or its own test suite) over grepping file contents.

Starter builder cases: `builder-cli-script` (single file, three behavioral
probes including the error path), `builder-node-library` (multi-file
library whose own tests the harness runs via `node --test`), and
`builder-refactor` (two turns; the original and the steered behavior must
both survive on the final codebase).

## Scorecard and baselines

`scorecard.ts` prints PASS, FAIL, or SKIP per case with duration, cost,
and checks passed, plus totals. Skipped cases stay out of cost and token
totals. `--save-baseline` writes
`evals/baselines/{case-id}/{model}_{date}.json`. A later run loads the
most recent baseline for the case and model (any-model fallback, noted in
the comparison) and reports regressions, improvements, token and cost
deltas, and tool-sequence changes.

`evals/baselines/` is tracked; `evals/results/` is ignored. Two guards
protect the tracked directory: `--save-baseline` refuses integration and
full-profile trajectories (they carry live API responses verbatim) unless
`--allow-live-baselines` is passed, and `--prune-baselines N` keeps the
newest N records per case and model.

## Rating pipeline (TKAI-334)

Session-level thumbs in the session header are the primary eval-seeding
signal; message-level thumbs on assistant replies are finer-grained
feedback. Ratings live in the app `ratings` table, one row per user and
target; a null rating clears the row.

`make eval EVAL_ARGS="--pull-flagged"` reads rated sessions straight from
the database (`DATABASE_URL`, or the PGlite data dir; stop the api first)
and writes, per session: a raw export under `evals/baselines/flagged/`,
loader-compatible baseline records that `judge_equivalence` can consume
directly, and a runnable case scaffold (`.yaml.example`). Review a
scaffold for private context before moving it into `evals/cases/`.

## The hard suite (model comparison)

`evals/cases/hard/` holds cases tuned to separate model tiers. The loader
reads one directory and does not recurse, so the default `make eval` never
loads them and stays green on the cheap default model. The comparison
demo is a run pair:

```bash
make eval EVAL_ARGS="--cases evals/cases/hard --save-baseline"   # small model
make eval EVAL_ARGS="--cases evals/cases/hard --model anthropic/claude-sonnet-5"
```

The second run compares against the first run's baselines and prints
improvements (fail to pass), regressions, and token and cost deltas, with
the baseline model named.

Empirical results from tuning (2026-09-02):

- Calendar reasoning (`hard-date-math`) separates haiku-4-5 from sonnet-5
  reliably: haiku failed every attempt, sonnet passed every attempt.
- `hard-calendar-count` and `hard-string-pipeline` separate weakly.
- `hard-letter-index` is an inverse separator: haiku always passed, sonnet
  repeatedly miscounted vowels. Kept deliberately; it demonstrates the
  regression detector on a real behavior difference.
- Single-skill puzzles (multi-digit arithmetic, base conversion, ciphers,
  logic grids) do not separate these tiers. They stay as headroom cases.
- Exact-counting cases were near coin-flips on both tiers and were
  removed. A case both models pass or fail randomly carries no signal.
- `builder-expression-eval` separates on one-shot correctness (haiku's
  parsers reject a unary minus inside an exponent).
- `builder-zk-or-proof` (a CDS disjunctive Schnorr proof) separates on
  COST: with sandbox iteration both tiers eventually converge, so the case
  carries a `max_tokens: 100000` budget that fails brute-force
  convergence. Measured: haiku up to 594k tokens per run, sonnet about
  36k and cheaper in dollars despite a higher per-token price.
- Reasoning effort dominated the 11-run cross-vendor board: at
  `--reasoning high`, Luna, Terra, and Sol all scored 15/15, alongside
  Opus 5 and Fable 5.1 at defaults. OSS models via OpenRouter
  (DeepSeek v4 Pro 11/15, Kimi K3 9/15) ran at default effort; treat
  those numbers as floors.

Rules for adding hard cases: compute every expected value with a script,
never with mental arithmetic (a wrong expected value makes a case
impossible and looks like a model failure), and re-run against both tiers
before trusting a new case. The hard suite is a comparison instrument,
not a gate. A red row on the small model is the point, so never wire the
hard suite into CI as a pass/fail check.

## The long suite (realistic multi-turn trajectories)

`evals/cases/long/` holds long-trajectory cases. Each case scripts a
multi-turn conversation shape mined from real operator sessions. The
cases test conversational behavior over time, not puzzle skill. Like the
hard suite, the directory is outside the default `make eval` load; run it
with:

```bash
make eval EVAL_ARGS="--cases evals/cases/long"
```

Each case encodes one recurring session pattern:

- `long-build-steer-sweep`: a correction names one instance of a bug
  class and asks for the whole class. The harness probes every emit path
  on the final codebase, so a fix limited to the named spot fails.
- `long-triage-numbered-findings`: a numbered review lands mid-session
  with selective triage ("fix 1, 3, and 4; skip 2 and 5"). Probes check
  the requested fixes; a skipped-finding probe and a judge check catch
  scope inflation.
- `long-dictation-merge`: a voice-dictation resend of the same request
  with one changed detail and one addition. The last version is
  authoritative; the stale detail must be gone from the artifact.
- `long-park-resume`: the user parks a draft, asks an unrelated
  question, then resumes. The resume turn interpolates the agent's own
  interjection answer, so a wrong answer or a lost draft fails
  deterministic output checks.
- `long-scope-accretion`: a dashed "We should:" list arrives after the
  first version exists. One behavioral probe per list item catches
  dropped items.
- `long-debug-evidence`: a pasted failure transcript is the spec, with
  "investigate, don't fix yet". A judge check scores whether the agent
  held the fix until asked; probes score the fix and a regression guard.
- `long-field-report-fix`: a field report reshapes requirements after
  the build (decimal-comma numbers). Probes cover the new format, the
  old format, and a follow-up edge case.
- `long-memory-decisions`: an orchestrator session where decisions
  dictated early must survive interleaved work and come back assembled
  in the final write-up.

Rules for adding long cases: ground the shape in a real session pattern
(name it in the case header comment), keep every probe order-robust when
the turn wording allows more than one implementation order, and follow
the hard-suite rule of computing expected values with a script. Like the
hard suite, the long suite is an instrument, not a CI gate: a red row is
a behavior finding to read, and the baseline comparison is the signal
across models and versions.

Empirical results from tuning (2026-09-03, single runs):

- haiku-4-5: 7 of 8 passed. The one stable failure is
  `long-park-resume`: haiku replies "Done!" and describes the finalized
  announcement without including it (judge 1/5 in every run), and in one
  run also botched the parked arithmetic (4,608 for 512 * 9 - 100),
  which the interpolated turn carried into the final output where the
  deterministic check caught it.
- sonnet-5: 8 of 8 passed. The baseline comparator flags
  `long-park-resume` as the improvement, so the case separates the
  tiers on conversational behavior.
- Earlier tuning runs caught haiku editing the buggy fixture during the
  "don't change anything yet" investigation turn
  (`long-debug-evidence`), shipping a syntax error without running the
  code (`long-build-steer-sweep`), and skipping review findings
  silently (`long-triage-numbered-findings`). Those rows recur
  run-to-run; treat them as the behaviors under test, not noise.
- Docker exec can drop mid-run (`sandbox_unavailable`), which fails
  `no_errors` on full-profile cases. Observed only while other Docker
  work ran beside the suite. Re-run a lone `sandbox_unavailable` row
  before reading it as behavior.

## Known limitations

- `mem_*` tools in engine-drive sessions are Map-backed stand-ins;
  production `mem_*` calls the memory HTTP routes. Cases that must measure
  real memory behavior use `drive: product`.
- `integration` approximates "read-only" as riskLevel `low`. A mislabeled
  low-risk action that mutates would run; riskLevel is the field to fix.
- The Docker sandbox drives readiness with unref'd timers. The runner
  holds a keepalive handle per case so node cannot exit mid-provision.
- One suite run is sequential. Parallel case execution is possible (each
  case owns its engine) but unimplemented.
- Single-day, single-phrasing results: treat single-cell flips across runs
  as noise and the pass@3 cells and aggregate gaps as signal.
- CI wiring is a follow-up: stabilize the suite first, then add a
  workflow (with pass@k, never single-run rows).
