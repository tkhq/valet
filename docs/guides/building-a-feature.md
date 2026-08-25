# Building a feature

This is the golden path for adding a feature to Valet. Follow it and you get a
change that reviews quickly, survives a reload, and does not strand code in the
wrong package.

Read [placement.md](./placement.md) first if you do not yet know which package
owns your change. This guide assumes you know, and covers the order to build in.

## Principles

- **Build bottom up.** Types settle first, then behavior, then the HTTP surface,
  then the UI. Each layer compiles against a layer that is already finished, so
  you never guess at a shape you are about to change.
- **One shape, one place.** A type the server produces and the browser consumes
  is defined once, on the wire. Two definitions of one shape drift, and they
  drift silently, because both sides still compile.
- **The engine stays portable.** It owns the loop. It knows nothing about HTTP.
  If your engine change needs a request or a database client, you are placing
  the code too low.
- **Routes wire, packages decide.** A route reads a request, calls something,
  and shapes a response. Business logic belongs below it.
- **Verify at the layer you changed.** A targeted suite tells you the unit
  works. `make e2e` tells you the system still works. You need both, in that
  order.

## The vertical slice

Most features cut through the stack in the same order. The table gives the
sequence and the home for each step.

| Step | You are adding | Package |
| --- | --- | --- |
| 1 | The entity or union both sides use | `shared/src/types/` |
| 2 | Persistence for it | `store-postgres/` + `engine` contract |
| 3 | Agent behavior that acts on it | `engine/src/` |
| 4 | The response shape the browser reads | `api/src/wire/types.ts` |
| 5 | The route that returns it | `api/src/routes/` + `app.ts` |
| 6 | The screen that renders it | `web/src/routes/`, `web/src/components/` |

Skip the steps your feature does not need. Do not reorder them. Writing the
route before the wire type means writing the response shape twice.

## 1. Shape the data

Put a cross-package entity in `packages/shared/src/types/` before you use it.
`shared` has no dependencies, so both the engine and the api can import it, and
neither owns it.

Keep behavior out. `shared` holds types, error classes, and small pure helpers.

## 2. Persist it

Valet is pre-1.0, so migrations are edited in place rather than added:

- Engine tables live in `packages/store-postgres/migrations/pg/0000_engine.sql`.
  They are raw SQL. When you change a table, update the row interface and the
  matching `rawTo*Row` mapper in `packages/store-postgres/src/helpers.ts`.
  Columns holding bigint milliseconds funnel through `toNum`.
- App tables live in `packages/api/migrations/pg/0000_app.sql`, and also in the
  Drizzle schema at `packages/api/src/schema/index.ts`.

After you edit either file, delete the dev database:

```bash
rm -rf ~/.valet/pg
```

This step is mandatory, not housekeeping. The migration tracker skips a `0000`
it has already applied, and there is no backfill path, so an edited migration
against an existing data directory leaves you with a schema that does not match
the code. Stop the api first — it owns `~/.valet/pg`, and PGlite allows exactly
one owner.

## 3. Add engine behavior

Engine code owns sessions, threads, the queue, gates, and compaction. Before you
write it, check the portability rule: no HTTP, no database driver, no
environment variables. When your change needs one of those, express the need as
a contract in `engine` and implement the contract in the package that owns the
outside world, the way `SessionStore` and `SandboxProvider` already do.

