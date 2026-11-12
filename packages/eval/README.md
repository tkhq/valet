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
`judge_trajectory`, `judge_equivalence`, `citation_validity`. Field details: `src/types.ts`.

Citation cases live in `evals/cases/citations/`. Run them with
`make eval EVAL_ARGS="--cases evals/cases/citations --model <provider/model>"`.
`citation_validity` checks source existence and reports citation counts.
A `profile: mock` case can give a mocked tool `sources` (`service`, `title`, and optional `url`, `snippet`, `location`).
The engine numbers them `s1`, `s2`… in the tool result, as it does for a real tool:

```yaml
mock_tools:
  slack.read_history:
    response: '{"messages":[]}'
    sources:
      - service: slack
        title: Message in #launch
        url: https://acme.slack.com/archives/C1/p1
```

`multi-source-attribution.yaml` checks separate Slack and GitHub facts against their own sources. Its prompt and the Gmail prompt do not request citations.
These cases mock real static actions. They do not test live integrations. The integration profile excludes dynamic MCP actions, including Linear.
The case's judge checks whether each factual claim has supporting evidence.
Compare the same case across models before drawing conclusions about citation reliability.

Compaction recall cases live in `evals/cases/compaction/`. Each one sets
a small `context_budget_tokens`, so the thread compacts between turns.
Each case also checks `min_compactions`, so a run that never compacts
fails. `compaction-midturn-task.yaml` sets `context_window_tokens`
instead: the engine assumes that window for the model, so one long turn
compacts before a model call. Run them with
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
- `--min-confidence <x>` drops findings the reviewer rated below x. The
  scorecard then also scores the unfiltered draft as "valet (before
  verify)", so one run shows what the threshold cost.
- `--review-dedupe` runs the dedupe stage: one model call compares the
  findings that sit on one file within 20 lines of each other and keeps
  one finding of each defect. The trajectory lists each merged finding
  with its reason.

Two more suites use the same case shape and scoring:

- `evals/cases/turnkey-trial/` holds the 21 PRs of the Turnkey review
  trial in the private repos `tkhq/test-sdk`, `tkhq/test-go-sdk` and
  `tkhq/test-rust-sdk`. 12 PRs carry one planted defect (2 are visible
  only in another repo), 6 are clean controls, and 3 lay down fixtures.
  Each case declares `kind: planted`, `control` or `setup`. On a control
  or setup PR every issue is a false positive. The scorecard adds a TRIAL
  table: planted recall, control and setup false positives, and
  cross-repo recall. The `coderabbit` reference row is CodeRabbit's
  review from the trial, scored with the same judge. To run it, sign in
  `gh` with read access to the three repos. To regenerate the cases, run
  `pnpm --filter @valet/eval import:trial`.
- `evals/cases/swr-bench/` holds 80 PRs from SWR-Bench (Peking
  University, FSE 2026, MIT, github.com/ZZR0/SWRench): 60 PRs with a
  functional defect that a human reviewer raised and the author fixed,
  and 20 clean PRs as controls, from 12 Python projects. Only functional
  (F.*) defects count toward recall. All 12 projects are SWE-bench
  repos, so expect some training-data contamination. To regenerate the
  cases, run `pnpm --filter @valet/eval import:swr`.
- `--context-budget <tokens>` builds a context pack before each review:
  repository conventions, domain notes, definitions, callers, tests and
  team notes, from one scan of the checkout at HEAD. The trajectory
  metadata keeps the pack, its manifest and the consolidate drops. The
  plugin default is 12000. `0` or no flag runs without a pack.
- `--memory-dir <dir>` gives the pack a directory of memory files as
  team memory, mounted at `lib/` the way a content source syncs it, for
  example a source repo's `.valet/memory`. Notes under
  `lib/code-review/notes/` become review rules; other notes are
  background.

### Private suites

Suites whose cases name private production repositories or describe
their defects are not committed here. The Turnkey history suite (merged
production PRs at the commit a human reviewed) and its held-out set are
kept outside the repo.

1. Set `VALET_EVAL_PRIVATE_CASES` to the directory that holds the suite
   directories.
2. Run with `--cases private:<suite>`, for example
   `--cases private:turnkey-history`.

If the variable is unset or the suite is missing, the run prints SKIP and
exits 0. A case with `pull_request.private: true` SKIPs when `git
ls-remote` reports no read access, and fails on any other error. With
`pull_request.number` and no `body`, the runner reads the description
through `gh`; a failed read fails the case. A golden comment may carry
`fix`, the fix the human reviewer proposed, for a later fix-match scorer.

### Reviewer matrix

`src/review-matrix-cli.ts` lists every issue any reviewer raised on each
case and who raised it: the golden comments, one column per recorded
Valet run, and one per reference reviewer.

```bash
pnpm --silent --filter @valet/eval start --cases private:turnkey-history \
  --save-baseline --allow-live-baselines --baselines /tmp/tkh-valet
pnpm --filter @valet/eval exec tsx src/review-matrix-cli.ts \
  --cases private:turnkey-history --run valet=/tmp/tkh-valet --out /tmp/matrix.md
```

- Keep the baselines directory out of the repo: trajectories carry code.
- `--model` names the reviewer model whose saved baselines the matrix reads, for cases that name no model. `--judge-model` picks the model that matches issues across reviewers; it defaults to `DEFAULT_REVIEW_JUDGE_MODEL`.
- Reference reviewers with text and links come from
  `<cases>/reference/<case id>.json`. Reference tools with only `matched`
  and `fp` counts (Martian, the trial suite) mark golden rows and add a
  count of their other issues.
- Each row has a status: `human` (a golden comment), `acted` (the author
  changed the code under a reference comment), `corroborated` (two or
  more reviewers; Valet runs count as one), `unconfirmed`, or `noise` (a
  person marked the reference finding wrong).

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
