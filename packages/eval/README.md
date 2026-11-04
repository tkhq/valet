# @valet/eval

Trajectory-scoring evals for the Valet agent platform. The runner drives
eval cases through the real engine (or the real api, in product mode),
extracts what the agent did, and scores it. Design and rationale:
`docs/specs/2026-09-02-evals-framework-design.md`.

## Run the suite

```bash
make eval                                   # starter suite, default model
make eval EVAL_ARGS="--filter memory"       # cases whose id matches
make eval EVAL_ARGS="--cases evals/cases/hard --model anthropic/claude-sonnet-5"
```

Requirements: `ANTHROPIC_API_KEY` in `.env`. Full-profile cases need
Docker. OpenAI and OpenRouter models need their provider key in the
environment. Missing credentials SKIP the affected cases; they never fail
them.

## Flags

| Flag | Effect |
|---|---|
| `--filter <pattern>` | Run cases whose id matches (substring or regex). |
| `--model <spec>` | Default model (`provider/model`). A case's `model:` pin wins. |
| `--reasoning <level>` | Thinking effort for the suite: `minimal` to `max`. Moves pass rate and cost. |
| `--runs <n>` | pass@k samples per case (1 to 25). |
| `--save-baseline` | Record each trajectory as a baseline after the run. |
| `--allow-live-baselines` | Permit saving integration/full baselines (live API responses). |
| `--prune-baselines <n>` | Keep the newest n baselines per case and model, delete the rest. |
| `--json` | Machine-readable output. |
| `--verbose` | Print full trajectories. |
| `--timeout <ms>` | Override every case's timeout. |
| `--pull-flagged` | Harvest thumbs-rated sessions into the corpus instead of running. |
| `--cases <dir>` / `--baselines <dir>` | Directory overrides. |

Exit code 0 means every run case passed.

## Write a case

One YAML file per case in `evals/cases/`:

```yaml
id: my-case
turns:
  - role: user
    content: Do the thing and report the result.
timeout_ms: 120000
checks:
  - type: tool_called
    tool: mem_write
  - type: output_contains
    value: done
  - type: no_errors
```

Rules that keep cases trustworthy:

1. Compute every expected value with a script. Never use mental
   arithmetic: a wrong expected value makes the case impossible and looks
   like a model failure.
2. If the answer could be memorized from training data, write
   `variants:` so one memorized answer cannot pass the group.
3. If the case is stochastic, set `runs:` and let pass@k decide. The
   default threshold treats flaky as failing.
4. For builder cases, verify with `verify_command` (harness-run, hidden
   from the agent), and prefer running the produced code over grepping
   file contents.
5. Model-separation cases go in `evals/cases/hard/`, which the default
   run never loads. The hard suite is a comparison instrument, not a
   gate; never wire it into CI as pass/fail.
6. Multi-turn conversational-behavior cases go in `evals/cases/long/`
   (also outside the default run). Ground each one in a real session
   pattern and name the pattern in the case header comment. Run them
   with `make eval EVAL_ARGS="--cases evals/cases/long"`.
7. Workflow-authoring cases go in `evals/cases/workflows/` (also outside
   the default run). Each one asks the assistant to build and save a
   workflow without running it, and scores the result with
   `workflow_definition`. Run them with
   `make eval EVAL_ARGS="--cases evals/cases/workflows"`.

Check types: `tool_called`, `tool_not_called`, `tool_result_matches`,
`tool_result_not_matches`, `tool_args_match`, `output_contains`,
`output_not_contains`, `all_terminal`, `no_errors`, `max_turns`,
`max_tokens`, `min_compactions`, `max_cost`, `max_duration`,
`verify_command`, `workflow_definition`, `judge_output`,
`judge_trajectory`, `judge_equivalence`. Field details: `src/types.ts`.

Compaction recall cases live in `evals/cases/compaction/`. Each one sets
a small `context_budget_tokens`, so the thread compacts between turns.
Each case also checks `min_compactions`, so a run that never compacts
fails. Run them with
`make eval EVAL_ARGS="--cases evals/cases/compaction"`.

