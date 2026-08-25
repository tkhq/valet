# Building a feature

This is the golden path for building a feature in Valet. Follow it and you get a
change that reviews quickly, survives a reload, and does not strand code in the
wrong package.

Read [placement.md](./placement.md) first if you do not know which package owns
your change. This guide assumes you know, and covers the order to build in.

## Principles

- **Build bottom up.** Types settle, then behavior, then the HTTP surface, then
  the UI. Each layer compiles against a layer that is already finished, so you
  never guess at a shape you are about to change.
- **One shape, one place.** A type the server produces and the browser consumes
  is declared once, on the wire. Two declarations drift, and they drift
  silently, because both sides still compile.
- **The engine stays portable.** It owns the loop and knows nothing about HTTP.
  If your engine change needs a request or a database client, you are placing
  the code too low.
- **Routes wire, packages decide.** A route reads a request, calls something,
  and shapes a response.
- **Verify at the layer you changed.** A targeted suite proves the unit works.
  `make e2e` proves the system still works. You need both, in that order.

## The vertical slice

Most features cut through the stack in the same order.

| Step | You are adding | Package |
| --- | --- | --- |
| 1 | The entity or union both sides use | `shared/src/types/` |
| 2 | Persistence for it | `store-postgres/` + an `engine` contract |
| 3 | Agent behavior that acts on it | `engine/src/` |
| 4 | The response shape the browser reads | `api/src/wire/types.ts` |
| 5 | The route that returns it | `api/src/routes/` + `app.ts` |
| 6 | The data hook and the screen | `web/src/api/`, `web/src/routes/` |

Skip the steps your feature does not need. Do not reorder them. Writing the
route before the wire type means writing the response shape twice.

## 1. Shape the data

Put a cross-package entity in `packages/shared/src/types/` before you use it.
`shared` has no dependencies, so the engine and the api can both import it and
neither owns it. Keep behavior out — types, error classes, and small pure
helpers only.

## 2. Persist it

Valet is pre-1.0, so migrations are edited in place rather than added.

Engine tables live in `packages/store-postgres/migrations/pg/0000_engine.sql` as
raw SQL. When you change one, update the row interface and its `rawTo*Row`
mapper in `packages/store-postgres/src/helpers.ts`. Columns holding bigint
milliseconds arrive from the driver as strings, so they funnel through `toNum`:

```ts
// packages/store-postgres/src/helpers.ts
export function rawToEntryRow(raw: Record<string, unknown>): EntryRow {
  return {
    id: asString(raw.id, "id"),
    sessionId: asString(raw.session_id, "session_id"),
    parts: asStringOrNull(raw.parts, "parts"),
    createdAt: toNum(raw.created_at, "created_at"),   // bigint ms → number
  };
}
```

App tables live in `packages/api/migrations/pg/0000_app.sql`, and also in the
Drizzle schema at `packages/api/src/schema/index.ts`. Both must change together.

After editing either migration, delete the dev database:

```bash
rm -rf ~/.valet/pg
```

This is mandatory, not housekeeping. The migration tracker skips a `0000` it has
already applied, and there is no backfill path, so an edited migration against an
existing data directory leaves a schema that does not match the code. Stop the
api first — it owns `~/.valet/pg`, and PGlite allows exactly one owner.

## 3. Add engine behavior

Engine code owns sessions, threads, the queue, gates, and compaction. Check your
change against the portability rule before you write it: no HTTP, no database
driver, no environment variables.

When the change needs one of those, declare a contract in `engine` and implement
it in the package that owns the outside world:

```ts
// Wrong — engine reaches for a sandbox backend directly.
// packages/engine/src/session.ts
import Docker from "dockerode";
const container = await docker.createContainer({ Image: image });

// Right — engine declares the seam; sandbox-docker implements it.
// packages/engine/src/types.ts
export interface SandboxProvider {
  readonly backend: string;
  capabilities(): SandboxCapabilities;
  create(opts: SandboxCreateOpts): Promise<Sandbox>;
  restore(id: string): Promise<Sandbox>;
  destroy(id: string): Promise<void>;
  status(id: string): Promise<SandboxStatus>;
}
```

`SessionStore` and `SandboxProvider` are the two contracts already doing this.
Providers swap behind them, and shared conformance suites hold every
implementation to the same behavior.

