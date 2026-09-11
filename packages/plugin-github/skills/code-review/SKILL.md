---
name: code-review
description: Review a pull request or code change for correctness, security, regressions, and missing tests. Use local repository evidence or GitHub pull-request data, and report findings before a summary.
---

# Code Review

Review the requested pull request, commit range, or local change. If the target is unclear, ask for the repository and pull request or branch.

## Review process

1. Read the repository guidance before you assess the change.
2. Inspect the full diff and the surrounding code that controls each changed path.
3. Read existing review comments and CI results when the target is a pull request.
4. Check correctness, security boundaries, error paths, compatibility, and test coverage.
5. Run focused checks when a working copy is available.
6. Report only actionable findings that the change introduced.

For each finding, give the severity, file, line, impact, and smallest safe fix. Put findings first, in severity order. If you find no issue, say so and name any test or coverage gap that remains.

Do not post a GitHub review or comment unless the user asks you to publish it. Use the GitHub integration to inspect a remote pull request. Use the local git working tree when the change is already available there.
