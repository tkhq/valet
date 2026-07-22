# Event System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub and Linear webhooks flow in as normalized durable events that subscriptions route to workflow starts, orchestrator prompts, workflow signals, and an API feed.

**Architecture:** Plugin-level `TriggerDef` contract (already in `@valet/engine`, implemented by `plugin-github`, unconsumed) gains `toEvent()` + a catalog. A public ingest route verifies, normalizes, persists to an `events` table, and matches subscriptions into `event_deliveries` in one transaction. An in-process polling dispatcher (same pattern as `LocalRunHost`) drains deliveries to the four target kinds with retry/backoff.

**Tech Stack:** Hono 4, Drizzle + Postgres (`packages/api`), Vitest with `bootTestApi` integration harness, `@valet/engine` plugin contracts, `@valet/workflow` RunHost.

**Spec:** `docs/specs/2026-07-20-event-system-design.md`. Two amendments made here (Task 10 syncs the spec): (1) dispatcher uses 1s poll + in-process wake nudge instead of LISTEN/NOTIFY — the API is single-process, so a direct nudge is simpler and just as fast; (2) Linear's webhook secret lives in the org `linear` credential's `metadata` (like GitHub's `webhookSecret` lives in the `github_app` credential), so `linear_installations` carries no `webhook_secret_enc` column.

**Conventions reminders:**
- v2 is pre-release: new tables go into the consolidated `packages/api/migrations/pg/0000_app.sql` AND `packages/api/src/schema/index.ts`. No new migration files.
- Timestamps are `bigint` ms (`Date.now()`), ids are `text` (use `randomUUID()`).
- Route tests boot the real app: `bootTestApi` from `src/integration/_setup.js`, auth via `x-valet-test-user-id` header.
- Run tests with `cd packages/api && pnpm vitest run <file>` (engine/plugin packages likewise).
- Commit after every green task.

---

### Task 1: Engine contract — `TriggerDef.toEvent` + catalog

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts` (TriggerDef at line 37, validation ~line 199)
- Modify: `packages/engine/src/index.ts` (exports, ~line 94)
- Test: `packages/engine/src/valet-plugin.test.ts` (extend existing)

- [ ] **Step 1: Write failing tests** for the new shape in `valet-plugin.test.ts`:

```ts
describe("TriggerDef toEvent/catalog validation", () => {
  const validTrigger = {
    id: "github.pull_request",
    service: "github",
    description: "PRs",
    verify: () => null,
    toEvent: () => ({
      key: "github.pull_request.opened",
      dedupeKey: "d1",
      occurredAt: new Date(0).toISOString(),
      refs: {},
      summary: "PR opened",
      payload: {},
    }),
    catalog: [
      {
        key: "github.pull_request.opened",
        description: "A pull request was opened",
        filters: [{ field: "repo", path: "repository.full_name", description: "Repository" }],
      },
    ],
  };

  it("accepts a trigger with toEvent and catalog", () => {
    const issues = validateValetPlugin({ name: "gh", version: "1.0.0", triggers: [validTrigger] });
    expect(issues).toEqual([]);
  });

  it("rejects a trigger missing toEvent", () => {
    const { toEvent: _omit, ...rest } = validTrigger;
    const issues = validateValetPlugin({ name: "gh", version: "1.0.0", triggers: [rest] });
    expect(issues.some((i) => i.path.includes("toEvent"))).toBe(true);
  });

  it("rejects a catalog entry without a key", () => {
    const bad = { ...validTrigger, catalog: [{ description: "x", filters: [] }] };
    const issues = validateValetPlugin({ name: "gh", version: "1.0.0", triggers: [bad] });
    expect(issues.some((i) => i.path.includes("catalog"))).toBe(true);
  });
});
```

Match the existing test file's import style (look at the top of `valet-plugin.test.ts` first; `validateValetPlugin` is exported from `./valet-plugin.js`).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/engine && pnpm vitest run src/valet-plugin.test.ts`
Expected: FAIL (toEvent/catalog not validated; TS errors on the new fields).

- [ ] **Step 3: Implement.** In `valet-plugin.ts`, replace `toSignal` on `TriggerDef` with `toEvent` + `catalog` and add the two new interfaces next to `VerifiedEvent`:

```ts
/** A provider webhook normalized into the generic event pipeline. */
export interface NormalizedEvent {
  /** Namespaced key, e.g. "github.pull_request.opened", "linear.issue.create". */
  key: string;
  /** Provider delivery id — unique per service; makes redelivery idempotent. */
  dedupeKey: string;
  /** ISO timestamp of when the event happened at the provider. */
  occurredAt: string;
  /** External actor, when the payload carries one (enables identity-link attribution). */
  actor?: { externalId: string; login?: string };
  /** Flat scope refs for filtering/display: repo, installation_id, team_id, … */
  refs: Record<string, string>;
  /** One-line human summary (used as the SignalContent body for orchestrator delivery). */
  summary: string;
  /** Raw provider payload. */
  payload: unknown;
}

export interface EventCatalogEntry {
  key: string;
  description: string;
  /** Filterable fields: `field` is the user-facing name, `path` a dot-path into the raw payload. */
  filters: { field: string; path: string; description: string }[];
}

export interface TriggerDef {
  /** e.g. "github.pull_request" */
  id: string;
  service: string;
  description: string;
  verify(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): VerifiedEvent | null | Promise<VerifiedEvent | null>;
  /** Normalize a verified event for the generic event pipeline. */
  toEvent(event: VerifiedEvent): NormalizedEvent;
  /** Subscribable event keys this trigger can emit, with their filterable fields. */
  catalog: EventCatalogEntry[];
}
```

In `validateValetPlugin`, find the block validating each trigger (it checks `verify` / `toSignal` are functions) and replace the `toSignal` check with:

```ts
if (typeof t.toEvent !== "function") {
  issues.push({ path: `${base}.toEvent`, message: "must be a function" });
}
if (!Array.isArray(t.catalog)) {
  issues.push({ path: `${base}.catalog`, message: "must be an array" });
} else {
  for (let j = 0; j < t.catalog.length; j++) {
    const entry = t.catalog[j] as Record<string, unknown>;
    if (typeof entry?.key !== "string" || typeof entry?.description !== "string" || !Array.isArray(entry?.filters)) {
      issues.push({ path: `${base}.catalog[${j}]`, message: "must have key, description, filters[]" });
    }
  }
}
```

(Adapt `base` to whatever path variable the surrounding code uses.) Export `NormalizedEvent` and `EventCatalogEntry` from `packages/engine/src/index.ts` next to `TriggerDef`.

- [ ] **Step 4: Run engine tests + typecheck**

Run: `cd packages/engine && pnpm vitest run src/valet-plugin.test.ts && pnpm typecheck`
Expected: engine tests PASS; `pnpm typecheck` at repo root will FAIL in `plugin-github` (still implements `toSignal`) — that's Task 2. If anything else consumes `toSignal`, grep first: `grep -rn "toSignal" packages/ --include="*.ts" | grep -v test` — as of planning, only `plugin-github/src/triggers.ts` does.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/valet-plugin.ts packages/engine/src/valet-plugin.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): TriggerDef gains toEvent + event catalog, drops toSignal"
```

---

### Task 2: `plugin-github` — implement `toEvent` + catalog

**Files:**
- Modify: `packages/plugin-github/src/triggers.ts`
- Test: `packages/plugin-github/src/triggers.test.ts` (create or extend)

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { githubTriggerDefs } from "./triggers.js";

const prDef = githubTriggerDefs.find((t) => t.id === "github.pull_request")!;

describe("github toEvent", () => {
  it("normalizes a pull_request.opened payload", () => {
    const event = prDef.toEvent({
      eventType: "pull_request",
      deliveryId: "delivery-1",
      payload: {
        action: "opened",
        repository: { full_name: "tkhq/valet" },
        installation: { id: 42 },
        sender: { id: 7, login: "conner" },
        pull_request: { number: 5, title: "Add thing", html_url: "https://github.com/tkhq/valet/pull/5" },
      },
    });
    expect(event.key).toBe("github.pull_request.opened");
    expect(event.dedupeKey).toBe("delivery-1");
    expect(event.refs.repo).toBe("tkhq/valet");
    expect(event.refs.installation_id).toBe("42");
    expect(event.actor).toEqual({ externalId: "7", login: "conner" });
    expect(event.summary).toContain("tkhq/valet");
    expect(event.summary).toContain("pull_request opened");
  });

  it("uses the bare event key when the payload has no action", () => {
    const pushDef = githubTriggerDefs.find((t) => t.id === "github.push")!;
    const event = pushDef.toEvent({ eventType: "push", deliveryId: "d2", payload: { repository: { full_name: "a/b" } } });
    expect(event.key).toBe("github.push");
  });

  it("declares a catalog with repo filter on every def", () => {
    for (const def of githubTriggerDefs) {
      expect(def.catalog.length).toBeGreaterThan(0);
      expect(def.catalog[0].filters.some((f) => f.field === "repo")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/plugin-github && pnpm vitest run src/triggers.test.ts`
Expected: FAIL (`toEvent` does not exist).

- [ ] **Step 3: Implement.** In `triggers.ts`, delete the `toSignal` const and add:

```ts
import type { EventCatalogEntry, NormalizedEvent, TriggerDef, VerifiedEvent } from "@valet/engine";

/** Actions GitHub documents per event family — drives the catalog. Families
 * not listed here (push, create, delete, status, ping) have no `action`. */
const EVENT_ACTIONS: Record<string, string[]> = {
  pull_request: ["opened", "closed", "reopened", "synchronize", "edited", "ready_for_review", "labeled", "unlabeled"],
  issues: ["opened", "closed", "reopened", "edited", "labeled", "unlabeled", "assigned", "unassigned"],
  issue_comment: ["created", "edited", "deleted"],
  release: ["published", "created", "edited", "deleted"],
  workflow_run: ["completed", "requested", "in_progress"],
  check_run: ["completed", "created", "rerequested"],
  check_suite: ["completed", "requested", "rerequested"],
};

const COMMON_FILTERS: EventCatalogEntry["filters"] = [
  { field: "repo", path: "repository.full_name", description: "Repository (owner/name)" },
  { field: "sender", path: "sender.login", description: "GitHub login of the actor" },
];

function catalogFor(eventType: string): EventCatalogEntry[] {
  const actions = EVENT_ACTIONS[eventType];
  if (!actions) {
    return [{ key: `github.${eventType}`, description: `GitHub ${eventType} event`, filters: COMMON_FILTERS }];
  }
  return actions.map((action) => ({
    key: `github.${eventType}.${action}`,
    description: `GitHub ${eventType} ${action}`,
    filters: COMMON_FILTERS,
  }));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function toEvent(event: VerifiedEvent): NormalizedEvent {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const installation = payload.installation as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown> | undefined;

  const refs: Record<string, string> = {};
  const repo = str(repository?.full_name);
  if (repo) refs.repo = repo;
  const installationId = str(installation?.id);
  if (installationId) refs.installation_id = installationId;

  const senderId = str(sender?.id);
  const senderLogin = str(sender?.login);

  const summaryParts = [repo, `${event.eventType}${action ? ` ${action}` : ""}`, senderLogin ? `by ${senderLogin}` : undefined];
  return {
    key: action ? `github.${event.eventType}.${action}` : `github.${event.eventType}`,
    dedupeKey: event.deliveryId,
    occurredAt: new Date().toISOString(),
    actor: senderId ? { externalId: senderId, login: senderLogin } : undefined,
    refs,
    summary: summaryParts.filter(Boolean).join(" — "),
    payload: event.payload,
  };
}

export const githubTriggerDefs: TriggerDef[] = GITHUB_EVENT_TYPES.map((eventType) => ({
  id: `github.${eventType}`,
  service: "github",
  description: `GitHub webhook event: ${eventType}`,
  verify: makeVerify(eventType),
  toEvent,
  catalog: catalogFor(eventType),
}));
```

(`occurredAt` uses receipt time — GitHub payloads don't carry a uniform event timestamp across families; keep it simple.)

- [ ] **Step 4: Run tests + full typecheck**

Run: `cd packages/plugin-github && pnpm vitest run src/triggers.test.ts && cd ../.. && pnpm typecheck`
Expected: PASS, and the repo typechecks again (Task 1's break is resolved).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-github/src/triggers.ts packages/plugin-github/src/triggers.test.ts
git commit -m "feat(plugin-github): normalize webhooks via toEvent + event catalog"
```

---

### Task 3: Schema + migration — events, subscriptions, deliveries, linear_installations

**Files:**
- Modify: `packages/api/src/schema/index.ts` (append after `githubInstallations`)
- Modify: `packages/api/migrations/pg/0000_app.sql` (append after the `github_installations` indexes, ~line 561)
- Test: `packages/api/src/schema/pg-schema.test.ts` (extend — look at how it asserts existing tables and follow suit)

- [ ] **Step 1: Add Drizzle tables** to `schema/index.ts`:

```ts
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    service: text("service").notNull(),
    eventKey: text("event_key").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    actor: jsonb("actor"),
    refs: jsonb("refs").notNull().default({}),
    summary: text("summary").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("events_service_dedupe").on(t.service, t.dedupeKey),
    index("events_org_received").on(t.orgId, t.receivedAt),
    index("events_org_key").on(t.orgId, t.eventKey),
  ],
);

export const eventSubscriptions = pgTable(
  "event_subscriptions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    /** Event key patterns; trailing `.*` wildcard supported (e.g. "github.pull_request.*"). */
    eventKeys: jsonb("event_keys").notNull(),
    /** `{ field, op: "eq"|"in"|"prefix"|"contains", value }[]` over catalog-declared fields. */
    filters: jsonb("filters").notNull().default([]),
    /** `{ kind: "workflow", workflowId } | { kind: "orchestrator" } | { kind: "signal" }`. */
    target: jsonb("target").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("event_subscriptions_org_enabled").on(t.orgId, t.enabled)],
);

