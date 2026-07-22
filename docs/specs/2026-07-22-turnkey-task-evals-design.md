# Turnkey Task Evals & Multi-Model Sessions — Design

**Status: draft for alignment. Scoped to the v2 engine, and deliberately below
feature work in priority.**

## Problem

Every v2 session can run on a different model, and sessions can nest, but today
one default frontier model runs everything, chosen by habit rather than by
evidence. The plumbing for something better already exists in
`packages/engine`: a session carries its own model (`options.model`, switchable
with `Session.setModel`), a thread can override it (`Thread.setModel` writes a
per-thread `modelOverride`), and child sessions link to their parent through
`parentSessionId`, with the spawning `task` tool accepting a model per child.

The frontier reshuffles every few weeks without producing a durable winner, so
committing everything to whichever model currently leads is both expensive and
unstable. We have also seen a compelling pattern emerge outside Valet: planning
with one model and executing with a cheaper, faster one in the same terminal.
Valet's engine could express that natively, but we have no data of our own
saying which model should run which Valet work, or what a task costs on each.

Public leaderboards do not answer that question. Benchmarks like
[DeepSWE](https://deepswe.datacurve.ai/) have the right shape, measuring agents
on original long-horizon tasks instead of single-turn puzzles, but they measure
generic software engineering rather than Valet's workload, and they say nothing
about dollars per completed task, which is the number an org admin actually
needs.

## Goal

The strategy is to own the measurement and consume the moment-to-moment
routing. Concretely:

1. A "Turnkey Tasks" eval suite of original, replayable tasks drawn from
   Valet's real workload families, run end-to-end through the v2 engine.
2. Per-candidate scorecards covering quality, cost, and latency per task
   family. A candidate is a model *placement*, planner/executor/reviewer, with
   a single model as the degenerate case, so the suite can compare
   plan-with-A-execute-with-B against B-does-everything directly.
3. The engine mechanics to get there: an eval runner that is itself a v2
   session, spawning candidate runs and the judge as child sessions, so eval
   orchestration exercises the same nesting it exists to measure.
4. Role-to-model placement as product configuration, defaulted from what the
   tuple runs actually show.

## Non-goals

Building a general-purpose model router. Choosing a model per prompt within a
vetted set is becoming a commodity; teams are building these internally and
hosted routers exist. Our evals produce what a router needs as input, a
candidate set with priors per task family, and consuming one (or shipping a
static mapping derived from the scorecards) is enough. The differentiated
asset is the eval data.

Chasing every model release. The suite answers "which of our limited set
should do this class of work," and re-runs when the set changes or the judge
is re-pinned, on the order of monthly rather than weekly. There is no public
leaderboard ambition here.

The v1 engine. The composability this leans on is v2's.

## Approach

### 1. The task corpus

Tasks are original and Valet-shaped, in the DeepSWE spirit but drawn from our
own product surface. Initial families, with an honest split between what is
machine-checkable today and what has to be built:

| Family | Task shape | Outcome check |
| --- | --- | --- |
| workflow-author | prompt, copilot builds a workflow | checkable today: publishes cleanly (existing publish validation); run effects need the eval environment below |
| code-review | PR with seeded defects, agent reviews | built new: seeded-defect fixtures plus a findings-vs-seed-list checker |
| incident-triage | Slack thread and logs fixture, agent diagnoses | judge-scored against a structured expected answer (faulting component, known fix) |
| doc-edit | source doc and edit instruction | built new: structural diff against the expected result |
| orchestrate | goal requiring plan, delegate, verify | built new: sub-task completion plus a final-state check; this family is where placement tuples matter most |

Tasks come from sanitized real sessions and from hand-authoring, never from
public benchmarks, so scores cannot be inflated by training contamination.
Each task runs K times per candidate (K=3 to start) because agentic runs are
nondeterministic and single trials cannot support comparisons.

### 2. Fixtures and tool isolation

Replayability is the hard engineering in this project, not an implementation
detail. A sanitized session that once hit GitHub, Slack, and a live sandbox is
only replayable if every external call is handled deliberately. The strategy
per family: workflow-author and orchestrate run against seeded state in a
dedicated eval environment (the same seeding recipe the test environment
uses); code-review runs against fixture repositories created for the purpose;
incident-triage and doc-edit use recorded tool responses, replayed by the tool
bridge. Which calls run live and which replay is declared per task in the
fixture, and building the record/replay layer is costed into Phase 1 rather
than assumed away.

### 3. The harness

An eval run takes one task and a candidate list, where each candidate is a
placement tuple (planner model, executor model, reviewer model; a solo model
fills all three slots). The runner is a v2 session. For each candidate it
spawns an isolated child session against the task's fixture with the
placement applied, drives the prompt, and waits for settlement. For the
orchestrate family the tuple governs which model the parent runs and which
model its spawned children run, which is exactly the pairing question the
suite exists to answer.

Two instrumentation gaps have to close in Phase 1 for scoring to work.
Per-turn token usage is currently held in memory only for the compaction
check and never persisted, so the engine needs a durable usage record (on the
final assistant `MessageEntry` or the settlement event) before cost columns
are possible. And because the context pruner can elide persisted tool results
and event retention drops rows for settled submissions, eval sessions either
score promptly after settlement or run with pruning disabled.

Scoring has two stages and no combined score. The programmatic outcome check
decides pass or fail and is the primary signal; decisions read that column
first. A judge session then grades the trace on a rubric for what a binary
check cannot see (for example whether tool use was economical, and whether
actions taken were safe), and that column is explicitly advisory. The judge
is a single pinned model excluded from the candidate set to avoid
self-preference, its rubrics are versioned with the corpus, and any change to
judge or rubric triggers a full re-run so historical rows stay comparable. A
sample of judge grades gets a human calibration pass before the first
scorecard ships.

### 4. Scorecards and the vetted set

The output per candidate and task family is a row: pass rate over K trials
with the trial count shown, judged quality, tokens, dollars per completed
task, and p50 wall-clock. Cost is defined as total spend across all attempts
divided by completed tasks, so a model that fails expensively looks as
expensive as it is, and the price table carries per-model cache-read and
cache-write rates because caching materially shifts agentic cost.

At the initial corpus size the honest decision grain is coarse, and the
scorecard should be read that way: "the solo executor passed 9/10 at a fifth
the cost of the frontier tuple" is a supportable conclusion, while separating
92% from 95% is not until the corpus grows. The vetted set, the short model
list Valet actually offers through the existing model catalog and org-key
plumbing, is gated by these rows: models enter and leave the set based on
scorecard evidence.

### 5. Multi-model composition in the product

The engine permits the composition today; children are limited to one level
of nesting, which covers every role shape proposed here. What remains is
policy and surface: a role-to-model placement (planner, executor children,
reviewer) configurable per org with per-session override, honored at spawn
time, with defaults taken from tuple scorecards rather than solo ones.
Per-prompt routing inside the vetted set, if role granularity ever proves too
coarse, is where an external router slots in, fed by our scorecards.

## What a suite run costs

Order of magnitude, not a quote: five candidates by fifteen tasks by three
trials is 225 sessions, plus judge passes. At a few hundred thousand tokens
per long-horizon run on mid-tier pricing, a full sweep lands in the low
hundreds of dollars plus sandbox hours. Working ceiling: a full-suite run
stays under $500, and if it does not, we cut trial count before corpus size.

## Phasing

Phase 0 is a walking skeleton, sized to the project's low priority: a minimal
runner and judge plus three to five workflow-author tasks, producing one real
scorecard end-to-end. The verdict schema is designed against that working
consumer instead of in the abstract. Phase 1 closes the instrumentation gaps
(durable usage, pruning exemption), adds the record/replay layer, and grows
the corpus to the remaining families, including orchestrate with placement
tuples. Phase 2 ships role-to-model placement configuration defaulted from
tuple scorecards. Per-prompt routing stays explicitly last and probably
external.

## Open questions

- Whether the dedicated eval environment is a fourth deploy target or a
  seeded slice of the test environment; the answer decides how "run produces
  expected effect" checks work for workflow-author.
- Whether scorecards surface in the client model selector (a "best value for
  workflows" badge) or stay an internal decision tool.
- Where judge rubrics live: with the corpus in-repo, or in the database next
  to workflow definitions.
