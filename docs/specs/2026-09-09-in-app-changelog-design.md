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

`release.json` identifies the commit that produced the artifact. The Docker and CLI workflows generate both files for `v*` release tags. The files become part of the image or binary. An app served from an older release therefore serves that release's changelog. Rolling `dev-v2` builds are not versioned releases and do not create checkpoints.

If the artifact SHA has no checkpoint, the API returns `latest-known`. The UI explains that it shows the latest known checkpoint. An empty manifest produces an empty state.

## Generation

Run this command from the repository root:

```bash
pnpm changelog:generate -- \
  --version 0.10.8 \
  --release-sha HEAD \
  --metadata packages/api/src/changelog/release.json \
  --release-url https://github.com/tkhq/valet/commit/$(git rev-parse HEAD)
```

The generator reads the first-parent `dev-v2` range from the newest checkpoint SHA to the released SHA. It uses commit subjects, bodies, changed paths, and PR numbers already present in Git history.

The generator excludes these changes unless the commit contains `[user-visible]` or `[changelog]`:

- Merge commits.
- Dependency-only updates.
- `build`, `chore`, `ci`, `docs`, `refactor`, and `test` commits.
- Changes limited to docs, scripts, CI files, or test files.

The generator fails if the range has no user-facing entries. It does not publish an empty checkpoint.

Use `--backfill-tags '<pattern>'` to add checkpoints for older release tags. The checked-in manifest backfills chart releases 0.10.0 through 0.10.7.

## API and UI

`GET /api/changelog` returns the bundled manifest and its match to the running artifact. The route uses normal app authentication.

The `/changelog` page shows checkpoints newest first. Each entry shows its category, user impact, commit, and PR when available.

The client stores the newest displayed checkpoint ID in local storage. The key includes the user ID. Checkpoints newer than that ID show as new. Opening the page marks the displayed newest checkpoint as seen without changing shared manifest data.