`drive: product` cases can list action services in `connected:`. The
harness gives each one a placeholder credential, so the assistant's
catalog shows its action schemas. The harness answers decision cards
itself: a typed answer for a question, the declining action for every
other card.

## Code-review benchmark

`evals/cases/code-review/` holds the 50 pull requests of Martian Code
Review Bench (MIT, github.com/withmartian/code-review-benchmark). Each
case checks out a PR and runs the `@valet/plugin-pr-review` reviewer on
it. The `review_match` check then scores the review with Martian's
method: extract issues, group duplicates, and match them to the golden
comments. After the cases, the scorecard prints precision, recall, F1
and F2 for the reviewer. It also prints the same numbers for the
reference tools (cubic, Qodo, Greptile, CodeRabbit and others), taken
from Martian's published results with the same judge and on the same PRs.

These cases run on a Valet key only, never on a personal provider key.
Every model call, judge calls included, goes through the Valet LLM
gateway:

```bash
VALET_LLM_GATEWAY_URL=https://valet.dev.agents.turnkey.engineering \
VALET_API_KEY_FILE=~/.valet/post-deploy.key \
pnpm --silent --filter @valet/eval start --cases evals/cases/code-review \
  --model anthropic/claude-sonnet-5-5 --concurrency 6
```

When the gateway is set, the CLI deletes `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `OPENAI_API_KEY` from its environment. If the
gateway is not set, the code-review cases SKIP.

- Repos are cached as blobless bare clones in `VALET_EVAL_REPO_CACHE`
  (default `~/.cache/valet-eval/repos`). The first run downloads about
  3.5 GB.
- The reviewer's `bash` runs on the local machine with no isolation. Run
  this suite only on repos you trust to read.
- To regenerate the cases, run `pnpm --filter @valet/eval import:martian`.
  It needs the `gh` CLI.
- A run measures the reviewer the plugin ships: one reviewer pass and no
  verifier. `--verify` checks each finding with a verifier agent, and
  `--review-passes <n>` merges n independent reviewer passes.
- One full run costs about $5 for the reviews on Sonnet 5.5, plus the
  judge calls. `--verify` roughly doubles the review cost.

## Compare models

```bash
make eval EVAL_ARGS="--cases evals/cases/hard --save-baseline"
make eval EVAL_ARGS="--cases evals/cases/hard --model openai/gpt-5.6-luna --reasoning high"
```

The second run prints a comparison against the saved baselines:
improvements, regressions, pass-rate movement, and token and cost deltas
with noise-band labels when pass@k statistics exist.

### Record a run in the model comparison snapshot

The Settings → Model comparison page shows each model's hard-suite pass
rate next to its public benchmark score and list price. The numbers come
from `packages/shared/src/model-benchmarks.json`, refreshed by PR:

```bash
pnpm --silent --filter @valet/eval start --cases evals/cases/hard \
  --model amazon-bedrock/deepseek.v3.2 --runs 3 --json > run.json
node scripts/evals/snapshot-benchmarks.mjs --family deepseek-v3.2 \
  --model amazon-bedrock/deepseek.v3.2 --suite evals/cases/hard < run.json
```

`--silent` matters: without it pnpm prints its `> @valet/eval start` banner
to stdout and the file is not JSON (`make eval` has the same problem).
The script writes the family's `valetEval` block (pass rate as passed
runs over all runs, mean cost per single run of a priced case, runs per
case, the date) and leaves every other field and the file's one-entry-
per-line layout alone. `--family` must already exist in the snapshot's
entries. The hard suite is a comparison instrument: record it here, never
wire it into CI as pass/fail.

## Tests

```bash
pnpm --filter @valet/eval test
```

Faux-provider tests cover the runner, checks, judge mechanics, sampling,
and catalogs without network. Live tests (judge calibration, product
drive) run only when `ANTHROPIC_API_KEY` is set.