export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    status: text("status", { enum: ["pending", "delivered", "failed", "dead"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }).notNull(),
    lastError: text("last_error"),
    deliveredAt: bigint("delivered_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("event_deliveries_due").on(t.status, t.nextAttemptAt),
    index("event_deliveries_event").on(t.eventId),
  ],
);

export const linearInstallations = pgTable(
  "linear_installations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceName: text("workspace_name").notNull(),
    webhookId: text("webhook_id"),
    connectedBy: text("connected_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("linear_installations_org_workspace").on(t.orgId, t.workspaceId)],
);
```

Check the file's existing imports — `uniqueIndex`, `integer`, `boolean`, `jsonb`, `index`, `bigint` are all already imported for other tables; add any that aren't.

- [ ] **Step 2: Append matching DDL** to `0000_app.sql` (verbatim column/index parity with Step 1):

```sql
CREATE TABLE "events" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL,
  "service" text NOT NULL,
  "event_key" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "actor" jsonb,
  "refs" jsonb NOT NULL DEFAULT '{}',
  "summary" text NOT NULL,
  "payload" jsonb NOT NULL,
  "occurred_at" bigint NOT NULL,
  "received_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "events_service_dedupe" ON "events" ("service","dedupe_key");
CREATE INDEX "events_org_received" ON "events" ("org_id","received_at");
CREATE INDEX "events_org_key" ON "events" ("org_id","event_key");

CREATE TABLE "event_subscriptions" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL,
  "owner_type" text NOT NULL,
  "owner_id" text NOT NULL,
  "name" text NOT NULL,
  "event_keys" jsonb NOT NULL,
  "filters" jsonb NOT NULL DEFAULT '[]',
  "target" jsonb NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_by" text NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE INDEX "event_subscriptions_org_enabled" ON "event_subscriptions" ("org_id","enabled");

CREATE TABLE "event_deliveries" (
  "id" text PRIMARY KEY,
  "event_id" text NOT NULL,
  "subscription_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" bigint NOT NULL,
  "last_error" text,
  "delivered_at" bigint,
  "created_at" bigint NOT NULL
);
CREATE INDEX "event_deliveries_due" ON "event_deliveries" ("status","next_attempt_at");
CREATE INDEX "event_deliveries_event" ON "event_deliveries" ("event_id");

CREATE TABLE "linear_installations" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "workspace_name" text NOT NULL,
  "webhook_id" text,
  "connected_by" text NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "linear_installations_org_workspace" ON "linear_installations" ("org_id","workspace_id");
```

- [ ] **Step 3: Run the schema parity test**

Run: `cd packages/api && pnpm vitest run src/schema/pg-schema.test.ts`
Expected: PASS. This test compares the Drizzle schema against the SQL migration — if it flags a mismatch, fix whichever side is wrong. If new tables need explicit registration in the test, follow the pattern used for `github_installations`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/schema/index.ts packages/api/migrations/pg/0000_app.sql
git commit -m "feat(api): event system schema — events, subscriptions, deliveries, linear installations"
```

---

### Task 4: Matching engine (pure module)

**Files:**
- Create: `packages/api/src/events/match.ts`
- Test: `packages/api/src/events/match.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { eventKeyMatches, filtersMatch, resolvePath } from "./match.js";
import type { EventCatalogEntry } from "@valet/engine";

const CATALOG: EventCatalogEntry[] = [
  {
    key: "github.pull_request.opened",
    description: "",
    filters: [
      { field: "repo", path: "repository.full_name", description: "" },
      { field: "sender", path: "sender.login", description: "" },
    ],
  },
];

describe("eventKeyMatches", () => {
  it("matches exact keys", () => {
    expect(eventKeyMatches("github.pull_request.opened", ["github.pull_request.opened"])).toBe(true);
  });
  it("matches trailing wildcards", () => {
    expect(eventKeyMatches("github.pull_request.opened", ["github.pull_request.*"])).toBe(true);
    expect(eventKeyMatches("github.pull_request.opened", ["github.*"])).toBe(true);
  });
  it("rejects non-matches and non-boundary wildcard prefixes", () => {
    expect(eventKeyMatches("github.push", ["github.pull_request.*"])).toBe(false);
    expect(eventKeyMatches("github.pull_request_review.opened", ["github.pull_request.*"])).toBe(false);
  });
});

describe("resolvePath", () => {
  it("walks dot paths", () => {
    expect(resolvePath({ repository: { full_name: "a/b" } }, "repository.full_name")).toBe("a/b");
  });
  it("returns undefined for missing segments", () => {
    expect(resolvePath({ repository: {} }, "repository.full_name")).toBeUndefined();
  });
});

describe("filtersMatch", () => {
  const payload = { repository: { full_name: "tkhq/valet" }, sender: { login: "conner" } };
  it("eq", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "eq", value: "tkhq/valet" }], CATALOG)).toBe(true);
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "eq", value: "other/x" }], CATALOG)).toBe(false);
  });
  it("in", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "in", value: ["a/b", "tkhq/valet"] }], CATALOG)).toBe(true);
  });
  it("prefix and contains", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "prefix", value: "tkhq/" }], CATALOG)).toBe(true);
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "sender", op: "contains", value: "onne" }], CATALOG)).toBe(true);
  });
  it("unknown field never matches", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "nope", op: "eq", value: "x" }], CATALOG)).toBe(false);
  });
  it("empty filter list always matches", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [], CATALOG)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/api && pnpm vitest run src/events/match.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `match.ts`**

```ts
/**
 * Pure subscription-matching primitives for the event system. No IO — the
 * ingest transaction and the subscriptions CRUD validator both call these.
 */
import type { EventCatalogEntry } from "@valet/engine";

export interface SubscriptionFilter {
  field: string;
  op: "eq" | "in" | "prefix" | "contains";
  value: string | string[];
}

/** Trailing-wildcard key match: "github.pull_request.*" matches
 * "github.pull_request.opened" but not "github.pull_request_review.x" —
 * the wildcard only crosses a `.` boundary. */
export function eventKeyMatches(eventKey: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === eventKey) return true;
    if (pattern.endsWith(".*")) return eventKey.startsWith(pattern.slice(0, -1));
    return false;
  });
}

