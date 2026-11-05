# Sandbox Browser Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development or superpowers:executing-plans. Keep all increments in this branch and one PR.

**Goal:** Implement the approved sandbox browser end to end and verify it locally before opening one PR against `dev-v2`.

**Architecture:** A sandbox-local daemon owns Chromium, persistent cells, receipts, files and control. The browser plugin talks through a fixed stdin client. The API authorizes session actors and brokers the viewer; the web client renders page pixels and tool evidence.

**Tech stack:** TypeScript, pinned Playwright/Chromium, Node REPL, Bubblewrap, SQLite, TypeBox, Hono, React, existing Valet sandbox providers and gateway.

**Spec:** `docs/specs/2026-09-23-sandbox-browser-design.md`.
**Branch:** `codex/sandbox-browser`, based on `origin/dev-v2` at `3851ce24a`.

## Execution rules

- Add behavior tests before implementation and retain failure evidence.
- Validate each boundary with real data, not only mocked dispatch calls.
- Never replay an uncertain browser effect. Attach by invocation and operation identity.
- Report actual capability support. Unsupported platform features fail with a corrective action.
- Keep the engine portable and use current v2 packages.
- One owner edits each package at a time. Review integration before final validation.
- Record justified implementation decisions and compatibility results in the spec.

## 1. Baseline and compatibility

Files: scratch probes in `/tmp/valet-browser-spike`; results in the design's implementation notes.

- [x] Create an isolated worktree from the current `dev-v2`.
- [x] Bring the approved design and research into the branch.
- [x] Install the existing lockfile.
- [x] Run baseline typecheck and targeted engine/plugin/gateway tests.
- [x] Verify exact stable Playwright APIs and matched Chromium installation.
- [x] Test programmatic REPL evaluation across cells with top-level await.
- [x] Verify non-root Chromium and namespace confinement in the local Linux runtime.
- [x] Prove the Chromium launch wrapper, private Unix-socket egress proxy and development-port forwarding under Docker and Kubernetes security profiles before adapter implementation.
- [x] Record any platform correction before implementing dependent code.

Baseline command: `make e2e E2E_ARGS="--only typecheck,engine-unit,gateway-unit,plugins-unit"`.

## 2. Shared protocol and runtime package

Create `packages/shared/src/browser.ts` and export it from shared. Create
`packages/browser-runtime/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}`.
Add root build references and dependency lock entries.

Core messages:

```ts
type BrowserRequest = {
  version: 1;
  sessionId: string;
  threadId: string;
  invocationId: string;
  command: string;
  params: Record<string, unknown>;
};
type BrowserError = { code: string; message: string; effect: "none" | "possible" };
```

Use discriminated commands and schema validation rather than exposing a generic
method reflection endpoint. Bind browser/runtime/tab/document identities to refs.

- [x] Write protocol tests for invalid IDs, unsupported versions, limits and result shapes.
- [x] Implement schemas, status types, capabilities, evidence, tabs, leases and operation outcomes.
- [x] Add daemon/client entrypoints with bounded newline-delimited JSON on stdin/stdout.
- [x] Add idempotent submit, status/events, cancel, resolve, describe and export commands.
- [x] Run `pnpm --filter @valet/browser-runtime test` and package typecheck.

## 3. Browser adapter and observations

Create `packages/browser-runtime/src/{browser,observations,files}/`.

- [x] Add real Chromium fixture tests for navigation, fields, status, frames, shadow roots and canvas.
- [x] Implement persistent profile launch and browser/tab registry.
- [x] Implement bounded ARIA/DOM snapshots and stale reference errors. Snapshot diffs remain unavailable.
- [x] Implement the documented locator subset with strict action resolution.
- [x] Implement coordinate, keyboard, text, scroll and drag operations.
- [x] Implement screenshots and immutable-observation evaluation.
- [x] Implement bounded console logs, dialogs, fixed viewport metadata, runtime history and text clipboard.
- [x] Implement exports, downloads, uploads and observed asset inventories through a file broker.
- [x] Report WebMCP as unavailable until the pinned browser contract is verified.
- [x] Test ambiguous/stale targets, cancellation, quotas and unsupported capabilities.

