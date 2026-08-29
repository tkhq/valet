# PluginStore — plugin-owned persistence without core migrations

Status: approved design. First consumer: the plugin entitlement rail.

## Problem

Every plugin that needs to persist data edits the core app schema today: Valet Security added six `security_*` tables to `0000_app.sql`, and the entitlement rail added an `orgs.plugin_entitlements` column. Adding or removing a plugin should not touch the core schema.

## Decision

Ship ONE core table, once. After that, a plugin persists config, settings, and moderate collections with zero further migrations. A plugin with heavy relational needs (severity/status filters, dedup, pagination, rollups — Valet Security) keeps real tables; the store does not replace them.

## The table (core, one time)

```
plugin_store(
  id text primary key,
  plugin text not null,               -- the owning plugin's name, or "valet" for core-owned data
  scope_type text not null,           -- global | org | team | user | session
  scope_id text not null,             -- "" for global
  collection text not null,           -- the plugin's own namespace within its data
  key text not null,
  doc jsonb not null,
  revision integer not null default 1,
  created_at bigint not null,
  updated_at bigint not null
)
unique(plugin, scope_type, scope_id, collection, key)
index(plugin, scope_type, scope_id, collection)     -- list
index gin(doc)                                       -- jsonb filters
```

Added via `0000_app.sql` + the Drizzle schema + a `SCHEMA_REPAIRS` `CREATE TABLE/INDEX IF NOT EXISTS` entry (the artifacts / llm_proxy_requests precedent), so deployed databases get it on boot without a wipe.

## The contract (`@valet/engine`)

```
type PluginStoreScope =
  | { type: "global" }
  | { type: "org"; id: string }
  | { type: "team"; id: string }
  | { type: "user"; id: string }
  | { type: "session"; id: string };

interface PluginStoreDoc<T> { key: string; doc: T; revision: number; createdAt: number; updatedAt: number }

interface ScopedPluginStore {
  get<T>(collection: string, key: string): Promise<PluginStoreDoc<T> | null>;
  put<T>(collection: string, key: string, doc: T, opts?: { ifRevision?: number }): Promise<PluginStoreDoc<T>>;
  list<T>(collection: string, opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ items: PluginStoreDoc<T>[]; nextCursor: string | null }>;
  delete(collection: string, key: string): Promise<boolean>;
}

interface PluginStore {
  scope(scope: PluginStoreScope): ScopedPluginStore;
  global(): ScopedPluginStore;
  org(orgId: string): ScopedPluginStore;
  team(teamId: string): ScopedPluginStore;
  user(userId: string): ScopedPluginStore;
  session(sessionId: string): ScopedPluginStore;
}
```

A `PluginStore` is bound to one plugin name (the plugin never sees another plugin's rows). Scope is chosen per call through the scoped views. Document shapes are TypeScript types the plugin validates itself; the store persists opaque jsonb. `put` supports optimistic concurrency through `ifRevision`.

## Implementation

`packages/api/src/services/plugin-store.ts`: `pluginStore(db, pluginName): PluginStore` over the `plugin_store` table. Upsert on the unique identity, bumping `revision` and `updated_at`. `list` pages by `(key)` with an opaque cursor.

## Injection into plugin actions

`ToolContext` gains an optional `pluginStore?: PluginStore`, bound to the action's owning plugin and defaulted to the call's scope. The api's `buildToolContext` provides it, so a plugin action reads and writes its own data without an HTTP round trip and without knowing the table exists.

## Declared indexes (optional, per plugin)

A plugin may declare hot fields it filters on:

```
storeIndexes: [{ collection: "findings", field: "severity" }]
```

The api ensures a matching expression index (`CREATE INDEX IF NOT EXISTS … ((doc->>'severity'))` scoped by plugin+collection) at boot, idempotently. This narrows the query gap without per-plugin tables. Absent declarations, the GIN index covers general filters.

## First consumer: the entitlement rail

Move `orgs.plugin_entitlements` onto the store. The rail is core, so it uses the reserved `"valet"` plugin namespace:

- write: `pluginStore(db, "valet").org(orgId).put("plugin-entitlements", targetPluginName, { mode, teamIds })`
- read one: `.org(orgId).get("plugin-entitlements", targetPluginName)`
- read all: `.org(orgId).list("plugin-entitlements")`

`services/plugin-entitlements.ts` switches to these calls; the `orgs.plugin_entitlements` column and its `SCHEMA_REPAIRS` entry are removed. Default (`all`) and team resolution are unchanged. This proves get/put/list and org scoping end to end.

## Out of scope

- Plugin-owned SQL migrations / relational tables (a plugin that needs those keeps real tables, as Valet Security does).
- Cross-plugin reads, and a store-backed query language beyond key, prefix, and the declared indexes.

## Adding plugin persistence (the paved road)

1. Get the store from `ctx.pluginStore` (in an action) or `pluginStore(db, name)` (api-internal).
2. Choose a scope, a collection, and a key; put and get typed documents.
3. Declare `storeIndexes` only for fields you filter on at volume.

No core migration, ever.