export function resolvePath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const segment of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

export function filtersMatch(
  payload: unknown,
  eventKey: string,
  filters: SubscriptionFilter[],
  catalog: EventCatalogEntry[],
): boolean {
  if (filters.length === 0) return true;
  const entry = catalog.find((e) => e.key === eventKey);
  return filters.every((filter) => {
    const declared = entry?.filters.find((f) => f.field === filter.field);
    if (!declared) return false;
    const actual = asString(resolvePath(payload, declared.path));
    if (actual === undefined) return false;
    switch (filter.op) {
      case "eq":
        return actual === filter.value;
      case "in":
        return Array.isArray(filter.value) && filter.value.includes(actual);
      case "prefix":
        return typeof filter.value === "string" && actual.startsWith(filter.value);
      case "contains":
        return typeof filter.value === "string" && actual.includes(filter.value);
    }
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/api && pnpm vitest run src/events/match.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/events/match.ts packages/api/src/events/match.test.ts
git commit -m "feat(api): pure event-subscription matching engine"
```

---

### Task 5: Ingest service + public webhook route + GitHub forwarding

**Files:**
- Create: `packages/api/src/events/ingest.ts`
- Create: `packages/api/src/routes/event-webhooks.ts`
- Modify: `packages/api/src/routes/github-app.ts` (webhook POST handler, end of file)
- Modify: `packages/api/src/app.ts` (mount public route next to `/webhooks/github-app`, ~line 108)
- Test: `packages/api/src/routes/event-webhooks.test.ts`

**Design notes:**
- Generic route: `POST /webhooks/events/:service`. For launch only `linear` arrives here; GitHub keeps its existing App webhook URL and `github-app.ts` forwards non-installation events into the same ingest function. One dedupe path, two front doors.
- Org + secret resolution is per-service and happens in the route/forwarder BEFORE calling the plugin's `verify()`:
  - GitHub (forwarder): org already resolved by `findGithubAppOrgId`; signature already verified by the route; the forwarder calls `ingestVerifiedEvent` directly with a `VerifiedEvent` it builds from the parsed payload + `x-github-event` + `x-github-delivery` headers.
  - Linear: peek `organizationId` from the JSON body → `linear_installations` row → org; webhook secret from the org `linear` credential `metadata.webhookSecret`; then run the plugin `verify()` over the raw bytes.
- Ingest inserts the event and its matched deliveries in one transaction, then nudges the dispatcher (`deps.onIngest?.()`).

- [ ] **Step 1: Implement `ingest.ts`** (write tests in Step 2 against the route — the service is exercised through it, plus a unit test for dedupe):

```ts
/**
 * Event ingest: NormalizedEvent -> events row + matched event_deliveries
 * rows, one transaction. Callers (generic webhook route, github-app
 * forwarder) handle org resolution and signature verification first.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { EventCatalogEntry, NormalizedEvent, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions } from "../schema/index.js";
import { eventKeyMatches, filtersMatch, type SubscriptionFilter } from "./match.js";

export interface IngestDeps {
  db: AppDb;
  plugins: ValetPlugin[];
  /** In-process dispatcher nudge; wired in main.ts. */
  onIngest?: () => void;
}

export function catalogForService(plugins: ValetPlugin[], service: string): EventCatalogEntry[] {
  return plugins
    .flatMap((p) => p.triggers ?? [])
    .filter((t) => t.service === service)
    .flatMap((t) => t.catalog);
}

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
  deliveries: number;
}

export async function ingestEvent(
  deps: IngestDeps,
  args: { orgId: string; service: string; event: NormalizedEvent },
): Promise<IngestResult> {
  const { orgId, service, event } = args;
  const now = Date.now();
  const eventId = randomUUID();
  const catalog = catalogForService(deps.plugins, service);

  const result = await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(events)
      .values({
        id: eventId,
        orgId,
        service,
        eventKey: event.key,
        dedupeKey: event.dedupeKey,
        actor: event.actor ?? null,
        refs: event.refs,
        summary: event.summary,
        payload: event.payload,
        occurredAt: Date.parse(event.occurredAt) || now,
        receivedAt: now,
      })
      .onConflictDoNothing({ target: [events.service, events.dedupeKey] })
      .returning({ id: events.id });
    if (inserted.length === 0) return { eventId, duplicate: true, deliveries: 0 };

    const subs = await tx
      .select()
      .from(eventSubscriptions)
      .where(and(eq(eventSubscriptions.orgId, orgId), eq(eventSubscriptions.enabled, true)));

    const matched = subs.filter(
      (sub) =>
        eventKeyMatches(event.key, sub.eventKeys as string[]) &&
        filtersMatch(event.payload, event.key, sub.filters as SubscriptionFilter[], catalog),
    );
    if (matched.length > 0) {
      await tx.insert(eventDeliveries).values(
        matched.map((sub) => ({
          id: randomUUID(),
          eventId,
          subscriptionId: sub.id,
          status: "pending" as const,
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
        })),
      );
    }
    return { eventId, duplicate: false, deliveries: matched.length };
  });

  if (!result.duplicate && result.deliveries > 0) deps.onIngest?.();
  return result;
}
```

Verify the Drizzle transaction API in use: `grep -rn "\.transaction(" packages/api/src/ | grep -v test | head -3` — mirror whatever pattern exists (if none, use the drizzle `db.transaction(async (tx) => ...)` form and confirm `AppDb` exposes it; otherwise fall back to sequential inserts with the unique index providing dedupe safety, and note it).

- [ ] **Step 2: Write failing route tests** (`event-webhooks.test.ts`). Follow `github-app.test.ts` harness style (`bootTestApi`, afterEach cleanup). Cases:

```ts
// Helper: sign a Linear body the way plugin-linear will verify it (HMAC-SHA256 hex over raw body).
function linearSig(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

it("ingests a signed linear webhook: event row + matched delivery row", async () => {
  api = await bootTestApi();
  // Seed: org linear credential with metadata.webhookSecret + linear_installations row
  // + an enabled event_subscriptions row for ["linear.issue.create"] targeting {kind:"orchestrator"}.
  // Seed directly through api.db (drizzle) — see how github-app.test.ts seeds credentials.
  const body = JSON.stringify({
    action: "create", type: "Issue", organizationId: "lin-org-1",
    webhookTimestamp: Date.now(),
    data: { id: "iss-1", identifier: "TKAI-1", title: "Bug", team: { key: "TKAI" } },
    webhookId: "wh-1", createdAt: new Date().toISOString(),
  });
  const res = await fetch(`${api.baseUrl}/webhooks/events/linear`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Linear-Signature": linearSig(body, "test-secret"), "Linear-Delivery": "del-1" },
    body,
  });
  expect(res.status).toBe(204);
  // assert events row exists with event_key "linear.issue.create" and one pending delivery
});

