# In-app changelog

**Date:** 2026-09-09
**Issue:** TKAI-360

## Goal

Valet shows released and pending changes inside the app. The view uses data from the running artifact. Runtime does not call GitHub.

## Changelog artifact

`packages/api/src/changelog/manifest.json` uses schema `valet-changelog/v2`. It contains one optional `unreleased` checkpoint and immutable `released` checkpoints.

A released checkpoint contains:

- The release version and time.
- The released commit SHA.
- The previous released checkpoint SHA.
- User-facing entries for that commit range.
- Optional release and source links.

The released checkpoint ID is `<version>@<releasedSha>`. A retry with the same ID and data is a no-op. A retry with different data fails.

An unreleased checkpoint contains:

- The `unreleased` kind and `Unreleased` UI label.
- The rolling build SHA and build time.
- The previous released checkpoint SHA.
- User-facing entries for that commit range.
- Optional build and source links.

The unreleased checkpoint ID is `unreleased@<buildSha>`. Each rolling build replaces the prior unreleased checkpoint. A retry for one build SHA produces the same checkpoint.

`release.json` identifies the commit that produced the artifact. Docker and CLI workflows rebuild cumulative released history from local release tags. A `dev-v2` build then adds or replaces the unreleased checkpoint. A version tag creates the released checkpoint and removes the unreleased checkpoint. The released checkpoint absorbs the same commit range, so one artifact does not show both copies.

The generator uses tag creation time for released checkpoints. It uses the commit time as the stable rolling build time. It converts all times to UTC. Commit author dates do not control checkpoint order.

If the artifact SHA has no checkpoint, the API returns `latest-known`. If manifest validation fails, the API logs the failure and serves an empty changelog response.

The response accepts a string or null artifact SHA. This type stays fixed when release generation replaces the development null with a commit SHA. CI generates release metadata before typechecking to cover the Docker and CLI build input.

## Generation

Use this command to generate a rolling checkpoint:

```bash
pnpm changelog:generate -- \
  --backfill-tags 'chart/valet-v*' \
  --backfill-tags 'v*' \
  --unreleased-sha HEAD \
  --built-at "$(git show -s --format=%cI HEAD)" \
  --artifact-version Unreleased \
  --artifact-sha HEAD \
  --metadata packages/api/src/changelog/release.json
```

The release workflows use `chart/valet-v*` and `v*` tags as cumulative released history. The previous released tag defines each comparison range. Tests cover two rolling builds, reruns, empty rolling builds, and promotion to a release.

The generator reads first-parent commit ranges. It uses commit subjects, explicit user-impact text, changed paths, and PR numbers from local Git history.

The shared commit parser accepts these user-facing types:

- `feat`
- `fix`
- `improvement`
- `perf`
- `security`

Each new user-facing commit must have a `Changelog: <user impact>` body trailer or a `[user-visible]` subject marker. The marker can override an internal type when the change affects users.

The parser accepts `build`, `chore`, `ci`, `docs`, `refactor`, `test`, and `deps` as internal types. The generator excludes these commits unless the subject has `[user-visible]`.

The pull request guard validates `base.sha..head.sha` for pull requests into `dev-v2`. It does not validate the base commit or old history. Each failure names the commit SHA and the required correction. The generator uses the same parser. Thus, it includes all commits that pass as user-facing.

A `Changelog:` body trailer becomes the entry description. Historical entries can use their existing `User impact:` line. If metadata is absent, the generator creates category-specific copy and flags the entry for follow-up. Each entry retains commit and PR identifiers.

A checkpoint with no included changes has an empty entry list. The generator prints a warning. The UI shows an explicit zero-entry message. This behavior does not block rolling or versioned builds.

## API and UI

`GET /api/changelog` returns the bundled manifest and its match to the running artifact. The route uses normal app authentication.

The `/changelog` page defaults to newest-first checkpoint order. Users can reverse this order, filter entries by change type, and search entry text or source identifiers. The page omits checkpoints with no matching entries while a filter or search is active. It shows a clear empty state when no entries match.

Each checkpoint groups entries by change type. Features appear first. Improvements, fixes, and security changes follow in that order. The page paginates whole checkpoints and does not split one checkpoint across pages. The URL stores the type, search, sort, and page state. A filter, search, or sort change resets the page to the first valid page.

The page labels an unreleased checkpoint `Unreleased`. It keeps the build time, build SHA, build link, pull request links, and commit links available. Entry rows use a compact horizontal layout on wide screens and stack source links on narrow screens.

The client stores the newest displayed checkpoint ID in local storage. The key includes the user ID. The page snapshots unread checkpoints before it updates storage. A replaced unreleased ID marks only the new unreleased checkpoint unread. Promotion recognizes a released checkpoint with the same SHA as already seen.
