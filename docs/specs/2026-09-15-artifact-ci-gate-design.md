# Artifact CI gate

## Contract

CI must pass for the source commit before any deployable artifact is published.
This includes Docker images, native CLI binaries, Helm charts, and application release creation.
The gate applies to automatic pushes, version tags, and manual publishing. Pull requests never publish artifacts.

## Shared checks

`ci-checks.yml` owns typecheck, all test shards, cgroup tests, docs lint, and their aggregate result.
It also runs the existing web build and release-workflow tests. Every publishing entry point calls these same checks with read-only repository permissions.
The aggregate job requires every dependency to succeed. Failed, cancelled, or skipped checks prevent publishing.

`ci.yml` keeps the top-level `ci` status for existing branch protection. It reports the shared workflow result.
Docker and CLI publishing require that status to succeed. Neither publisher has an independent push or manual trigger.
They run for `dev-v2`, `v*` and `valet/v*` tags, and manual CI runs. Normal `main` pushes run checks only.

`release.yml` calls the shared checks before creating an application tag or GitHub Release.
Its CLI and Docker jobs require the release job. They build the generated tag at the tested caller commit.

`release-chart.yml` runs on chart directory changes or manual dispatch. Workflow-only edits do not publish an unchanged chart. Chart publishing requires both chart validation and the shared checks.
Pull requests run chart validation only; ordinary PR CI supplies the shared checks.
The manual `force` option bypasses only the version-collision check. It cannot bypass CI.
Chart changes can run the shared checks twice: once in CI and once in the chart workflow.

## Source and permissions

Reusable workflows retain the caller SHA and ref. Docker and CLI builds verify that checkout matches `github.sha` before uploading artifacts.
A mismatched release-tag input fails before publishing.
Docker retains `type=sha,prefix=sha-`, with the default seven-character short SHA. Branch publishes retain `dev-v2`.
Version tags retain their release version. Only exact `vX.Y.Z` or `valet/vX.Y.Z` Docker releases receive `latest`. Prereleases and non-version tags cannot move it. Automatic latest tagging is disabled.
Both supported tag formats generate embedded release metadata with the release version and tested commit SHA for Docker and CLI builds.

Docker publishing receives `contents: read` and `packages: write`. CLI publishing receives `contents: write`; its build jobs use `contents: read`.
Chart publishing and application release creation retain their existing permissions. GHCR login uses `GITHUB_TOKEN`. No OIDC permission is required.

## Build joins

Both Docker images build for `linux/amd64` and `linux/arm64` on native runners.
Manifest tagging requires all four build legs. A failed leg prevents tags on both images.
Successful build legs can leave untagged digests; these builds occur only after CI passes.

CLI builds produce macOS and Linux binaries for arm64 and x64. Both native smoke tests must succeed before any GitHub Release asset upload.
The publish job downloads both build artifacts and uploads the binary set.

Registry tag writes and GitHub asset uploads are not atomic. A service error during publishing can leave partial artifacts despite successful checks and builds.
Consumers that require multiple artifacts must check that the complete set exists before promotion.

## Manual publishing

For Docker images and CLI binaries:

1. Open CI in GitHub Actions.
2. Select **Run workflow**.
3. Select the source branch or tag.
4. Start the workflow.

Use **Release Application** to create a new application version. Use **Release Helm Chart** to publish a chart manually.
All three manual entry points require the shared checks. The separate Docker and CLI manual triggers are removed.

## Validation

`scripts/e2e/artifact-publish.test.ts` checks caller dependencies, trigger boundaries, source verification, permissions, and build joins.
Application-release tests check release retries, execute the Docker tag shell step across a ref table, and run the metadata generator for both tag formats. Actionlint checks workflow syntax and reusable-workflow inputs.
These local checks do not publish artifacts.

After merging, verify these cases with fresh commits in GitHub Actions and the artifact stores:

1. Push a failing commit to `dev-v2`. Confirm Docker tags and rolling CLI assets do not change.
2. Push a passing commit. Confirm both Docker SHA tags match its short SHA and the CLI release identifies that commit.
3. Push a version tag. Confirm CI precedes Docker and CLI publication.
4. Run Release Application on a failing commit. Confirm no application tag or release is created.
5. Change a chart with failing CI. Confirm no OCI chart or chart tag is published.
6. Dispatch chart publishing with `force=true` and failing CI. Confirm publishing is skipped.
7. Fail a CLI platform build. Confirm neither platform updates the GitHub Release assets.

A failed rerun does not remove previously published artifacts. Publishing now starts after the slowest required CI job.
Measure the added latency in hosted runs.

GitHub documents [caller context and permission rules](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).
Docker documents [SHA tag computation](https://github.com/docker/metadata-action#typesha).