it("replays are deduped (same delivery id -> 204, no second row)", async () => { /* POST twice, count rows == 1 */ });
it("bad signature -> 403 + event_drop_log row with reason bad_signature", async () => { /* tamper sig */ });
it("unknown organizationId -> 204 no-op + drop log reason unknown_org", async () => { /* no installation row */ });
it("unknown service -> 404", async () => { /* POST /webhooks/events/nope */ });
```

Flesh each stub into a full test — the comments above state the exact assertions. Note: these tests depend on `plugin-linear`'s trigger defs (Task 8). **Write the tests now, run them, and expect the linear-specific ones to fail until Task 8; the dedupe/404/drop-log mechanics can be tested against the github forwarder instead if you prefer strict green-per-task — in that case port the linear cases into Task 8's test run.** Simplest sequencing: implement Task 8 (pure plugin code, no API dependencies) before this task's tests go green — the task order below stays as written, just run this file again after Task 8 and require green then.

- [ ] **Step 3: Implement the route** (`routes/event-webhooks.ts`):

```ts
/**
 * PUBLIC generic event-webhook ingress: POST /webhooks/events/:service.
 * Auth is signature-level per service (plugin TriggerDef.verify over raw
 * bytes) — mounted before the auth middleware in app.ts.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { VerifiedEvent } from "@valet/engine";
import type { AppEnv } from "./types.js"; // adjust: use the same AppEnv import github-app.ts uses
import { linearInstallations } from "../schema/index.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { ingestEvent } from "../events/ingest.js";

const MAX_BODY_BYTES = 1024 * 1024;

export const eventWebhooksRouter = new Hono<AppEnv>();

eventWebhooksRouter.post("/:service", async (c) => {
  const service = c.req.param("service");
  const { db, plugins, engineCredentials } = c.var.providers;

  const triggerDefs = plugins.flatMap((p) => p.triggers ?? []).filter((t) => t.service === service);
  if (triggerDefs.length === 0) return c.json({ error: "unknown service" }, 404);

  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);

  // Per-service org + secret resolution. Only linear ships in this plan;
  // add a branch per future service that lands here.
  let orgId: string | null = null;
  let secrets: Record<string, string> = {};
  if (service === "linear") {
    let organizationId: string | undefined;
    try {
      const peek = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
      organizationId = typeof peek.organizationId === "string" ? peek.organizationId : undefined;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!organizationId) return c.body(null, 204);
    const rows = await db
      .select()
      .from(linearInstallations)
      .where(eq(linearInstallations.workspaceId, organizationId))
      .limit(1);
    const install = rows[0];
    if (!install) return c.body(null, 204); // unknown workspace: ack, don't retry-loop Linear
    orgId = install.orgId;
    const cred = await engineCredentials.get({ type: "org", id: orgId }, "linear");
    const webhookSecret = typeof cred?.metadata?.webhookSecret === "string" ? cred.metadata.webhookSecret : undefined;
    if (!webhookSecret) {
      await writeDropLog(db, { orgId, reason: "unknown_org", detail: `linear webhook for ${organizationId}: no credential` });
      return c.body(null, 204);
    }
    secrets = { webhookSecret };
  } else {
    return c.json({ error: "unknown service" }, 404);
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => (headers[k] = v));

  let verified: VerifiedEvent | null = null;
  for (const def of triggerDefs) {
    verified = await def.verify({ headers, rawBody }, secrets);
    if (verified) {
      await ingestEvent({ db, plugins, onIngest: undefined /* Task 6 wires providers.eventDispatcher.nudge */ }, {
        orgId,
        service,
        event: def.toEvent(verified),
      });
      return c.body(null, 204);
    }
  }

  await writeDropLog(db, { orgId, reason: "bad_signature", detail: `service=${service}` });
  return c.json({ error: "signature verification failed" }, 403);
});
```

Adjust the two unknowns against reality: (a) the `AppEnv` import — copy whatever `routes/github-app.ts` line ~66 uses; (b) `eventIngest` on providers doesn't exist yet — Task 6 adds `eventDispatcher` to `Providers`; until then pass `onIngest: undefined` and wire the nudge in Task 6. Mount in `app.ts` directly under the github-app webhook mount:

```ts
app.route("/webhooks/events", eventWebhooksRouter);
```

with a comment mirroring the github-app one ("PUBLIC — signature-level auth inside the router").

- [ ] **Step 4: GitHub forwarding.** In `github-app.ts`'s webhook POST handler, replace the trailing comment `// Every other event type: acknowledged, ignored.` with:

