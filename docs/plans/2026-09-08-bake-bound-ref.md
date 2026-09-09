# Bake the bound repository ref

**Goal:** Bake the recipe and checkout from the session's bound ref.

**Design:** Store `repo_ref` on each repository image source. An empty value means the default branch. Source uniqueness includes org, host, repository, and ref. Resolve explicit refs with the existing `resolveRefSha` helper. Do not fall back to the default branch when an explicit ref fails.

- Add regression tests for a default branch without a recipe and a bound branch with `skipDetect` and `setup`.
- Add the column and replace the repo uniqueness index in the baseline migration. Repair deployed schemas transactionally and preserve existing rows as default-branch sources.
- Pass the ref from REST and child bindings. Scope source creation, bake resolution, parent layers, decay, and session image selection to that ref.
- Scope saved source resources and the prebuild badge lookup to the same ref. Confirm YAML resource reads already use the session ref.
- Test manual bakes, nightly scheduling, parent-push cascades, branch isolation, explicit-ref failures, and schema repair.
- Update the sandbox reconciliation spec. Run typecheck, targeted suites, full e2e, and review before opening the stacked PR.

Existing sources keep default-branch semantics. A new binding creates the source for an explicit ref. Artifact placement, pull policy, and toolchain pin changes stay outside this PR.