The local fixture must count submissions. That counter is used again in recovery tests.

## 4. Persistent cells and operation journal

Create `packages/browser-runtime/src/{repl,journal,control}/`.

- [x] Test persistent bindings, await, errors, reset and hard timeout before coding the adapter.
- [x] Build the browser SDK as an RPC facade in a dedicated confined process.
- [x] Persist operation admission/results with an invocation hash and runtime generation.
- [x] Pause operations for policy decisions without rerunning cell source on host reconnect.
- [x] Serialize mutation ownership and implement human takeover, release and stop.
- [x] Test duplicate submit, changed hash, daemon loss, cell loss and uncertain effects.
- [x] Test that reset preserves profile/tabs but invalidates REPL bindings.
- [x] Verify the worker cannot read the profile or contact the network directly.

## 5. Engine context, plugin and image round trip

Modify `packages/engine/src/{types,thread,tool-bridge,plugin-catalog}.ts`,
`packages/plugin-browser/src/{plugin,actions}.ts`, the browser skill,
`packages/api/src/plugins/assemble.ts`, and media wire/render paths.

- [x] Add stable tool invocation identity and initiating principal to context.
- [x] Implement browser execute/reset/describe through the existing action catalog.
- [x] Use fixed sandbox client commands with JSON stdin, bounded event polling and abort.
- [x] Gate operations through explicit decisions; replay attaches by invocation ID.
- [x] Add a generic engine turn-completion hook. Close only unmarked tabs owned by the completed thread; suspension, user tabs and active human control must preserve tabs.
- [x] Read screenshots through the trusted, hash-checked transfer command, then persist typed media through BlobStore.
- [x] Preserve image content for immediate model input, live events, REST reload and historical rehydration.
- [x] Pin browser tools and replace the CLI-only skill with generated API guidance.
- [x] Add tests that assert image bytes and text survive all transcript paths.

Required regression commands:

```sh
pnpm --filter @valet/engine test happy-path
pnpm --filter @valet/engine test in-memory-store
pnpm --filter @valet/engine test tool-bridge-image
pnpm --filter @valet/store-postgres test
pnpm --filter @valet/plugin-browser test
```

## 6. Provider lifecycle and image packaging

Modify Docker/Kubernetes providers, `docker/Dockerfile.sandbox-k8s`, startup scripts,
gateway target configuration and sandbox specifications.

- [x] Add private `/var/lib/valet` state mounts with explicit session ownership.
- [x] Preserve runtime state during replacement; remove it only at final session deletion.
- [x] Add durable Docker inventory/adoption after API restart.
- [x] Package the exact browser, runtime dependencies and confinement helpers.
- [x] Start browser services lazily and expose viewer capability independently of full profile.
- [x] Add a pre-suspend hook that stops admission, settles or marks effects uncertain, flushes the journal and closes Chromium before provider suspension.
- [x] Export the required audit summary before final runtime-state deletion. A failed export blocks destructive cleanup and reports the corrective action.
- [x] Implement controlled browser egress and sandbox-local development-port forwarding.
- [x] Test real API restart, profile persistence, old-handle rejection and duplicate ownership.
- [x] Test Kubernetes manifests and lifecycle on the named local context only.

## 7. API and viewer authorization

Create `packages/api/src/routes/browser.ts` and browser service helpers. Extend
the API with browser-specific scoped tickets and independent lease checks.