```ts
} else if (event && event !== "ping") {
  // Forward every other event family into the generic event pipeline.
  // Signature + org are already verified above; build the VerifiedEvent
  // directly instead of re-running TriggerDef.verify.
  const deliveryId = c.req.header("x-github-delivery");
  const def = c.var.providers.plugins
    .flatMap((p) => p.triggers ?? [])
    .find((t) => t.service === "github" && t.id === `github.${event}`);
  if (def && deliveryId) {
    await ingestEvent(
      { db, plugins: c.var.providers.plugins, onIngest: undefined /* Task 6 wires the nudge */ },
      { orgId, service: "github", event: def.toEvent({ eventType: event, deliveryId, payload }) },
    );
  }
}
return c.body(null, 204);
```

- [ ] **Step 5: Run tests**

Run: `cd packages/api && pnpm vitest run src/routes/event-webhooks.test.ts src/routes/github-app.test.ts && pnpm typecheck`
Expected: github-app suite stays green; event-webhooks linear cases red until Task 8 (see Step 2 note). Add one github-forwarding case to `github-app.test.ts`: POST a signed `pull_request` webhook, assert an `events` row with key `github.pull_request.opened` appears. That one must be GREEN now.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/events/ingest.ts packages/api/src/routes/event-webhooks.ts packages/api/src/routes/event-webhooks.test.ts packages/api/src/routes/github-app.ts packages/api/src/routes/github-app.test.ts packages/api/src/app.ts
git commit -m "feat(api): generic event ingest — webhook route, tx-scoped matching, github forwarding"
```

---

### Task 6: Dispatcher + delivery targets + `'event'` trigger type

**Files:**
- Modify: `packages/workflow/src/dag/shape.ts:59` (add `'event'` to the trigger union)
- Create: `packages/api/src/events/dispatcher.ts`
- Modify: `packages/api/src/providers/types.ts` (add `eventDispatcher`)
- Modify: `packages/api/src/main.ts` (build + start/stop alongside `workflowRunHost` — grep `startHost()` to find the spot)
- Modify: `packages/api/src/routes/event-webhooks.ts` + `github-app.ts` (wire `onIngest: providers.eventDispatcher.nudge`)
- Test: `packages/api/src/events/dispatcher.test.ts`

- [ ] **Step 1: Trigger union.** In `packages/workflow/src/dag/shape.ts`:

```ts
type: 'manual' | 'schedule' | 'webhook' | 'event';
```

Run `pnpm typecheck` — nothing narrows on the union exhaustively today, but fix any fallout.

- [ ] **Step 2: Write failing dispatcher tests.** Drive the dispatcher's `pollOnce()` directly (no timers) against a booted test API's db + fakes:

```ts
// Cases (full code required in implementation — these are the behaviors):
it("delivers a workflow-target delivery: RunHost.start called with type:'event' payload; row -> delivered");
it("delivers an orchestrator-target delivery: submitPrompt called with SignalContent (signalType = event key); row -> delivered");
it("signal target: inserts workflow_signals rows for org runs parked on event:<key> and wakes them");
it("failure increments attempts, sets next_attempt_at per backoff, records last_error");
it("5th failure marks the delivery dead");
it("claimed rows are skipped by a concurrent pollOnce (FOR UPDATE SKIP LOCKED)");
```

For fakes: `RunHost` is an interface — a recording fake `{ start: vi.fn(), ... }` suffices. For the orchestrator target, fake at the dispatcher's dependency seam (see `deliverToOrchestrator` dep below) rather than booting a real engine session.

- [ ] **Step 3: Implement `dispatcher.ts`**

```ts
/**
 * Drains event_deliveries. Same lifecycle pattern as LocalRunHost: a poll
 * loop (1s) that the ingest path nudges in-process via nudge() so the
 * interval is a staleness floor, not the delivery path.
 */
import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import type { RunHost, WorkflowStore } from "@valet/workflow";
import type { SignalContent, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions, workflowRuns } from "../schema/index.js";

const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000]; // then dead
const POLL_MS = 1_000;
const BATCH = 20;

export interface OrchestratorDeliverFn {
  (args: { orgId: string; ownerType: "user" | "org"; ownerId: string; signal: SignalContent; dispatchId: string }): Promise<void>;
}

export interface EventDispatcherDeps {
  db: AppDb;
  workflowRunHost: RunHost;
  workflowStore: WorkflowStore;
  /** Seam over ensureOrchestratorSession + thread.submitPrompt (impl below). */
  deliverToOrchestrator: OrchestratorDeliverFn;
}

