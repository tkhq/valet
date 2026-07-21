<!-- Follow CLAUDE.md → "PR Descriptions": describe the change, not the
     process; never name people; no unrelated context; keep it current as
     the branch evolves; stay short. -->

## What

<!-- The change in a few sentences or bullets: behavior before → after,
     breaking changes, migrations — what a reviewer must know. -->

## Why

<!-- The problem this solves. Link the issue/ticket for provenance. -->

## Test plan

<!-- One line on how this was verified beyond CI is enough. -->

- [ ] CI green
- [ ] New/changed behavior covered by tests

## Checklist

<!-- Delete lines that don't apply. -->

- [ ] D1 schema changes: migration added in `packages/worker/migrations/` + Drizzle schema in `src/lib/schema/`
- [ ] `packages/runner/` or `docker/` changes: `IMAGE_BUILD_VERSION` bumped in `backend/images/base.py`
- [ ] New plugin with actions/channels: `make generate-registries` output committed
- [ ] Frontend changes: `cd packages/client && pnpm build` passes (stricter than typecheck)
- [ ] Subsystem behavior changes: matching spec in `docs/specs/` updated in this PR
