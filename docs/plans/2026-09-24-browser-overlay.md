# Floating Browser Preview Implementation Plan

> **For agentic workers:** Implement each task with regression tests. Use an independent reviewer before delivery.

**Goal:** Show live browser work in a movable preview over session chat.

**Architecture:** SessionView owns visibility through a scoped hook. A floating window owns bounded geometry. A read-only feed reuses existing authenticated browser queries.

**Tech Stack:** React, TypeScript, TanStack Query, Tailwind, Vitest, existing browser runtime.

## Task 1: Visibility and integration

Files: `packages/web/src/components/session/browser/use-browser-watch.ts`, its test, `session-view.tsx`, `sandbox-tabs.tsx`, and their tests.

- [x] Write tests for active execute tool detection, completed history, dismissal, minimize, restore, and session/thread changes.
- [x] Run `pnpm --filter @valet/web test use-browser-watch` and confirm the missing behavior fails.
- [x] Implement the scoped hook. Detect direct browser execute tools and call_tool with browser.execute. Require a busy agent.
- [x] Add Watch browser to the chat strip. Mount a keyed preview as a sibling of the chat content.
- [x] Test that switching to Browser removes the floating feed and that returning to Chat restores it.

## Task 2: Floating window and feed

Files: `browser-overlay.tsx`, `browser-preview-feed.tsx`, `use-browser-overlay-geometry.ts`, and associated tests in the browser component directory.

- [x] Write failing tests for read-only frames, page selection, private mode, dialogs, disabled/error states, and retry.
- [x] Write failing geometry tests for clamp, pointer drag/resize/cancel, keyboard move/resize, and container resize.
- [x] Implement a bounded floating window with an accessible header and resize handle. Use pointer capture and ResizeObserver cleanup.
- [x] Implement feed mounting only while expanded. Reuse useBrowserStatus and useBrowserFrame without browser mutations.
- [x] Run `pnpm --filter @valet/web test browser-overlay browser-preview-feed use-browser-overlay-geometry use-browser-watch`.
- [x] Run `pnpm --filter @valet/web typecheck` and existing session component tests.

## Task 3: Dogfood and deliver

Files: browser subsystem spec and `docs/research/2026-09-24-browser-dogfood.md`.

- [x] Exercise each new control in the local UI on port 5174. Run a real agent browser turn.
- [x] Check narrow viewport behavior, frame suspension, private sign-in, and tab transitions.
- [x] Update the browser subsystem spec and record validation evidence.
- [x] Run `VALET_BROWSER_TEST_IMAGE=valet-sandbox-browser:local make e2e 2>&1 | tee /tmp/valet-browser-overlay-e2e.log` with pipefail.
- [x] Request independent code review and resolve actionable findings.
- [x] Commit the overlay and spec together. Push codex/sandbox-browser and update PR 801 against dev-v2.