export class EventDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  constructor(private readonly deps: EventDispatcherDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.pollOnce(), POLL_MS);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.draining) await new Promise((r) => setTimeout(r, 25));
  }
  /** In-process nudge from the ingest path. */
  nudge = (): void => {
    void this.pollOnce();
  };

  async pollOnce(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const now = Date.now();
      // Claim due deliveries. drizzle lacks SKIP LOCKED sugar on this
      // version — use sql`` for the claim (verify: grep "for update" -ri packages/api/src).
      const claimed = await this.deps.db.execute(sql`
        SELECT id FROM event_deliveries
        WHERE status IN ('pending','failed') AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at ASC
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      `);
      for (const row of claimed.rows as { id: string }[]) {
        await this.deliverOne(row.id).catch((err) => console.error("event dispatch:", err));
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliverOne(deliveryId: string): Promise<void> {
    const { db } = this.deps;
    const [delivery] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.id, deliveryId)).limit(1);
    if (!delivery || delivery.status === "delivered" || delivery.status === "dead") return;
    const [event] = await db.select().from(events).where(eq(events.id, delivery.eventId)).limit(1);
    const [sub] = await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, delivery.subscriptionId)).limit(1);
    if (!event || !sub) {
      await db.update(eventDeliveries).set({ status: "dead", lastError: "event or subscription vanished" }).where(eq(eventDeliveries.id, deliveryId));
      return;
    }

    try {
      const target = sub.target as { kind: string; workflowId?: string };
      if (target.kind === "workflow" && target.workflowId) {
        await this.startWorkflow(target.workflowId, sub.id, event);
      } else if (target.kind === "orchestrator") {
        await this.deps.deliverToOrchestrator({
          orgId: event.orgId,
          ownerType: sub.ownerType,
          ownerId: sub.ownerId,
          signal: {
            kind: "signal",
            signalType: event.eventKey,
            body: `${event.summary}\n\n${JSON.stringify(event.payload).slice(0, 4000)}`,
            attributes: { eventId: event.id, service: event.service, ...(event.refs as Record<string, string>) },
          },
          dispatchId: `event:${delivery.id}`,
        });
      } else if (target.kind === "signal") {
        await this.signalParkedRuns(event);
      } else {
        throw new Error(`unknown target kind: ${target.kind}`);
      }
      await db
        .update(eventDeliveries)
        .set({ status: "delivered", deliveredAt: Date.now(), attempts: delivery.attempts + 1 })
        .where(eq(eventDeliveries.id, deliveryId));
    } catch (err) {
      const attempts = delivery.attempts + 1;
      const backoff = BACKOFF_MS[attempts - 1];
      await db
        .update(eventDeliveries)
        .set({
          status: backoff === undefined ? "dead" : "failed",
          attempts,
          nextAttemptAt: backoff === undefined ? delivery.nextAttemptAt : Date.now() + backoff,
          lastError: String(err).slice(0, 2000),
        })
        .where(eq(eventDeliveries.id, deliveryId));
    }
  }

  private async startWorkflow(workflowId: string, subscriptionId: string, event: typeof events.$inferSelect): Promise<void> {
    // Mirror routes/workflows.ts POST /:id/runs — same run id scheme, same
    // owner resolution from workflow_definitions.
    // trigger payload:
    // { type: 'event', triggerId: subscriptionId, timestamp: new Date(event.occurredAt).toISOString(),
    //   data: { key: event.eventKey, summary: event.summary, refs: event.refs, payload: event.payload },
    //   metadata: { eventId: event.id, service: event.service } }
    // Read that route before implementing and reuse its helpers (definitionVersionId, RunParams shape).
  }

  private async signalParkedRuns(event: typeof events.$inferSelect): Promise<void> {
    const signalType = `event:${event.eventKey}`;
    // Parked runs waiting on this signal type, same org (owner_type/owner_id
    // scoping is per-run; org scoping via the workflow definition join).
    const rows = await this.deps.db.execute(sql`
      SELECT r.id FROM workflow_runs r
      JOIN workflow_definitions d ON d.id = r.workflow_id
      WHERE d.org_id = ${event.orgId}
        AND r.status = 'parked'
        AND r.waiting_on @> ${JSON.stringify([{ kind: "signal", signalType }])}::jsonb
    `);
    for (const row of rows.rows as { id: string }[]) {
      await this.deps.workflowStore.insertSignal({
        runId: row.id,
        signalId: `event:${event.id}:${row.id}`,
        signalType,
        payload: { key: event.eventKey, summary: event.summary, refs: event.refs, payload: event.payload },
        createdAt: Date.now(),
      });
      await this.deps.workflowRunHost.wake(row.id);
    }
  }
}
```

Two things to verify while implementing (adjust, don't guess): (a) `db.execute(sql\`...\`)` result shape (`.rows` vs array — grep an existing `execute(` call); (b) `RunHost.wake` exact name/signature in `packages/workflow/src/local-host.ts` (~line 63 interface). The `waiting_on @> ...` containment works because parked runs store `[{kind:'signal',nodeId,signalType,timeoutAt}]` — containment on a partial object matches; confirm with one of the approval tests' fixtures.

`deliverToOrchestrator` implementation (in `main.ts` or a small `events/orchestrator-target.ts`):

```ts
import { ensureOrchestratorSession } from "./orchestrator/ensure.js";

const deliverToOrchestrator: OrchestratorDeliverFn = async ({ orgId, ownerType, ownerId, signal, dispatchId }) => {
  const { session } = await ensureOrchestratorSession(
    { db: providers.db, engineHost: providers.engineHost },
    { type: ownerType, id: ownerId },
    { actorUserId: ownerId, orgId },
  );
  await session.thread("events").submitPrompt(signal, { dispatchId });
};
```

Check `ensureOrchestratorSession`'s exact options object against `channels/host.ts:565` and whether `{ type: "org", id: orgId }` is the org-orchestrator form (grep `orchestrator:org` in `packages/api/src/orchestrator/`).

- [ ] **Step 4: Wire providers + lifecycle.** Add to `Providers`:

```ts
/** Event-delivery drain loop; start()/stop() called from main.ts, nudge() from the ingest path. */
eventDispatcher: EventDispatcher;
```

Build it in `main.ts` where `workflowRunHost` is built, call `.start()`/`.stop()` alongside `startHost()`/`stopHost()`, and replace the two `onIngest: undefined` placeholders from Task 5 with `providers.eventDispatcher.nudge`. Also update the test bootstrapping if `bootTestApi` constructs providers separately (grep `workflowRunHost` in `src/integration/_setup.ts` and mirror).

- [ ] **Step 5: Run tests**

Run: `cd packages/api && pnpm vitest run src/events/dispatcher.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow/src/dag/shape.ts packages/api/src/events/dispatcher.ts packages/api/src/events/dispatcher.test.ts packages/api/src/providers/types.ts packages/api/src/main.ts packages/api/src/routes/event-webhooks.ts packages/api/src/routes/github-app.ts
git commit -m "feat(api): event dispatcher — workflow/orchestrator/signal targets with retry"
```

---

### Task 7: API routes — catalog, event feed, subscriptions CRUD

**Files:**
- Create: `packages/api/src/routes/events.ts`
- Modify: `packages/api/src/app.ts` (mount `/api/events` after auth middleware, next to `/api/workflows`)
- Test: `packages/api/src/routes/events.test.ts`

- [ ] **Step 1: Write failing route tests** (full assertions; `bootTestApi` + `x-valet-test-user-id` header like `workflows.test.ts`):

```ts
// GET /api/events/catalog — returns merged plugin catalogs, grouped by service:
//   [{ service: "github", entries: [{key, description, filters}, ...] }, ...]
// POST /api/event-subscriptions — 201 on valid body; validates:
//   - eventKeys non-empty, every key/pattern resolves against the catalog (wildcards: prefix must match >=1 entry)
//   - filters reference declared fields for at least one matched catalog entry
//   - target.kind in {workflow, orchestrator, signal}; workflow requires an owned workflowId
//   400 with a message naming the bad key/field otherwise
// GET /api/event-subscriptions — lists org subscriptions
// PATCH /api/event-subscriptions/:id — toggles enabled, updates filters/name
// DELETE /api/event-subscriptions/:id — 204; row gone
// GET /api/events?service=&key=&limit= — newest-first feed, org-scoped
// GET /api/events/:id — event + its deliveries (status, attempts, lastError)
```

Write each as a real test with seeded rows and exact status/body assertions — the comment block above is the behavior contract, not the test code.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/api && pnpm vitest run src/routes/events.test.ts`
Expected: FAIL (404s — router not mounted).

- [ ] **Step 3: Implement `routes/events.ts`.** One router, mounted at `/api`; sub-paths `/events`, `/events/catalog`, `/events/:id`, `/event-subscriptions...`. Key excerpts:

```ts
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AppEnv } from "./types.js"; // same import github-app.ts uses
import { eventDeliveries, events, eventSubscriptions, workflowDefinitions } from "../schema/index.js";
import { catalogForService } from "../events/ingest.js";
import type { SubscriptionFilter } from "../events/match.js";

export const eventsRouter = new Hono<AppEnv>();

eventsRouter.get("/events/catalog", (c) => {
  const { plugins } = c.var.providers;
  const services = [...new Set(plugins.flatMap((p) => p.triggers ?? []).map((t) => t.service))];
  return c.json({
    services: services.map((service) => ({ service, entries: catalogForService(plugins, service) })),
  });
});

