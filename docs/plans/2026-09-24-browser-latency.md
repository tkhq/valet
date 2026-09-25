# Browser latency implementation plan

> For agentic workers: use subagent-driven development for independent provider and runtime tasks.

**Goal:** Remove routine browser approval noise and make browser interaction responsive.

**Architecture:** Reuse private sandbox exec transport across browser commands. Return preview frames inline and poll with a bounded cadence.

**Tech Stack:** TypeScript, Node streams, Docker exec, Kubernetes pods/exec, Playwright, React, Vitest.

## Tasks

- [x] Reproduce approval policy failures and measure the current Docker and HTTP paths.
- [x] Update policy defaults and agent consent guidance with regression tests.
- [x] Add portable channel types in `packages/engine/src/types.ts` and fence the policy wrapper.
- [x] Implement Docker and Kubernetes channels with focused transport and identity tests.
- [x] Implement concurrent client stream envelopes and inline frames in `packages/browser-runtime` and `packages/shared/src/browser.ts`.
- [x] Add a bounded multiplexer in `packages/plugin-browser/src/channel.ts`; test correlation, failures, abort, and lifecycle.
- [x] Switch frame routes to inline responses and validate integrity in `packages/api/src/routes/browser.ts`.
- [x] Change `pollBrowserFrames` to a 100 ms start cadence; test slow frames and cleanup.
- [x] Build the sandbox image and compare before/after distributions in an isolated local fixture.
- [x] Dogfood real UI interactions and approvals. Record measured results and remaining limits.
- [x] Review the full change, run full `make e2e` with `tee`, and address failures.
- [x] Commit with the updated specs and push the existing PR 801 off dev-v2.

Write regression tests first for each behavior. Confirm the expected failure, implement, then rerun the focused package suite.
Use `pnpm --filter @valet/<package> test <filter>` without a separator before the filter.
