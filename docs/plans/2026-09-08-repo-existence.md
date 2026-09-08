# Repository existence validation plan

**Goal:** Reject confirmed missing repositories before session creation.

**Architecture:** Use the current GitHub token resolver and GitHub reader. Share a three-state check between session creation and automatic source creation.

**Tech stack:** TypeScript, Hono, Drizzle, Vitest, GitHub REST API.

- [x] Add HTTP fixture tests for 404 rejection, canonical identity, and fallback behavior. Run the tests before implementation.
- [x] Add repository metadata to the current GitHub reader. Add a shared check with found, not-found, and unverified results.
- [x] Check all bindings before session writes. Return an error with a corrective action for confirmed 404 responses.
- [x] Check org access before automatic source writes. Skip unverified repositories and allow anonymous public-repository bakes.
- [x] Update decision 13 in the sandbox reconciliation spec.
- [x] Run targeted tests, type checks, and `make e2e`. Review the diff, commit, and open a PR against `dev-v2`.

Acceptance criteria:

- Only an authenticated repository metadata 404 rejects a binding. Anonymous failures allow binding and log the reason.
- Successful checks persist `full_name` and `clone_url`. Each check uses the binding's auth mode and requesting user.
- A multi-repo request with a missing repository writes no session or bindings.
- Automatic source creation uses org credentials or anonymous public access. Failed checks create no source rows. Public bakes need no Git token.

Validation results:

- Repository, reader, route, and source tests: 180 passed. Child-spawner tests: 67 passed.
- Full e2e run: 28 passed, three failed, four opt-in checks skipped.
- After corrections, all three failed stages passed on rerun: typecheck, root unit tests, and plugin tests.
