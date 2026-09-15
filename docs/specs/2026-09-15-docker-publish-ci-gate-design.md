# Docker image CI gate

## Contract

CI must pass for the source commit before Docker Images pushes any image.
This applies to `dev-v2` pushes, `v*` and `valet/v*` release tags, and manual publishing.
Pull requests and `main` pushes run checks without publishing images.

## Workflow

`ci.yml` owns push and manual triggers. Its `ci` job checks typecheck, every test shard, cgroup tests, and docs lint.
The `publish` job requires that aggregate job to succeed. It calls `docker-publish.yml` with inherited secrets.
The caller grants `contents: read` and `packages: write`. GHCR login uses `GITHUB_TOKEN`; no OIDC permission is required.

`release.yml` calls CI with its generated application tag before publishing Docker images.
`docker-publish.yml` accepts only `workflow_call`. Builds verify that the checked-out release tag matches the caller commit before any push. The caller context supplies the source commit for checkout and Docker metadata.
The existing `type=sha,prefix=sha-` rule produces `sha-<shortsha>` from that commit, with the default seven-character short SHA.
Branch publishes retain the `dev-v2` tag. Releases retain their version tag; stable releases also receive `latest`.

Both images build for `linux/amd64` and `linux/arm64` on native runners.
The `merge` job requires the complete four-leg build matrix. A failed build prevents tags on both images.
Successful build legs can leave untagged digests after another build leg fails. All these builds occur after CI succeeds.
GHCR cannot update two repositories atomically. A registry error or cancellation during manifest tagging can leave a partial publish.
Consumers that require both images must check both SHA tags before promotion.

## Manual publishing

1. Open the CI workflow in GitHub Actions.
2. Select **Run workflow**.
3. Select the source branch or tag.
4. Start the workflow.

Manual publishing runs all required checks. It does not bypass the gate.
The Docker Images workflow no longer has a separate manual trigger.

## Validation

`scripts/e2e/docker-publish.test.ts` checks the trigger boundary, CI dependency, permissions, build join, and SHA configuration.
These checks run in the existing Vitest suite. They do not execute GitHub Actions or push images.

After deployment of this workflow change, verify these cases in GitHub Actions and GHCR:

1. Push a failing test commit to `dev-v2`. Confirm publishing is skipped and neither repository has its SHA tag.
2. Push a passing commit to `dev-v2`. Confirm both SHA tags match its short SHA and both manifests contain both architectures.
3. Push a `v*` or `valet/v*` release tag. Confirm CI precedes publishing and the expected release tags exist.
4. Run CI manually. Confirm failed checks prevent publishing.

Use commits with no previously published SHA tags for the failure check. A failed rerun does not remove existing images.
Publishing now starts after the slowest required CI job. The native image builds remain parallel.
Measure the added latency from the first successful hosted run; local checks cannot establish it.

GitHub documents [caller context and permission rules](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).
Docker documents [SHA tag computation](https://github.com/docker/metadata-action#typesha).