**If your change touches a tool call**, read the tool-call round trip section in
[CLAUDE.md](../../CLAUDE.md#tool-call-persistence-round-trip) before you start.
That path has broken three times, always from shape drift across its four hops,
and the section names the hops and the suites that catch it.

## 4. Declare the wire type

Add the request and response shapes to `packages/api/src/wire/types.ts`. The
browser reaches them through `@valet/api/wire`, one of three exports `api`
publishes.

```ts
// packages/api/src/wire/types.ts
export interface ListModelsResponse {
  models: ModelInfo[];
}
```

Import the type on both sides. Do not copy the shape into `web`, and do not add
an export to `api/package.json` to reach a server module from the browser.

## 5. Write the route

Route files live in `packages/api/src/routes/<area>.ts` and follow a fixed shape.
`routes/models.ts` is the short example to copy:

```ts
/**
 * `/api/models` — the org model catalog. Returns only ACTIVE catalog entries;
 * configured-but-inactive providers are visible in `GET /api/org/llm-providers`
 * (admin CRUD), not here. See `services/model-catalog.ts`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { buildOrgCatalog } from "../services/model-catalog.js";
import type { ListModelsResponse, ModelInfo } from "../wire/types.js";

export const modelsRouter = new Hono<AppEnv>();

modelsRouter.get("/", async (c) => {
  const { db, engineCredentials } = c.var.providers;
  const user = c.var.user;
  const entries = await buildOrgCatalog(db, engineCredentials, user.orgId);
  const models: ModelInfo[] = entries
    .filter((e) => e.active)
    .map(({ resolvable: _resolvable, ...model }) => model);
  const resp: ListModelsResponse = { models };
  return c.json(resp);
});
```

Five conventions are doing work there:

**The header comment.** Every route file opens with a doc comment naming the
path, stating the contract, and linking the design doc. Reviewers read it first,
and so does the next person to touch the file.

**Dependencies come from `c.var.providers`.** Never construct a database client
or a service inside a handler.

**The response is annotated before it is returned.** `const resp:
ListModelsResponse = …` is what turns a drifting response into a compile error
rather than a runtime surprise in the browser:

```ts
// Wrong — nothing checks this against the wire type.
return c.json({ models: entries });

// Right — the annotation is the check.
const resp: ListModelsResponse = { models };
return c.json(resp);
```

**Relative imports end in `.js`.** This holds throughout `packages/api`, which is
ESM — 1802 relative imports carry the extension against a single exception.
`packages/web` is bundled by Vite and does not use it. The rule is per package:

```ts
// packages/api — right
import type { AppEnv } from "../env.js";
// packages/web — right
import { Button } from "../components/button";
```

**The router is mounted in `app.ts`:**

```ts
app.route("/api/models", modelsRouter);
```

Several routers may share a prefix. Three mount under `/api/sessions`, and
several more under `/api/me`, each owning different paths below it. Mount yours
beside its siblings. Order matters only when two patterns can match the same
request: a param or wildcard route shadows a literal sibling registered after
it, so a router declaring `/:id` at its root needs the specific mount above it.

## 6. Build the UI

`packages/web` is Vite, React 19, TanStack Router and Query, Tailwind, and Radix.
Import web's own modules through the `~` alias, which resolves to
`packages/web/src`.

### Data hooks

Data access lives in `src/api/`, and follows a fixed idiom: a query-key factory,
one hook per read, and mutations that invalidate the keys they affect.

```ts
// packages/web/src/api/settings.ts
export const qkSettings = {
  me: () => ["settings", "me"] as const,
  org: () => ["settings", "org"] as const,
  models: () => ["settings", "models"] as const,
};

export function useModels(opts?: UseQueryOptions<ListModelsResponse>) {
  return useQuery<ListModelsResponse>({
    queryKey: qkSettings.models(),
    queryFn: () => api.listModels(),
    staleTime: 60_000,
    ...opts,
  });
}

export function usePatchMe() {
  const qc = useQueryClient();
  return useMutation<PatchMeResponse, Error, PatchMeRequest>({
    mutationFn: (body) => api.patchMe(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.me() });
    },
  });
}
```

Build the key through the factory, never inline. An inline key is the reason a
mutation stops invalidating a read:

```ts
// Wrong — a second spelling of the same key. Invalidation misses it.
useQuery({ queryKey: ["settings", "models"], queryFn: api.listModels });

// Right — one spelling, in one place.
useQuery({ queryKey: qkSettings.models(), queryFn: api.listModels });
```

### Pages

Pages are file-routed. A file in `src/routes/` becomes a URL, and the router
generates `src/routeTree.gen.ts` from that directory. Two consequences:

- Never hand-edit `routeTree.gen.ts`. Rename the route file instead.
- Prefix any non-route file in `routes/` with `-`:

```text
routes/settings.test.tsx     # Wrong — publishes a /settings.test route
routes/-settings.test.tsx    # Right — excluded from the route tree
```

All 20 route tests in the tree use the prefix.

### Tool renderers

Tool renderers are a registry. Add the file, then list it in `index.ts` above the
fallback — order matters and first match wins:

```ts
// packages/web/src/components/session/tool-renderers/index.ts
const RENDERERS: ToolRenderer[] = [
  bashRenderer,
  readRenderer,
  writeRenderer,
  // … add plugin-specific renderers here as the ecosystem grows.
  fallbackRenderer,   // MUST stay last — it matches everything
];
```

A renderer claims tool names by exact string, array, or predicate. One plugin
action can arrive under more than one name — through `call_tool`, or through a
pinned direct tool — and the two shapes put parameters in different places, so a
renderer claiming both has to know which it received.

Optimistic messages must carry the active `threadId`. A null id falls back to
matching that leaks bubbles between threads.

## Extending an existing feature

Most work is not greenfield. The common cases:

**Adding a field to an existing response.** Change `wire/types.ts` first, then
the route that fills it, then the consumer. Typecheck between each step — the
compiler walks you to every call site.

**Adding a route to an existing area.** Add the handler to the existing router
file rather than creating a new one. A new router file means a new mount in
`app.ts`, and mounts that share a prefix are where ordering bugs live.

**Adding a query to an existing screen.** Add a key to the factory and a hook
beside its siblings in the same `src/api/` file. No new file is needed.

```ts
// packages/web/src/api/settings.ts — add the key
export const qkSettings = {
  // …existing keys
  teamMembers: (teamId: string) => ["settings", "teams", teamId, "members"] as const,
};
```

**Adding an action to an existing plugin.** Add it to the manifest's `actions`
array in `src/plugin.ts`. Re-run `make generate-registries` only when you change
`plugin.yaml`, not for a new action inside an existing plugin.

**Changing a stored shape.** Edit the `0000` migration, the row interface, and
the `rawTo*Row` mapper together, then `rm -rf ~/.valet/pg`. Changing one without
the others gives a schema and a mapper that disagree, and the failure surfaces as
a read error far from the edit.

## Testing

Tests sit beside the code they cover, as `<name>.test.ts`. There are 56 next to
the route files alone.

### Route tests

Boot a real api and drive it over HTTP. `bootTestApi` returns a base URL, the
providers, and a `cleanup()` for `afterEach`. It runs on a virtual sandbox
provider, so a route test needs no Docker:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { MeResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/me", () => {
  it("returns the local user with orgRole admin", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeResponse;

    expect(body).toMatchObject({
      id: "local-user",
      orgRole: "admin",
      defaultModel: null,
    });
  });
});
```

Fixtures for the common integrations live in `packages/api/src/test-helpers/`.

### Test each layer

- **Engine behavior** — drive the loop through the in-memory store. No HTTP.
- **Store implementations** — run the shared conformance suite, not a bespoke one.
- **Routes** — `bootTestApi`, assert status and body shape.
- **Web hooks and components** — render with test data, assert what a user sees.

### Assert the value, not its existence

```ts
// Wrong — passes while the UI renders "(empty output)".
expect(result).toBeDefined();

