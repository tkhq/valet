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

Check types: `tool_called`, `tool_not_called`, `tool_result_matches`,
`tool_result_not_matches`, `tool_args_match`, `output_contains`,
`output_not_contains`, `all_terminal`, `no_errors`, `max_turns`,
`max_tokens`, `max_cost`, `max_duration`, `verify_command`,
`judge_output`, `judge_trajectory`, `judge_equivalence`. Field details:
`src/types.ts`.

## Compare models

```bash
make eval EVAL_ARGS="--cases evals/cases/hard --save-baseline"
make eval EVAL_ARGS="--cases evals/cases/hard --model openai/gpt-5.6-luna --reasoning high"
```

The second run prints a comparison against the saved baselines:
improvements, regressions, pass-rate movement, and token and cost deltas
with noise-band labels when pass@k statistics exist.

## Tests

```bash
pnpm --filter @valet/eval test
```

Faux-provider tests cover the runner, checks, judge mechanics, sampling,
and catalogs without network. Live tests (judge calibration, product
drive) run only when `ANTHROPIC_API_KEY` is set.