// Subscription validation helper (also used by PATCH):
function validateSubscription(
  plugins: ValetPlugin[],
  body: { eventKeys: string[]; filters: SubscriptionFilter[]; target: { kind: string; workflowId?: string } },
): string | null {
  const allEntries = plugins.flatMap((p) => p.triggers ?? []).flatMap((t) => t.catalog);
  if (!Array.isArray(body.eventKeys) || body.eventKeys.length === 0) return "eventKeys must be non-empty";
  for (const pattern of body.eventKeys) {
    const matches = pattern.endsWith(".*")
      ? allEntries.some((e) => e.key.startsWith(pattern.slice(0, -1)))
      : allEntries.some((e) => e.key === pattern);
    if (!matches) return `unknown event key: ${pattern}`;
  }
  for (const f of body.filters ?? []) {
    const declared = allEntries.some((e) => e.filters.some((cf) => cf.field === f.field));
    if (!declared) return `unknown filter field: ${f.field}`;
    if (!["eq", "in", "prefix", "contains"].includes(f.op)) return `unknown filter op: ${f.op}`;
  }
  if (!["workflow", "orchestrator", "signal"].includes(body.target?.kind)) return "unknown target kind";
  if (body.target.kind === "workflow" && !body.target.workflowId) return "workflow target requires workflowId";
  return null;
}
```

POST resolves the caller's org the same way `workflows.ts` does (grep how it derives `orgId` from `c.var.user`), verifies workflow targets exist and belong to the org (`workflowDefinitions` lookup), writes `ownerType: "user", ownerId: user.id` (org-orchestrator targets: `ownerType: "org"` when `body.target.orchestrator === "org"` — accept an optional `target.orchestrator: "user" | "org"`, default `"user"`). Feed endpoints are straight org-scoped selects with `desc(events.receivedAt)`, `limit` capped at 100; `GET /events/:id` joins deliveries by `eventId`.

Mount in `app.ts` after auth: `app.route("/api", eventsRouter);` — mounted at `/api` (not `/api/events`) because the router carries both `/events` and `/event-subscriptions` path families. Place it after the more-specific routers to avoid shadowing.

- [ ] **Step 4: Run tests + typecheck; fix; re-run to green.**

Run: `cd packages/api && pnpm vitest run src/routes/events.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/events.ts packages/api/src/routes/events.test.ts packages/api/src/app.ts
git commit -m "feat(api): event feed, catalog, and subscription CRUD routes"
```

---

### Task 8: `plugin-linear` triggers

**Files:**
- Create: `packages/plugin-linear/src/triggers.ts`
- Modify: `packages/plugin-linear/src/plugin.ts` (add `triggers: linearTriggerDefs`)
- Test: `packages/plugin-linear/src/triggers.test.ts`

**Linear webhook facts** (verify against https://linear.app/developers/webhooks while implementing):
- Signature: `Linear-Signature` header = HMAC-SHA256 hex over the raw body.
- Replay guard: payload carries `webhookTimestamp` (ms) — reject if `|now - webhookTimestamp| > 60_000`.
- Delivery id: `Linear-Delivery` header (UUID per delivery).
- Payload shape: `{ action: "create"|"update"|"remove", type: "Issue"|"Comment"|"Project"|"Cycle"|"IssueLabel"|"Reaction", organizationId, data: {...}, updatedFrom?, url?, createdAt }`.

- [ ] **Step 1: Write failing tests**

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { linearTriggerDefs } from "./triggers.js";

const issueDef = linearTriggerDefs.find((t) => t.id === "linear.issue")!;
const SECRET = "test-secret";

function makeReq(payload: Record<string, unknown>, secret = SECRET) {
  const body = JSON.stringify({ webhookTimestamp: Date.now(), ...payload });
  const rawBody = new TextEncoder().encode(body);
  const sig = createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex");
  return { headers: { "linear-signature": sig, "linear-delivery": "del-1" }, rawBody };
}

describe("linear verify", () => {
  const payload = { action: "create", type: "Issue", organizationId: "org-1", data: { id: "i1", identifier: "TKAI-9", title: "Bug", team: { key: "TKAI" }, creatorId: "u-1" } };

  it("accepts a correctly signed fresh delivery", async () => {
    const verified = await issueDef.verify(makeReq(payload), { webhookSecret: SECRET });
    expect(verified).not.toBeNull();
    expect(verified!.eventType).toBe("Issue");
    expect(verified!.deliveryId).toBe("del-1");
  });

  it("rejects a bad signature", async () => {
    const verified = await issueDef.verify(makeReq(payload, "wrong"), { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("rejects a stale webhookTimestamp", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now() - 120_000, ...payload });
    const rawBody = new TextEncoder().encode(body);
    const sig = createHmac("sha256", SECRET).update(Buffer.from(rawBody)).digest("hex");
    const verified = await issueDef.verify({ headers: { "linear-signature": sig, "linear-delivery": "d" }, rawBody }, { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("rejects when the type doesn't match the def's family", async () => {
    const verified = await issueDef.verify(makeReq({ ...payload, type: "Comment" }), { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });
});

describe("linear toEvent", () => {
  it("normalizes an issue create", async () => {
    const payload = { action: "create", type: "Issue", organizationId: "org-1", url: "https://linear.app/t/issue/TKAI-9", data: { id: "i1", identifier: "TKAI-9", title: "Fix bug", team: { key: "TKAI", id: "team-1" }, creatorId: "u-1" } };
    const verified = await issueDef.verify(makeReq(payload), { webhookSecret: SECRET });
    const event = issueDef.toEvent(verified!);
    expect(event.key).toBe("linear.issue.create");
    expect(event.dedupeKey).toBe("del-1");
    expect(event.refs.team).toBe("TKAI");
    expect(event.refs.identifier).toBe("TKAI-9");
    expect(event.summary).toContain("TKAI-9");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/plugin-linear && pnpm vitest run src/triggers.test.ts`
Expected: FAIL (module not found). If the package has no vitest setup, copy `packages/plugin-github`'s test config/devDependencies.

- [ ] **Step 3: Implement `triggers.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventCatalogEntry, NormalizedEvent, TriggerDef, VerifiedEvent } from "@valet/engine";

const LINEAR_TYPES = ["Issue", "Comment", "Project", "Cycle", "IssueLabel", "Reaction"] as const;
const ACTIONS = ["create", "update", "remove"] as const;
const TIMESTAMP_TOLERANCE_MS = 60_000;

function lookupHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function verifySignature(headers: Record<string, string>, rawBody: Uint8Array, secret: string): boolean {
  const signature = lookupHeader(headers, "linear-signature");
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function makeVerify(family: (typeof LINEAR_TYPES)[number]): TriggerDef["verify"] {
  return (req, secrets) => {
    const secret = secrets.webhookSecret;
    if (!secret) return null;
    if (!verifySignature(req.headers, req.rawBody, secret)) return null;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new TextDecoder().decode(req.rawBody)) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (payload.type !== family) return null;
    const ts = typeof payload.webhookTimestamp === "number" ? payload.webhookTimestamp : 0;
    if (Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) return null;
    const deliveryId = lookupHeader(req.headers, "linear-delivery");
    if (!deliveryId) return null;
    return { eventType: family, deliveryId, payload };
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function toEvent(event: VerifiedEvent): NormalizedEvent {
  const payload = event.payload as Record<string, unknown>;
  const action = str(payload.action) ?? "unknown";
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const team = data.team as Record<string, unknown> | undefined;

  const refs: Record<string, string> = {};
  const teamKey = str(team?.key);
  if (teamKey) refs.team = teamKey;
  const identifier = str(data.identifier);
  if (identifier) refs.identifier = identifier;
  const projectId = str(data.projectId);
  if (projectId) refs.project_id = projectId;
  const url = str(payload.url);
  if (url) refs.url = url;

  const title = str(data.title) ?? str(data.body)?.slice(0, 80) ?? str(data.name) ?? "";
  const actorId = str(data.creatorId) ?? str(data.userId);
  const family = event.eventType.toLowerCase();
  return {
    key: `linear.${family}.${action}`,
    dedupeKey: event.deliveryId,
    occurredAt: str(payload.createdAt) ?? new Date().toISOString(),
    actor: actorId ? { externalId: actorId } : undefined,
    refs,
    summary: [identifier, `${family} ${action}`, title && `— ${title}`].filter(Boolean).join(" "),
    payload: event.payload,
  };
}

const FILTERS: Record<string, EventCatalogEntry["filters"]> = {
  Issue: [
    { field: "team", path: "data.team.key", description: "Linear team key" },
    { field: "identifier", path: "data.identifier", description: "Issue identifier (e.g. TKAI-9)" },
    { field: "state", path: "data.state.name", description: "Workflow state name" },
    { field: "assignee", path: "data.assignee.name", description: "Assignee display name" },
  ],
  Comment: [{ field: "team", path: "data.issue.team.key", description: "Linear team key" }],
  Project: [{ field: "project", path: "data.name", description: "Project name" }],
  Cycle: [{ field: "team", path: "data.team.key", description: "Linear team key" }],
  IssueLabel: [{ field: "label", path: "data.name", description: "Label name" }],
  Reaction: [{ field: "emoji", path: "data.emoji", description: "Reaction emoji" }],
};

export const linearTriggerDefs: TriggerDef[] = LINEAR_TYPES.map((type) => ({
  id: `linear.${type.toLowerCase()}`,
  service: "linear",
  description: `Linear webhook event: ${type}`,
  verify: makeVerify(type),
  toEvent,
  catalog: ACTIONS.map((action) => ({
    key: `linear.${type.toLowerCase()}.${action}`,
    description: `Linear ${type} ${action}`,
    filters: FILTERS[type],
  })),
}));
```

Add to `plugin.ts`: `import { linearTriggerDefs } from "./triggers.js";` and `triggers: linearTriggerDefs,` in the plugin object.

- [ ] **Step 4: Run tests, then re-run Task 5's route tests** (they were parked red waiting on this):

