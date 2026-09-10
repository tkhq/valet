# Application releases

The manual Release Application workflow releases the `dev-v2` commit selected when the run starts. Its `bump` input accepts `major`, `minor`, or `patch`.
It finds the highest stable `vX.Y.Z` tag across the repository. It increments the selected component and resets lower components.
Chart tags use `chart/valet-vX.Y.Z`. Chart versions remain independent of application versions.

The workflow creates an annotated application tag and a GitHub Release with generated notes. Concurrent release runs share one concurrency group. Tag annotations store the run ID so failed-job retries reuse the allocated version.
The workflow calls the existing CLI and Docker workflows with the new tag. Reusable workflows avoid suppressed bot tag events and default-branch dispatch registration.
The publishers check out the tag and use that tag for artifact metadata. The release run reports publisher failures.
A failed publisher can be rerun from its failed job without allocating another version.

The product changelog accepts only stable application tags. Chart tags never create product checkpoints or comparison boundaries.
The committed manifest is rebuilt from application tags to remove historical chart checkpoints. Rolling builds include changes since the last application release.

## Runbook

1. Run `gh workflow run release.yml --ref dev-v2 -f bump=patch`.
2. Replace `patch` with `minor` or `major` when required.
3. Check the Release Application run and both publisher jobs in GitHub Actions.
4. If a publisher fails, rerun failed jobs from that run.

Use the Release Application workflow from `dev-v2`. The default branch still contains the legacy workflow.
The first application release starts from `v0.0.0` when no stable application tags exist.
Generated release notes start at the previous application tag. Chart tags do not control the notes range.
Helm releases continue through Release Helm Chart with the version from `deploy/chart/valet/Chart.yaml`.
Application releases do not change the chart version or deploy a cluster.

Validation covers version increments, unrelated tags, chart exclusion, and release comparison ranges. Run the changelog tests, workflow lint, and `make e2e`.

Only application tags reachable from the build commit define changelog checkpoints. Legacy tags on other branches are excluded.
The first application checkpoint includes the complete first-parent history. Until then, builds show this history as Unreleased.

The committed manifest is an empty seed. Source builds show an empty changelog until artifact generation runs.
