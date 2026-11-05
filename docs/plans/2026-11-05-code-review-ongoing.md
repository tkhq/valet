# Ongoing Code Review Implementation Plan

> For agentic workers: use subagent-driven development or inline execution for the assigned files.

**Goal:** Fix repository setup and show open pull requests with their review chains.

**Architecture:** Keep repository configuration in event subscriptions. Extend the scoped review API with current GitHub state, delivery status, and bounded round history. Compose the existing web primitives for the dialog and ongoing list.

**Tech Stack:** TypeScript, Hono, React, TanStack Query, Radix, Tailwind, Vitest.

**Spec:** `docs/specs/2026-11-05-code-review-ongoing-design.md`

## Global constraints

- Use the existing isolated `xbalbinus/pr-review-ui` worktree.
- Preserve organization and personal or team authorization.
- Do not create duplicate review subscriptions or move existing configurations.
- Use existing visual primitives and handle async loading, error, empty, and pending states.
- Do not use unchecked TypeScript assertions for external data.

## Review focus

- A configured repository remains discoverable in the picker, including another workspace's configuration.
- Repository search results remain visible on short and narrow screens.
- Closed or merged pull requests never appear as ongoing.
- A first review appears while pending, before result pointers exist.
- Multiple pushes appear as one review chain without crossing workspace boundaries.

## Tasks

- [x] Repository dialog: add a self-contained component and behavioral tests; show inline results and existing configuration actions. Verify targeted web tests.
- [x] Ongoing review API: add failing tests for open/closed/merged state, progress, history, and scope; implement bounded reads and update wire types. Verify API and plugin tests.
- [x] Ongoing review UI: integrate the dialog, add the ongoing list and expandable rounds, and update route tests. Verify web tests, types, browser layouts and form behavior.
- [x] Run the repository's required `make e2e` scorecard, obtain an independent review, and fix actionable findings. Record environmental limitations.

## Verification

- The changed suites pass: 43 frontend tests, 12 API tests, and 30 plugin tests.
- API, web, and PR-review plugin typechecks pass.
- Browser checks cover repository search, empty results, existing settings, successful addition, and expanded review chains. Layouts were inspected at 375, 760, and 1280 pixels.
- Independent reviews found duplicate coverage for broad repo filters and GitHub request cancellation and retry-state issues. These findings were fixed and rechecked.
- The full scorecard reports 23 passed, 5 failed, and 9 skipped groups. The failing groups are conventions, unit, engine-unit, browser-runtime, and keycloak-oidc.
- Browser-runtime passes under Node 24: 88 passed and 45 skipped tests. The Node 26 run failed because its native SQLite module was built for Node 24.
- The fresh final unit sweep under Node 24 has 15,660 passed, 9 failed, and 78 skipped tests. All changed suites pass. The remaining failures are in unchanged OIDC, skill-file publishing, skill collection, and credential-scanning performance tests. Skill publishing fails on macOS `chmod --`; OIDC expects an API configuration path that the deployment now rejects.
- The isolated engine checkpoint suite has 35 passed tests and one timeout. The full engine run had two other checkpoint timeouts under concurrent load.
- Conventions reports three existing double casts in `source-service.test.ts`, Kubernetes `provider.test.ts`, and workflow `validate.test.ts`.
- Verification did not change review subscriptions or post pull request reviews.

## Release preparation

The release branch starts from current `dev-v2` and preserves its newer reviewer
validation. Installed repositories now appear in the main inventory, with
configured repositories first and a filter for large installations. Shared
configurations use read-only repository switches and link to their full rule.
Changing workspaces remounts settings for the incoming rule.

Fresh checks on the release branch pass: 58 targeted frontend tests, 51 review
API and plugin-metadata tests, 39 reviewer-plugin tests, and 71 Presence editor
tests. Web typecheck passes. Independent review findings have regression tests.
