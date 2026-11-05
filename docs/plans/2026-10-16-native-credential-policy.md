# Native Credential Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native integrations (GitHub, Slack, Linear) fall back to their app identity as a bare token; non-native services never do; the org Linear row stops leaking its metadata.

**Architecture:** A `native` flag and `appCredentialService` on `ValetPlugin`; the host credential resolver applies the spec's Part B order and builds app tokens; `mcpActionPlugin` falls back to `credentials.get(appCredentialService)`.

**Tech Stack:** TypeScript, Hono api, `@valet/engine`, `@valet/sdk`, vitest.

**Spec:** `docs/specs/2026-10-15-native-integration-credential-policy-design.md` (binding; spike S1 is resolved by Linear's MCP docs: bearer OAuth tokens are accepted to act as an app user).

## Global Constraints

- Branch `feat/native-credential-policy` off `dev-v2`; PR base `dev-v2`.
- CLAUDE.md rules: no `any`, no `as unknown as T`; ASD-STE100 prose; every refusal names its fix; commit subjects ≤72 chars with `Changelog:` trailer on feat/fix.
- An app credential reaches an action as `{ accessToken }` only (INV-P1).

## Review Focus

1. A team session where the acting member's share is broken (dead token): expect the next tier, not an error, matching today's dead-row skip.
2. A non-native plugin that happens to declare an org row: expect no app token (INV-P2).
3. MCP tool discovery with only the app token: expect tools listed, not "no credential connected".
4. An org-owned workflow run with an explicit `credential: "user"` on GitHub: expect today's refusal or user resolution, unchanged.
5. LinearAppTokenStore renewal still runs when the token is read as an app token.

---

### Task 1: Close the org row leak (spec Part D)

**Files:** `packages/api/src/services/credential-resolution.ts` (`resolveOrgCredentialRead`), tests beside it.

- [ ] Failing tests: an org-owned read of `linear` (org row with `grant: client_credentials`, metadata `webhookSecret`) returns `{ accessToken }` only; an org read of a non-native service whose org row is an app credential returns null; deny list unchanged.
- [ ] Implement; run `pnpm --filter @valet/api test credential-resolution`.
- [ ] Commit `fix(api): hand org app credentials to actions as bare tokens` with `Changelog: none`.

### Task 2: Classification and resolution order (Parts A, B, C GitHub)

**Files:** `packages/engine/src/valet-plugin.ts` (`native?`, `appCredentialService?`, validation), plugin manifests (github, slack, linear), `packages/api/src/engine/host.ts` (`buildCredentialResolver`), `packages/api/src/services/credential-resolution.ts`, `packages/api/src/plugins/action-invoker.ts` (org-owned workflow GitHub `auth: "app"`).

- [ ] Failing tests for every row of the Part B table per owner type, INV-P2 (config MCP server never gets an app token), INV-P3, and the org-owned workflow run using the installation before the PAT.
- [ ] Implement; host resolves `linear:app` from the org `linear` row as an app token; `slack` and `github:installation` keep current behavior.
- [ ] Commit `feat(api): fall back to native app identities by policy` with a `Changelog:` line.

### Task 3: Linear through the app identity (Part C Linear)

**Files:** `packages/sdk/src/mcp/action-plugin.ts` (`appCredentialService` option used in discovery and calls), `packages/plugin-linear/src/plugin.ts`.

- [ ] Failing tests: with no personal credential, discovery and a call send the app token as Bearer; with a personal credential, the personal token wins.
- [ ] Implement; commit `feat(plugin-linear): act as the Valet app without a personal connection` with a `Changelog:` line.

### Task 4: Workflows (Part E), spec updates, acceptance

**Files:** `packages/api/src/plugins/action-invoker.ts` (credential field for native services), `packages/api/src/workflows/team-service-readiness.ts`, `docs/specs/2026-07-20-event-system-design.md` (replace the "App credentials stay excluded" sentence with the class rule), the policy spec (S1 resolution note, Deviations), an integration test for acceptance steps P1–P6 with a stub MCP server.

- [ ] Failing tests, implement, `make e2e`, commit `feat(api): let workflow nodes pick native app identities` and `docs: …`.