Run: `cd packages/plugin-linear && pnpm vitest run src/triggers.test.ts && cd ../api && pnpm vitest run src/routes/event-webhooks.test.ts && cd ../.. && pnpm typecheck`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-linear/src/triggers.ts packages/plugin-linear/src/triggers.test.ts packages/plugin-linear/src/plugin.ts
git commit -m "feat(plugin-linear): webhook trigger defs — verify, normalize, catalog"
```

---

### Task 9: Linear connect flow — OAuth + auto webhook creation

**Files:**
- Create: `packages/api/src/services/linear.ts`
- Create: `packages/api/src/routes/linear-connect.ts`
- Create: `packages/api/src/test-helpers/linear-fixture.ts`
- Modify: `packages/api/src/app.ts` (mount `/api/org/linear` after auth; admin-gated like `/api/org/github-app`)
- Test: `packages/api/src/routes/linear-connect.test.ts`

**Flow** (mirror `github-connect.ts`/`github-app.ts` structure; org-admin only — copy the admin gate used by `githubAppRouter`):
1. `POST /api/org/linear/connect` → returns Linear authorize URL: `https://linear.app/oauth/authorize?client_id=...&redirect_uri={VALET_PUBLIC_URL}/api/org/linear/callback&response_type=code&scope=read,write,admin&state={signed}&actor=app`. Client id/secret from env `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET` (fixture overrides via `LINEAR_API_URL`/`LINEAR_OAUTH_URL`). State handling: copy whatever `github-connect.ts` does for its `state` param — same signing/TTL approach.
2. `GET /api/org/linear/callback?code=&state=` →
   - exchange code at `https://api.linear.app/oauth/token` (POST form: `code, redirect_uri, client_id, client_secret, grant_type=authorization_code`) → `access_token`
   - GraphQL `{ organization { id name } viewer { id } }` to learn the workspace
   - generate `webhookSecret = randomBytes(32).toString("hex")`
   - GraphQL mutation:
     ```graphql
     mutation($input: WebhookCreateInput!) {
       webhookCreate(input: $input) { success webhook { id } }
     }
     ```
     with `input: { url: "{VALET_PUBLIC_URL}/webhooks/events/linear", secret, allPublicTeams: true, resourceTypes: ["Issue","Comment","Project","Cycle","IssueLabel","Reaction"] }`
   - `engineCredentials.save({type:"org",id:orgId}, "linear", { type: "oauth2", accessToken, metadata: { webhookSecret, workspaceId } })`
   - upsert `linear_installations` (`workspaceId`, `workspaceName`, `webhookId`, `connectedBy: user.id`)
   - redirect to the web app settings page (copy the redirect target pattern from `github-connect.ts`'s callback)
3. `GET /api/org/linear` → `{ connected, workspaceName, webhookConfigured }`
4. `DELETE /api/org/linear` → GraphQL `webhookDelete(id)` (best-effort), delete installation row + credential.

- [ ] **Step 1: Build the fixture** (`test-helpers/linear-fixture.ts`) — an in-process HTTP server like `startGithubFixture` (read that file first and copy its shape): records requests; serves `POST /oauth/token` → `{ access_token: "lin_test" }`, `POST /graphql` → route by operation (organization query → `{ data: { organization: { id: "lin-org-1", name: "Turnkey" }, viewer: { id: "u1" } } }`; webhookCreate → `{ data: { webhookCreate: { success: true, webhook: { id: "wh-1" } } } }`; webhookDelete → success).

- [ ] **Step 2: Write failing route tests**

```ts
// connect returns an authorize URL containing client_id + redirect_uri + actor=app
// callback: exchanges code, creates webhook (fixture saw webhookCreate with our URL + secret),
//   saves credential (metadata.webhookSecret set), upserts linear_installations, 302s to settings
// GET /api/org/linear reflects connected state
// DELETE removes rows and calls webhookDelete on the fixture
// non-admin caller gets 403 on all of the above
```

Full test code required — follow `github-app.test.ts` for admin vs member headers and fixture wiring.

- [ ] **Step 3: Implement service + routes.** Keep GraphQL calls in `services/linear.ts`:

```ts
export interface LinearService {
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  fetchWorkspace(accessToken: string): Promise<{ workspaceId: string; workspaceName: string }>;
  createWebhook(accessToken: string, args: { url: string; secret: string }): Promise<{ webhookId: string }>;
  deleteWebhook(accessToken: string, webhookId: string): Promise<void>;
}
```

with a `fetch`-based implementation reading `LINEAR_OAUTH_URL ?? "https://linear.app"` and `LINEAR_API_URL ?? "https://api.linear.app"` (fixture points both at itself). Routes are thin: validate admin, call service, write rows.

- [ ] **Step 4: Run tests**

Run: `cd packages/api && pnpm vitest run src/routes/linear-connect.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/linear.ts packages/api/src/routes/linear-connect.ts packages/api/src/test-helpers/linear-fixture.ts packages/api/src/routes/linear-connect.test.ts packages/api/src/app.ts
git commit -m "feat(api): linear connect flow — oauth, auto webhook creation, installation row"
```

---

### Task 10: E2E, spec sync, full verification

**Files:**
- Modify: `docs/specs/2026-07-20-event-system-design.md`
- Test: `packages/api/src/routes/events.e2e.test.ts` (naming per existing `*.e2e.test.ts` convention)

- [ ] **Step 1: End-to-end test** — the full loop in one test file:

1. Boot test API; seed linear installation + credential (secret `s1`).
2. Create a workflow definition (minimal DAG: trigger → set node — copy a definition literal from `workflows.test.ts`).
3. `POST /api/event-subscriptions` targeting that workflow with `eventKeys: ["linear.issue.create"]` and a `team: eq TKAI` filter.
4. POST a signed Linear issue-create webhook to `/webhooks/events/linear`.
5. Drive delivery deterministically: call `providers.eventDispatcher.pollOnce()` directly (export a test hook from `bootTestApi` if needed) rather than sleeping on the 1s timer.
6. Assert: a `workflow_runs` row exists for the workflow whose `params.input` has `type: "event"` and `data.key === "linear.issue.create"`; the delivery row is `delivered`.
7. Negative: an event with `team: OTHER` creates an event row but no delivery.

- [ ] **Step 2: Sync the spec.** Update `docs/specs/2026-07-20-event-system-design.md`:
- Dispatcher section: replace LISTEN/NOTIFY with "1s poll + in-process nudge from the ingest path" and the rationale (single-process API).
- Data model: drop `webhook_secret_enc` from `linear_installations`; note the secret lives in the org `linear` credential metadata.
- Contract section: `TriggerDef.toSignal` removed (was unconsumed), `toEvent` + `catalog` added.
- Note retention job and GitHub App manifest `default_events` as deferred follow-ups (see Out of scope below).
- Mark status line: "Implemented on dev-v2".

- [ ] **Step 3: Full verification**

```bash
pnpm typecheck
cd packages/api && pnpm vitest run
cd ../engine && pnpm vitest run
cd ../workflow && pnpm vitest run
cd ../plugin-github && pnpm vitest run
cd ../plugin-linear && pnpm vitest run
```

Expected: all green. Fix anything that isn't before committing.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/events.e2e.test.ts docs/specs/2026-07-20-event-system-design.md docs/plans/2026-07-20-event-system.md
git commit -m "test(api): event system e2e — webhook to workflow run; sync design spec"
```

---

## Out of scope (deliberate)

- Web UI (subscription builder, event feed page) — follow-up PR; the API surface from Task 7 is UI-ready.
- Workflow-editor sync of event trigger nodes to subscription rows — needs the UI; subscriptions targeting workflows by id cover the capability.
- Event retention/pruning job — table is indexed for it; add when volume warrants.
- GitHub App manifest `default_events` — one-line config change, but existing installs need manual re-config; handle in deployment notes on the PR.
- SSE/WebSocket streaming of the feed.