If your change touches how a tool call is written, shipped, or rendered, read
the tool-call round trip section in [CLAUDE.md](../../CLAUDE.md#tool-call-persistence-round-trip)
before you start. That path has broken three times, always from shape drift
across the four hops, and the section lists the hops and the suites that catch it.

## 4. Define the wire type

Add the response shape to `packages/api/src/wire/types.ts`. The browser reaches
it through `@valet/api/wire`, which is one of three exports `api` publishes.

Import the type on both sides. Do not copy the shape into `web`, and do not add
an export to `api/package.json` to reach a server module from the browser.

## 5. Write the route

Route files live in `packages/api/src/routes/<area>.ts` and follow a fixed shape.
`packages/api/src/routes/models.ts` is a good short example to copy from:

```ts
/**
 * `/api/models` — one sentence on what this serves, and what it deliberately
 * leaves out. Link the design doc that decided it.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { ListModelsResponse } from "../wire/types.js";

export const modelsRouter = new Hono<AppEnv>();

modelsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const resp: ListModelsResponse = { models: await load(db, user.orgId) };
  return c.json(resp);
});
```

Four conventions are doing work in that example:

- **The header comment.** Every route file opens with a doc comment that names
  the path, states the contract, and links the design doc. Reviewers read it
  first, and so does the next agent to touch the file.
- **Dependencies come from `c.var.providers`.** Do not construct a database
  client or a service inside a handler.
- **The response is typed against the wire, and named.** Annotating `resp`
  before `c.json(resp)` is what makes a drifting response a compile error rather
  than a runtime surprise in the browser.
- **Relative imports end in `.js`.** This holds throughout `packages/api`, which
  is ESM. `packages/web` is bundled by Vite and does not use the extension. The
  rule is per package, and mixing them fails the build.

Mount the router in `packages/api/src/app.ts`:

```ts
app.route("/api/models", modelsRouter);
```

Several routers may share a prefix. Three mount under `/api/sessions`, and
several more under `/api/me`, each owning different paths below it. Mount yours
beside its siblings.

Order only matters when two patterns can match the same request. A param or
wildcard route shadows a literal sibling registered after it, so a router that
declares `/:id` at its root needs the specific mount above it. A router that
declares only concrete paths does not.

## 6. Build the UI

`packages/web` is Vite, React 19, TanStack Router and Query, Tailwind, and Radix.
Import the package's own modules through the `~` alias, which resolves to
`packages/web/src`.

Pages are file-routed. A file in `src/routes/` becomes a URL, and the router
generates `src/routeTree.gen.ts` from that directory. Two consequences follow:

- Never hand-edit `routeTree.gen.ts`. Rename the route file instead.
- Prefix any non-route file in `routes/` with `-`. A test named
  `settings.test.tsx` publishes a `/settings.test` route. Named
  `-settings.test.tsx`, it does not. Every route test in the tree uses the
  prefix.

A new tool renderer is a file in `src/components/session/tool-renderers/`, listed
in that directory's `index.ts` above the fallback entry. Optimistic messages must
carry the active `threadId`; a null id falls back to matching that leaks bubbles
between threads.

## Tests

Tests sit beside the code they cover, as `<name>.test.ts`. There are 56 of them
next to the route files alone.

For a route, boot a real api and drive it over HTTP:

```ts
import { bootTestApi, type TestApi } from "../integration/_setup.js";
```

`bootTestApi` returns a base URL, the providers, and a `cleanup()` to call in
`afterEach`. It runs against a virtual sandbox provider, so a route test needs
no Docker. Fixtures for the common integrations are in `src/test-helpers/`.

Two rules about test quality, both from [CLAUDE.md](../../CLAUDE.md#type-safety):

- Assert the value, not its existence. `expect(result).toBeDefined()` is the
  exact assertion that let the tool-call rendering bug ship three times. Assert
  the text you expect a user to see.
- If a test needs `(obj as any).privateMethod`, the design is wrong. Extract an
  exported pure function and test that.

Run a targeted suite while you iterate:

```bash
pnpm --filter @valet/api test models
```

Do not put `--` before the filter. Vitest drops the arguments after it and runs
the full suite, which looks like a pass and tells you nothing.

## Verify

Work up the ladder. Each rung is cheap relative to the one below it.

```bash
pnpm typecheck                              # all packages
pnpm --filter @valet/<pkg> test <filter>    # the suites you touched
make e2e                                    # the scorecard
```

`make e2e` is the validation, not an optional extra. It loads `.env.e2e`, probes
the daemons and credentials, and runs every suite it can. Get a clean scorecard
before you call the change finished.

Capture the full output. Never pipe it through `tail`, `head`, or `grep` — the
scorecard is small, and a truncated capture drops the failing rows, which forces
a full re-run to see what failed. Use `tee` when you want the log:

```bash
make e2e 2>&1 | tee /tmp/e2e.log
```

A red row is acceptable only when it is environmental — a dead key or a missing
credential — and only when you can name why it is unrelated to your change.
Docker-heavy suites can flake from daemon contention when the dev stack is also
running sandboxes. Re-run a red Docker row in isolation before you treat it as
real:

```bash
make e2e E2E_ARGS="--only <suite-id>"
```

## Commit and open the PR

Commit per discrete task, with subjects of 72 characters or fewer. When you
change a subsystem, update its spec in `docs/specs/` in the same commit, so the
spec and the code never disagree in the history.

Do not add `Co-Authored-by` trailers naming AI models, in commits, PR
descriptions, or comments.

Write the PR body for someone with no context on the change. Say what the change
does and why it was needed, before any detail about how. Keep the prose plain:
short sentences, active voice, and no empty intensifiers. The writing rules for
this repo are in [CLAUDE.md](../../CLAUDE.md#writing-asd-ste100) and they cover
PR text explicitly.

Before you push, read your own diff. Remove debugging output, unrelated
formatting, and files you touched but did not mean to change. A reviewer's
attention is finite, and every unrelated line spends some of it.
