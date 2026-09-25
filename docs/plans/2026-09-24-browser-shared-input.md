# Shared browser interaction implementation plan

> For agentic workers: use subagent-driven development for the independent runtime and web changes, followed by review.

**Goal:** Let people and agents use the sandbox browser without a take or release step for normal interaction.

**Architecture:** Optional input leases select shared access or explicit exclusivity. Keep the existing effect queue, identity checks, and private-mode boundaries.

**Tech Stack:** TypeScript, Playwright, Hono, React, Vitest.

## Tasks

- [x] Add failing runtime and protocol regressions for shared input, ordering, and explicit control isolation.
- [x] Update `packages/shared/src/browser.ts` and browser-runtime control, protocol, daemon, and backend code.
- [x] Add failing HTTP and web tests for lease-free navigation and controls.
- [x] Update `packages/api/src/routes/browser.ts` schemas and `packages/web/src/components/session/browser/` controls.
- [x] Clarify preview pause state and offer owner-only Resume agent outside private mode.
- [x] Update the browser skill and subsystem specs to describe shared input and explicit pause.
- [x] Run focused package tests and typecheck. Build the browser image if the runtime changes.
- [x] Dogfood shared human and agent input with the live preview. Review the change.
- [x] Run `VALET_BROWSER_TEST_IMAGE=valet-sandbox-browser:local make e2e` with complete output through `tee`.
- [x] Commit and push the existing PR 801 off dev-v2 with the final validation results.

Use `pnpm --filter @valet/browser-runtime test`, `pnpm --filter @valet/web test browser`, and targeted API browser tests without a separator.
Each new regression must fail for the missing behavior before implementation. Keep production changes within the shared-input contract.

## Verification notes

- Runtime tests: 73 passed, including real Chromium observations and shared-input races.
- Web browser tests: 71 passed. API route tests: 7 passed. API, web, and runtime typechecks passed.
- The Docker regression rejected lease-free input on the old image before the runtime update.
- The final managed image built successfully. Its runtime is installed in the existing local dogfood sandbox.
- Manual checks passed for shared navigation, typing, submission, dialogs, new tabs, selection, and tab closing.
- Explicit pause kept the preview live. Resume agent worked from chat. Private sign-in hid the preview until its explicit exit.
- A real agent found the human-entered name, changed it, submitted the form, and filled Notes in separate browser cells.
- Screenshots showed those changes in the mini-browser. Runtime status confirmed no control lease during the agent turn.
- Local API and web remain available at ports 8788 and 5174. Three existing page URLs remain open.
- Full scorecard: 32 passed, 1 failed, 4 skipped. The unrelated cross-thread test received an empty real-model reply.
- An isolated integration-agent rerun passed without source changes: 1 passed, 0 failed. All 33 runnable checks passed across these runs.
- Full log: `/tmp/valet-browser-shared-input-e2e.log`. Retry log: `/tmp/valet-browser-shared-input-e2e-agent-retry.log`.
- Skips require full-stack Kubernetes opt-in, Telegram credentials, GitHub App credentials, or a 1Password token.
