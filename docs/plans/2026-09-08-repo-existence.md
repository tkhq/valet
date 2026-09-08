# Repository existence validation plan

**Goal:** Reject confirmed missing repositories before session creation.

**Architecture:** Use the current GitHub token resolver and GitHub reader. Share a three-state check between session creation and automatic source creation.

**Tech stack:** TypeScript, Hono, Drizzle, Vitest, GitHub REST API.

- [x] Add HTTP fixture tests for 404 rejection, canonical identity, and fallback behavior. Run the tests before implementation.
- [x] Add repository metadata to the current GitHub reader. Add a shared check with found, not-found, and unverified results.
- [x] Check all bindings before session writes. Return an error with a corrective action for confirmed 404 responses.
- [x] Check org access before automatic source writes. Skip unverified repositories and preserve the existing bake gates.
- [x] Update decision 13 in the sandbox reconciliation spec.
- [ ] Run targeted tests, type checks, and `make e2e`. Review the diff, commit, and open a PR against `dev-v2`.

Acceptance criteria:

- Only a 404 from the repository metadata request rejects a binding. Credential-resolution failures allow binding and log the reason.
- Successful checks persist `full_name` and `clone_url`. Each check uses the binding's auth mode and requesting user.
- A multi-repo request with a missing repository writes no session or bindings.
- Automatic source creation uses org credentials. Missing credentials and failed checks create no source rows.