- [x] Add access tests for owner, non-owner, team default-denied and explicit team audience.
- [x] Persist browser settings, grants, policy versions and sanitized operation audit records using an explicit host store. Cover restart, grant revocation and retention in tests.
- [x] Add the injected SDK `BrowserPolicyService` contract and API implementation. Keep DB and HTTP code out of the plugin and engine.
- [x] Authorize agent operations and browser decision resolution using the initiating actor.
- [x] Add status/capability/tab endpoints, ticket exchange, control and evidence/download routes.
- [x] Validate Origin and expire/revoke viewer tickets and control leases on each request.
- [x] Implement bounded JPEG polling with one request in flight and no transcript video frames.
- [x] Keep passive frame polling out of human activity accounting.
- [x] Add private sign-in mode that pauses agent reads, logs and evidence capture.
- [x] Test that a browser-view ticket cannot control or open terminal/editor routes.

Prefer existing session metadata for settings where it has a durable typed seam.
If tables are needed, use the pre-1.0 migration/schema-repair rules and test scratch databases.
Do not wipe other worktrees' databases without a task-specific reason.

## 8. Browser UI and tool renderer

Create `packages/web/src/components/session/browser/`, browser API hooks and
`tool-renderers/browser.tsx`. Modify the sandbox tab union and session view.

- [x] Write tests for capability availability, disconnected/error states and session switching.
- [x] Render tabs, URL/navigation controls, canvas, owner state and takeover/release/stop.
- [x] Map pointer coordinates with scale and handle keyboard, IME and explicit clipboard.
- [x] Add dialogs, downloads, sign-in privacy, fixed viewport metadata and annotation controls.
- [x] Display screenshot evidence from durable tool results and link to the Browser panel.
- [x] Test stale frames, control denial and image rendering after REST history reload.
- [x] Perform visual verification in the running local Valet UI.

## 9. End-to-end validation and review

Add browser tests to the existing canonical e2e suite registry. Keep all network
fixtures local and deterministic.

- [x] Exercise real agent tool → sandbox daemon → Chromium → screenshot → transcript.
- [x] Exercise web viewer → takeover → form change → release → agent observation.
- [x] Exercise API/daemon restart and verify the fixture submit counter never increments twice.
- [x] Exercise profile continuity, runtime generations, cancellation, files and capability limits.
- [x] Run targeted suites and full root typecheck. Run the final `make e2e` scorecard with complete captured output.
- [x] Obtain independent spec-compliance and code-quality reviews; fix serious findings.
- [x] Update the design with implemented behavior and measured limitations.
- [x] Commit discrete changes without AI co-author trailers.
- [x] Push the branch, create one PR against `dev-v2`, and attach it to this task.

Completion requires the feature and local validation, not just a daemon or a UI
mock. Any unsupported platform capability must be explicit in code, tests and PR
validation, and must not silently turn the approved feature into a stub.

## Local validation record

The production image builds with Node 22.23.3, Playwright Core 1.63.0, and Chromium revision 1243.
Native execution was checked on arm64 Docker and Rancher Desktop Kubernetes. Native amd64 execution remains unverified.

The local Valet UI showed live pixels, navigation, human control, screenshot evidence, and saved annotations.
Private sign-in kept the human viewer available and disabled evidence capture.
An actual API restart retained the runtime ID, open Example Domain tab, and saved evidence.
A real Anthropic turn called the browser tools, captured a screenshot, reset its REPL, and returned the page heading.

The final command was `VALET_BROWSER_TEST_IMAGE=valet-sandbox-browser:local make e2e`.
Result: **33 passed, 0 failed, 4 skipped**.
The complete command output was captured in `/tmp/valet-browser-e2e-verified.log`.

The skipped rows were fullstack-k8s, Telegram, GitHub live-App, and 1Password.
The full-stack Kubernetes row was not enabled. The other three lacked their test credentials.
The real Kubernetes provider suite passed, as did the separate arm64 browser compatibility checks.

Regression checks cover private-state ownership, browser isolation downgrades, retained-volume cleanup, API restart, and image persistence.
The workflow Docker fixture uses a separate inventory and Rancher's macOS host address.
The managed browser HTTP fixture runs in the serial browser row.

PR: [Add managed sandbox browser with shared control and evidence](https://github.com/tkhq/valet/pull/801), targeting `dev-v2`.
