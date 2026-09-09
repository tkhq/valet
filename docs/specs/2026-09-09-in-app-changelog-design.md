# In-app changelog

**Date:** 2026-09-09
**Issue:** TKAI-360

## Goal

Valet shows release changes inside the app. The view uses data from the running release artifact. Runtime reads do not call GitHub.

## Release artifact

`packages/api/src/changelog/manifest.json` uses schema `valet-changelog/v1`. It contains immutable checkpoints in newest-first order.

A checkpoint contains:

- The release version and date.
- The released commit SHA.
- The previous checkpoint SHA.
- User-facing entries for that commit range.
- Optional release and source links.

The checkpoint ID is `<version>@<releasedSha>`. A retry with the same ID and data is a no-op. A retry with different data fails.

`release.json` identifies the commit that produced the artifact. The Docker and CLI workflows rebuild cumulative history from all release tags. This avoids a dependency on workflow commits. Each release artifact contains its checkpoint and all prior checkpoints. Rolling `dev-v2` builds do not create checkpoints.

The generator uses the tag creation time as the release time. It converts each time to UTC before comparison and storage. Commit author dates do not control release order.

If the artifact SHA has no checkpoint, the API returns `latest-known`. The UI explains that it shows the latest known checkpoint. If manifest validation fails, the API logs the failure and serves a safe empty changelog response.

## Generation

Run this command from the repository root:

```bash
pnpm changelog:generate -- \
  --version 0.10.8 \
  --release-sha HEAD \
  --released-at 2026-09-09T12:00:00Z \
  --metadata packages/api/src/changelog/release.json \
  --release-url https://github.com/tkhq/valet/commit/$(git rev-parse HEAD)
```

The release workflows use all `chart/valet-v*` and `v*` tags as the source of cumulative checkpoint history. The previous release tag defines each comparison range. A two-release test verifies that the second artifact includes both checkpoints.

The generator reads first-parent commit ranges. It uses commit subjects, explicit user-impact text, changed paths, and PR numbers already present in Git history.

The generator excludes these changes unless the commit contains `[user-visible]` or `[changelog]`:

- Merge commits.
- Dependency-only updates.
- Subjects without a `feat`, `fix`, or `security` prefix.
- `build`, `chore`, `ci`, `docs`, `refactor`, and `test` commits.
- Changes limited to docs, scripts, CI files, or test files.

An explicit `User impact:` or `Changelog:` body line becomes the entry description. If that line is absent, the generator creates category-specific copy from the cleaned user-facing title and flags the entry for follow-up. The fallback preserves the commit and PR identifiers.

A release with no included changes still gets a checkpoint with an empty entry list. The generator prints a warning, and the UI states that no user-facing changes shipped. This behavior keeps publication available without silently hiding the empty checkpoint.

Use repeated `--backfill-tags '<pattern>'` arguments to rebuild checkpoints from release tags. The checked-in manifest backfills chart releases 0.10.0 through 0.10.7.

## API and UI

`GET /api/changelog` returns the bundled manifest and its match to the running artifact. The route uses normal app authentication.

The `/changelog` page shows checkpoints newest first. Each entry shows its category, user impact, commit, and PR when available.

The client stores the newest displayed checkpoint ID in local storage. The key includes the user ID. The page snapshots unread checkpoints before it updates storage. New badges therefore remain visible for that visit while the top navigation indicator clears.