// Right — asserts the text a user actually reads.
expect(resultText(result)).toBe("hello from the sandbox");
```

That first line is the exact assertion that let the tool-call rendering bug ship
three times. If a test needs `(obj as any).privateMethod`, the design is wrong:
extract an exported pure function and test that. Both rules are in
[CLAUDE.md](../../CLAUDE.md#type-safety).

Run a targeted suite while you iterate:

```bash
pnpm --filter @valet/api test models
```

Never put `--` before the filter. Vitest drops the arguments after it and runs
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
a full re-run to see what failed:

```bash
make e2e 2>&1 | tee /tmp/e2e.log
```

A red row is acceptable only when it is environmental — a dead key, a missing
credential — and only when you can name why it is unrelated to your change.
Docker-heavy suites flake under daemon contention when the dev stack is also
running sandboxes, so re-run a red Docker row in isolation before believing it:

```bash
make e2e E2E_ARGS="--only <suite-id>"
```

## Legacy areas

The v1 stack is frozen and slated for deletion: `packages/worker`,
`packages/client`, `packages/runner`, and `backend/`. Worker deploys pin a
specific commit, and `packages/worker` is excluded from the root `pnpm
typecheck`.

| Situation | Action |
| --- | --- |
| Writing new code | Put it in the v2 packages. Never in the frozen ones. |
| Fixing a v1 production bug | Fix in place, keep the change minimal, do not refactor. |
| A v2 feature needs v1 behavior | Reimplement it in the v2 package that should own it. |
| Tempted to extend a v1 deploy script | Do not. Those commands stay as they are. |

Never add a file to a frozen package. Read
[CLAUDE.md](../../CLAUDE.md#what-this-is) for the current split before you touch
anything under those paths.

## Commit and open the PR

Commit per discrete task, with subjects of 72 characters or fewer. When you
change a subsystem, update its spec in `docs/specs/` in the same commit, so the
spec and the code never disagree in the history.

Do not add `Co-Authored-by` trailers naming AI models, in commits, PR
descriptions, or comments.

Write the PR body for someone with no context. Say what the change does and why
it was needed before any detail about how. Keep the prose plain: short
sentences, active voice, no empty intensifiers. The writing rules for this repo
are in [CLAUDE.md](../../CLAUDE.md#writing-asd-ste100) and they cover PR text.

Read your own diff before you push. Remove debugging output, unrelated
formatting, and files you touched but did not mean to change. A reviewer's
attention is finite, and every unrelated line spends some of it.

## Evolving this guide

Edit this file when a convention changes, when an example's path moves — update
it in the same PR — or when a step here proves wrong in practice. Record why, so
the next person does not reintroduce it.
