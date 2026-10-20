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

The product driver also does these things for each case:

- It saves the run's model as the person's default model before the
  assistant session exists, so `--model` reaches the assistant. Before
  2026-10-20 every product case ran on the host fallback tier `s`, and
  `--model` changed only the trajectory label.
- It answers each decision card, because nobody watches an eval run. An
  `ask_question` card gets a fixed typed answer that leaves the choice to
  the agent. Every other card (`allow_permissions`, a policy approval)
  gets its declining action, such as "Not now" or "Deny". The answers go
  into `metadata.decisions`.
- It seeds placeholder connections for the action services a case lists
  in `connected:` (`@valet/api/eval-connections`). The catalog then shows
  their action schemas, as it does for a person who connected them. A
  call that reaches the real service fails on authentication. A
  placeholder cannot list the actions of an MCP integration such as
  Linear, because the live server lists them. The driver refuses such a
  service.
- It records every saved workflow definition in
  `metadata.savedWorkflows`, for the `workflow_definition` check.

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

Eval model resolution uses the engine's common bundled catalog. Pi-ai 0.85.0
supplies `claude-fable-5-1` with upstream pricing. The supplemental catalog
supplies `gpt-6-astra` with the same metadata used by the API and workflows.
The old eval-only clone table is removed. Unknown models remain unresolved.

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
elision, not as a behavior mismatch. `workflow_definition` scores a
drafted workflow (see "The workflow-authoring suite").

A check result can carry `metrics`, measurements that it reports whether
it passes or fails. The scorecard prints them under the case row. A
multi-run entry keeps one set per run in `sampling.metricsPerRun`, and the
scorecard prints the count of runs for a boolean and the mean for a
number.

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

## The workflow-authoring suite

`evals/cases/workflows/` holds product-drive cases that ask the assistant
to build and save a workflow without running it. The suite measures the
`workflows` skill and the model defaults, so a change to either is
compared on the same briefs instead of judged from one trial. Like the
hard and long suites, the directory is outside the default `make eval`
load. Each case runs 3 times (`runs: 3`). Run one model per call:

```bash
make eval EVAL_ARGS="--cases evals/cases/workflows --model anthropic/claude-haiku-4-5"
make eval EVAL_ARGS="--cases evals/cases/workflows --model anthropic/claude-sonnet-4-6"
```

The `workflow_definition` check finds the definitions the agent sent to
`workflows.save_workflow` or `workflows.validate_definition` (the drafts).
The final definition is the last one the case saved, else the last draft.
Every definition must pass these rules:

- The save validator: `validateDefinitionInput` with the bundled plugin
  catalog (`@valet/api/eval-workflows`). The validator checks tool steps
  against the real action schemas. There is no org, so the org's
  approved-model list does not apply.
- Each stop step's outcome is `success` or `failure`.
- Each `foreach` step has one inline body object and `maxItems`.
- No agent step prompt tells its agent to get approval. This is the same
  heuristic that `preview_workflow` warns with.

A case adds rules with optional fields: `foreach` (a foreach step must
exist), `tool_steps`, `approved_actions` (in a tool step and in no agent
step's `toolScope`), `order` (steps occur in this order on one path),
`schedule_input` (every `trigger.data` read is under
`trigger.data.input`), `run_date` (a `trigger.timestamp` read and no
literal date), and `declared_inputs` (each `trigger.data` field has a
`dataSchema` entry). A selector with a dot is an action id glob for tool
steps and foreach tool bodies. A selector without a dot is a step type.

Only the final definition decides pass or fail. The check reports repair
effort and initial correctness apart, as metrics: `drafts`, `rejections`
(validator rejections across save, validate, and patch calls),
`first_valid`, `first_correct` (the first full draft passes the validator
and every rule), and `final_valid`. Two kinds of call are not scored as
first drafts:

- A call to a tool that does not exist. A model can write
  `workflows__validate_definition` after the pinned
  `workflows__get_workflow`, and the agent loop answers "Tool ... not
  found" before any action runs. The call is not a draft and not a
  rejection. `unknown_tool_calls` counts it.
- A probe: a small draft that checks one detail, such as whether the
  validator accepts an action name. The first full draft is the first
  draft with at least half as many steps as the final definition.
  `probes` counts the smaller drafts before it.

The cases:

- `workflow-sales-tracker`: one email updates one existing lead in a
  Google Sheet after a person approves the change, then the workflow
  reads the row back. The sheet write is medium risk, which policy allows
  without asking, so the case requires an approval step before a tool
  step that writes, and a tool step that reads after it.
- `workflow-scheduled-refresh`: a weekday schedule refreshes a JSON file
  in a GitHub repository. The case requires schedule input reads at
  `trigger.data.input` and the run date from `trigger.timestamp`.
- `workflow-onboarding-linear`: a Linear project, its milestones, and a
  role-dependent number of issues. The case requires a foreach step and
  declared inputs. Linear is an MCP integration, so a scratch stack lists
  no Linear actions, and the case does not require Linear tool steps.
- `workflow-bot-alert-triage`: bot messages in two Slack channels start
  the workflow, and a high alert opens a GitHub issue in a tool step.

Results from 2026-10-20, 3 runs per case. The skill text is the one
before PR #993. The s tier is `anthropic/claude-haiku-4-5` and the m tier
is `anthropic/claude-sonnet-4-6`, the built-in tier defaults.

| Case | Tier | Final correct | First draft correct | Rejections per run | Cost per run |
|---|---|---|---|---|---|
| sales-tracker | s | 3/3 | 0/3 | 1.0 | $0.11 |
| sales-tracker | m | 3/3 | 0/3 | 1.7 | $0.49 |
| scheduled-refresh | s | 0/3 | 0/3 | 1.3 | $0.08 |
| scheduled-refresh | m | 3/3 | 0/3 | 1.0 | $0.64 |
| onboarding-linear | s | 0/3 | 0/3 | 1.0 | $0.08 |
| onboarding-linear | m | 0/3 | 0/3 | 1.0 | $0.39 |
| bot-alert-triage | s | 3/3 | 0/3 | 1.3 | $0.10 |
| bot-alert-triage | m | 3/3 | 0/3 | 1.3 | $0.55 |
| all | s | 6/12 | 0/12 | 1.2 | $0.09 |
| all | m | 9/12 | 0/12 | 1.2 | $0.52 |

- No first draft on either tier was correct. Every first draft gave a
  stop step the outcome `completed`, the value in the skill's own stop
  example. Other repeated first-draft errors: an `if` step with
  `condition` instead of `conditions`, a `session` step with a wrong
  `mode`, and a foreach body that is not one inline object. Each run then
  needed one or two validator rejections before a save.
- The tiers separate on one case. In every s-tier run of
  `workflow-scheduled-refresh`, the workflow read the schedule input at
  `trigger.data.<field>`, which renders null at run time. The m tier read
  `trigger.data.input.<field>`.
- Neither tier set `maxItems` on the onboarding foreach steps.
- An m-tier run cost about 5.7 times as much as an s-tier run.
- In the first m-tier batch, 3 runs ended before any save because the
  model's HTTP stream closed (error `terminated`). Both tiers ran at the
  same time. The table uses a second batch of the two affected cases, run
  alone. Read a `terminated` error as a transport failure, not as model
  behavior.

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
- The workflow-authoring cases do not check the schedule's cron or the
  event trigger's filters. A workflow can pass with a wrong schedule.
