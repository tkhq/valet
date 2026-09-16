# Artifact CI gate implementation plan

**Goal:** Require successful checks for the source commit before any deployable artifact or application release is published.

**Design:** Extract all checks into `ci-checks.yml`. CI, application releases, and chart releases reuse that workflow. Preserve the top-level `ci` check for branch protection. Docker and CLI workflows accept only reusable calls from gated jobs.

## Steps

- [x] Extend regression coverage to CLI, charts, application release creation, and every publisher caller.
- [x] Extract the checks. Preserve the aggregate failure checks and read-only permissions.
- [x] Gate CLI calls from CI and the application release workflow. Join binary builds before publishing release assets.
- [x] Gate chart publication and application tag creation with the shared checks. Limit automatic chart releases to chart changes. Preserve the manual version override.
- [x] Update the artifact spec, run workflow/release tests and e2e, and obtain a focused review.
- [x] Update PR #717 with the full artifact scope and validation results.
