# Channel Thread Defaults Implementation Plan

**Goal:** New channel threads use current defaults instead of the assistant session's historical model.

**Architecture:** Reuse `EngineHost.resolveFreshThreadSettings` for direct channel ingress and shared assistant delivery. Add one host method that returns existing threads unchanged and serializes first creation by session and key. Persist fresh model and reasoning before submitting a prompt. Keep tier tokens and existing thread pins.

**Tech stack:** TypeScript, Vitest, PGlite.

- [x] Add failing regression tests to `packages/api/src/channels/host.test.ts` and `packages/api/src/events/assistant-delivery.test.ts`.
- [x] Test changed and cleared defaults, assistant precedence, existing thread pins, restore, and concurrent first delivery.
- [x] Add the shared creation method in `packages/api/src/engine/host.ts`.
- [x] Use it from `packages/api/src/channels/host.ts` and `packages/api/src/events/assistant-delivery.ts`.
- [x] Update `docs/specs/2026-09-04-new-thread-model-picker-design.md` with channel creation rules.
- [ ] Run focused tests and the required full `make e2e` scorecard.
- [ ] Review the diff, commit, and open a PR against `dev-v2`.

Channel ingress has no source thread, so it uses current defaults regardless of `newThreadBehavior`. Shared assistants use their owner's scope. Preference changes do not modify existing threads or persisted session defaults. A failed first creation remains retryable. Tests cover cross-path concurrency, a delayed persistence barrier, failure and retry, and restored pins when fresh-default lookup fails.
