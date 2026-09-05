# Supervised Model Guidance Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the bounded tasks with review.

**Goal:** Support supervisor-selected drafting/review tiers and show agents their actual running model.

**Architecture:** API prompt fragments own selection advice. The engine adds model context at the stream boundary using live state.

**Tech Stack:** TypeScript, pi-agent-core, pi-ai, Vitest.

## Task 1: Supervisor and child guidance

Files: `packages/api/src/engine/prompt-rules.ts`, its test, `packages/api/src/orchestrator/persona.ts`, its test,
and `docs/specs/2026-07-11-orchestrator-engine-design.md`.

- [x] Replace tests that require blanket L/XL escalation with the agreed supervisor, drafting, review, and child escalation policy.
- [x] Run the exact prompt-rules and orchestrator/persona test files. Confirm the new assertions fail.
- [x] Separate common model mechanics from supervisor and child selection advice. Keep tier tokens and turn-scoped switches.
- [x] Add explicit difficulty assessment and a separate review/fix cycle to delegation briefs.
- [x] Update the subsystem spec and rerun the same tests.

## Task 2: Runtime model context and tool descriptions

Files: `packages/engine/src/thread.ts`, `packages/engine/src/model-context.ts`,
`packages/engine/test/model-context.test.ts`, `packages/engine/src/builtin-tools/index.ts`,
`packages/engine/test/model-switching.test.ts`, `packages/engine/test/roles-skills.test.ts`,
and `docs/specs/2026-08-24-thread-model-pinning-and-compaction-design.md`.

- [x] Add provider-context tests using the existing faux provider and in-memory engine fixtures.
- [x] Cover the assignment, switch, failed switch, turn reset, successful role override, and restored thread cases from the spec.
- [x] Run `pnpm --filter @valet/engine test model-context` and confirm failure from missing context.
- [x] Add a pure prompt formatter. Pass the assignment and active selection separately from the actual stream model.
- [x] Track a successfully applied role selection during its turn. Clear it with the role overlay.
- [x] Append the context in `streamFn` without mutating stored prompts or messages. Preserve all existing stream options.
- [x] Align task and switch tool descriptions with supervisor selection and evidence-based child escalation.
- [x] Update the model-pinning spec. Run `pnpm --filter @valet/engine test model-context model-switching roles`.

## Task 3: Review and verification

- [x] Review the complete diff against the approved policy and runtime-context contract.
- [x] Run `pnpm typecheck` and the affected API and engine suites.
- [x] Run `make e2e` and capture its complete output. Investigate every red row.
- [x] Prepare the scoped changes and specs for commits and branch handoff.

## Validation results

- API prompt and persona suites: 22 tests passed.
- Engine model context, model switching, and role suites: 65 tests passed.
- Root typecheck and `git diff --check`: passed.
- Full `make e2e`: 28 passed, 2 failed, 5 skipped.
- Full rerun of `sandbox-k8s,store-postgres`: 2 passed, 0 failed.

The Kubernetes failure reported a missing PVC before the expected image-pull
failure. The isolated test and full row both passed on rerun.
The Postgres command-entry fixture preserves prior data on its first test.
It found an extra row from an earlier suite. The isolated fresh-database test
and full Postgres row both passed. These failures required no code changes.

All 30 configured scorecard rows passed across the run and reruns. The five
skipped rows require opt-in flags or credentials. Spec and code reviews passed.
