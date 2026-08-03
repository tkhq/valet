# Task 16 Report: Image resolution walks the source chain

## Status

Complete. All 6 new tests pass. Typecheck clean.

## Changes

### `packages/api/src/engine/resolve-snapshot.ts`

- Added `resolveBaseImage(db, orgId, provider, preflight?)` — queries the
  org's kind='base' `image_sources` row, finds its newest `pushed` bake, and
  runs the same kubernetes pull-preflight gate used by `resolvePrebuildImage`.
- Wired into `resolveSnapshot` via `Promise.all` alongside the existing repo
  bake resolution. When `db` is absent, resolves to null without querying.
- Updated module doc comment to drop the "baseBakeRef hardcoded null" note.

### `packages/api/src/engine/resolve-snapshot.test.ts`

Added a `baseBakeRef` describe block with new cases:

1. Unbound session + pushed base bake → `baseBakeRef` = imageRef.
2. Repo session, no repo bake, base present → `baseBakeRef` set; `computeSpec` image = base ref.
3. Repo bake AND base present → `computeSpec` image = repo bake ref (priority order).
4. Base source with only queued/failed bakes → null.
5. Disabled base source → null.
6. Preflight failure (kubernetes + ECONNREFUSED) → null.
7. Newest pushed bake wins over older pushed bake.
8. `customImage = false` provider → null even with pushed base bake.

Refactored seed helpers: split `seedConfig` into `seedRepoBakeSource`/`seedBaseSource`/`seedBake` so all bake statuses and source kinds can be seeded cleanly. Added `fakeProvider` `backend` parameter to support the kubernetes preflight path.

## Test results

```
src/engine/resolve-snapshot.test.ts  13 tests  PASS
src/engine/sandbox-spec.test.ts      16 tests  PASS
pnpm typecheck                       PASS (clean)
```

The 91 failing tests in the broader suite are pre-existing worktree isolation failures (`Cannot find package '@valet/plugin-github/plugin'`) — no built plugin packages in this worktree — unrelated to this change.

## Mechanism note

From this commit, a new base bake changes every unbound session's desired image. On each session's next prompt, `resolveSnapshot` returns the new `baseBakeRef`, `computeSpec` produces a new image, `specHash` differs from the pod's current hash, and the reconciler replaces the pod. The full rollout mechanism is live end to end.
