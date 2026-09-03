---
name: validating-a-change
description: How to tell a finished change from one that only looks finished in this repository. Use before claiming a change is done, before merging a pull request whose checks are green, and when an e2e row goes red and you need to know whether the change broke it or the machine did.
---

# Validating a change

`make e2e` is the gate. A green pull request is not the same evidence, and a red row is not the same thing as a broken change. Both mistakes are cheap to make and expensive to ship.

## A green pull request covers less than you think

GitHub runs typecheck, the sharded root test sweep, the prose lint, the pull-request description lint, the schema-repair guard, and a remote Postgres pass.

The sharded sweep is `pnpm test`, and the root Vitest config declares five projects: `shared`, `sdk`, `api`, `web`, and the e2e runner's own library. Every other package's suite runs only under `make e2e`.

So green checks say nothing about the engine, the workflow interpreter, `store-postgres`, the sandbox gateway, any `sandbox-*` provider, or any `plugin-*` package. They also skip the code-conventions check, plugin registry drift, the web production build, the api bundle, the helm chart, and every Docker, Kubernetes and CLI row.

Two consequences. Run `make e2e` before you call a change done, whatever the checks say. And when you change a package outside those five, name the suite you ran, because nothing else will run it for you.

```bash
make e2e 2>&1 | tee /tmp/e2e.log
```

Capture the whole scorecard. Piping it through `tail` or `grep` drops the failing rows and forces a second full run to learn what broke.

## A red row is a claim to check, not a verdict

Three rows fail for reasons that have nothing to do with the change under test.

**Docker contention.** The Docker suites share the daemon with any dev stack that is running, including one from another worktree. A row that times out at exactly its limit is the usual sign. Re-run it alone before believing it.

```bash
lsof -nP -iTCP:8788 -iTCP:5173 -sTCP:LISTEN   # is a dev stack competing?
make e2e E2E_ARGS="--only <row-id>"
```

**A missing binary link.** The `cli` row spawns `packages/api/node_modules/.bin/tsx`, which pnpm hoists to the root instead of creating. The row is red on every fresh worktree until you link it.

```bash
ln -sf ../../../../node_modules/.bin/tsx packages/api/node_modules/.bin/tsx
```

**A live cluster.** The `sandbox-k8s` row talks to the local Kubernetes cluster. Its failures usually describe the cluster, not the change.

Rows that skip for a missing credential are not failures. They are coverage you did not get, so say which ones skipped rather than reporting a clean run.

## Compare like for like before blaming a change

When a row stays red in isolation, run the same row at the commit your work started from. A worktree at that commit costs a minute and turns a guess into a fact.

```bash
git worktree add /tmp/baseline <merge-base-sha> --detach
cd /tmp/baseline && pnpm install --frozen-lockfile
make e2e E2E_ARGS="--only <row-id>"
```

Identical failures mean the row was already broken. Different ones mean you own it.

## Before the scorecard

Use Node 22. Run `pnpm install` in a worktree created before a package was added, or its suite fails to resolve the new workspace package.

Run `pnpm typecheck` first, always. It is `tsc --build`, and it emits the `dist` output that `@valet/shared` and `@valet/sdk` resolve through. Vitest cannot import them until it exists, so a fresh worktree fails at file level with a resolution error that looks nothing like a type error.

## When the change touches the database

An in-place edit of `0000_app.sql` reaches a deployed database only through its `SCHEMA_REPAIRS` entry, because the migration tracker skips a `0000` it has already applied. The repair is the deploy path, so test it directly rather than trusting a fresh database.

`packages/api/src/schema/pg-schema.test.ts` is where that lives. It drops each repaired column, re-runs the migrations, and asserts the column returns. A column with a `NOT NULL DEFAULT` needs one assertion more: that existing rows carry the default afterwards rather than being emptied.

```bash
pnpm --filter @valet/api test pg-schema
```

Then wipe the dev database in every worktree that has one, because there is no local backfill path.

```bash
make dev-clean
```

## Saying what you verified

Report the scorecard as it came back. Name the rows that failed and why each one is unrelated, name the rows that skipped and what credential they wanted, and separate what you tested from what you reasoned about. A change verified by argument is not a change verified.
