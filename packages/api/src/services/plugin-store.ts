/**
 * Generic plugin persistence over the shared `plugin_store` table
 * (docs/specs/2026-08-29-plugin-store-design.md). A plugin persists config,
 * settings, and moderate collections with no per-plugin migration; a plugin
 * with heavy relational needs keeps real tables.
 *
 * `pluginStore(db, pluginName)` returns a `PluginStore` bound to one plugin —
 * every read and write carries the plugin name, so a plugin never sees another
 * plugin's rows. The reserved name "valet" is core-owned data (the entitlement
 * rail is the first consumer). Scope maps to the `(scope_type, scope_id)` pair
 * ("" id for global). `doc` is opaque jsonb: it goes in and out as `unknown`,
 * and the caller owns the `T`.
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  PluginStoreConflictError,
  type PluginStore,
  type PluginStoreDoc,
  type PluginStoreScope,
  type ScopedPluginStore,
  type ValetPlugin,
} from "@valet/engine";
import type { PgDb } from "@valet/store-postgres";
import type { AppQueryable } from "../lib/drizzle.js";
import { pluginStore as pluginStoreTable } from "../schema/index.js";

/** Default and hard cap for a `list` page. */
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

/** The `(scope_type, scope_id)` pair for a scope. Global carries no id, stored
 * as `""` so the unique identity is total over all scope kinds. */
function scopeParts(scope: PluginStoreScope): { scopeType: string; scopeId: string } {
  return scope.type === "global"
    ? { scopeType: "global", scopeId: "" }
    : { scopeType: scope.type, scopeId: scope.id };
}

/** A stored row rendered as the plugin-facing document. `doc` is opaque jsonb;
 * the driver returns it already parsed, so the caller's `T` is a plain cast of
 * an `unknown` value it owns. */
function toDoc<T>(row: {
  key: string;
  doc: unknown;
  revision: number;
  createdAt: number;
  updatedAt: number;
}): PluginStoreDoc<T> {
  return {
    key: row.key,
    doc: row.doc as T,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Opaque list cursor over `key`. A page returns the last key it emitted,
 * base64-encoded; the next page filters `key > <cursor>`. Keys are unique
 * within a `(plugin, scope, collection)` group, so a single-column cursor
 * paginates without ties.
 */
function encodeCursor(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

class ScopedPluginStoreImpl implements ScopedPluginStore {
  constructor(
    private readonly db: AppQueryable,
    private readonly plugin: string,
    private readonly scopeType: string,
    private readonly scopeId: string,
  ) {}

  private identity(collection: string, key: string) {
    return and(
      eq(pluginStoreTable.plugin, this.plugin),
      eq(pluginStoreTable.scopeType, this.scopeType),
      eq(pluginStoreTable.scopeId, this.scopeId),
      eq(pluginStoreTable.collection, collection),
      eq(pluginStoreTable.key, key),
    );
  }

  async get<T>(collection: string, key: string): Promise<PluginStoreDoc<T> | null> {
    const rows = await this.db
      .select()
      .from(pluginStoreTable)
      .where(this.identity(collection, key))
      .limit(1);
    const row = rows[0];
    return row ? toDoc<T>(row) : null;
  }

  async put<T>(
    collection: string,
    key: string,
    doc: T,
    opts?: { ifRevision?: number },
  ): Promise<PluginStoreDoc<T>> {
    const now = Date.now();
    // `ifRevision` is optimistic concurrency: the write must land on a row at
    // exactly that revision. Run it in a transaction so the read-check and the
    // update are atomic against a concurrent writer.
    if (opts?.ifRevision !== undefined) {
      const expected = opts.ifRevision;
      return this.db.transaction(async (tx) => {
        const existing = await tx
          .select({ revision: pluginStoreTable.revision })
          .from(pluginStoreTable)
          .where(this.identity(collection, key))
          .limit(1);
        const current = existing[0]?.revision ?? null;
        if (current !== expected) {
          throw new PluginStoreConflictError(collection, key, expected, current);
        }
        const updated = await tx
          .update(pluginStoreTable)
          .set({ doc, revision: expected + 1, updatedAt: now })
          .where(this.identity(collection, key))
          .returning();
        // `current === expected` guaranteed a row exists, so the update returns it.
        return toDoc<T>(updated[0]);
      });
    }

    // No `ifRevision`: upsert on the unique identity. A fresh row starts at
    // revision 1; an existing row bumps revision and updated_at.
    const inserted = await this.db
      .insert(pluginStoreTable)
      .values({
        id: randomUUID(),
        plugin: this.plugin,
        scopeType: this.scopeType,
        scopeId: this.scopeId,
        collection,
        key,
        doc,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          pluginStoreTable.plugin,
          pluginStoreTable.scopeType,
          pluginStoreTable.scopeId,
          pluginStoreTable.collection,
          pluginStoreTable.key,
        ],
        set: {
          doc,
          revision: sql`${pluginStoreTable.revision} + 1`,
          updatedAt: now,
        },
      })
      .returning();
    return toDoc<T>(inserted[0]);
  }

  async list<T>(
    collection: string,
    opts?: { prefix?: string; limit?: number; cursor?: string },
  ): Promise<{ items: PluginStoreDoc<T>[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(1, opts?.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    const conditions = [
      eq(pluginStoreTable.plugin, this.plugin),
      eq(pluginStoreTable.scopeType, this.scopeType),
      eq(pluginStoreTable.scopeId, this.scopeId),
      eq(pluginStoreTable.collection, collection),
    ];
    if (opts?.prefix) {
      // Match keys that START with the prefix. Escape LIKE metacharacters in
      // the prefix so a literal `%` or `_` in it is not a wildcard.
      const escaped = opts.prefix.replace(/([\\%_])/g, "\\$1");
      conditions.push(sql`${pluginStoreTable.key} LIKE ${escaped + "%"} ESCAPE '\\'`);
    }
    if (opts?.cursor) {
      conditions.push(gt(pluginStoreTable.key, decodeCursor(opts.cursor)));
    }
    // Fetch one extra row to tell whether a further page exists.
    const rows = await this.db
      .select()
      .from(pluginStoreTable)
      .where(and(...conditions))
      .orderBy(asc(pluginStoreTable.key))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) => toDoc<T>(row));
    const nextCursor = hasMore ? encodeCursor(page[page.length - 1].key) : null;
    return { items, nextCursor };
  }

  async delete(collection: string, key: string): Promise<boolean> {
    const deleted = await this.db
      .delete(pluginStoreTable)
      .where(this.identity(collection, key))
      .returning({ id: pluginStoreTable.id });
    return deleted.length > 0;
  }
}

class PluginStoreImpl implements PluginStore {
  constructor(
    private readonly db: AppQueryable,
    private readonly plugin: string,
  ) {}

  scope(scope: PluginStoreScope): ScopedPluginStore {
    const { scopeType, scopeId } = scopeParts(scope);
    return new ScopedPluginStoreImpl(this.db, this.plugin, scopeType, scopeId);
  }
  global(): ScopedPluginStore {
    return this.scope({ type: "global" });
  }
  org(orgId: string): ScopedPluginStore {
    return this.scope({ type: "org", id: orgId });
  }
  team(teamId: string): ScopedPluginStore {
    return this.scope({ type: "team", id: teamId });
  }
  user(userId: string): ScopedPluginStore {
    return this.scope({ type: "user", id: userId });
  }
  session(sessionId: string): ScopedPluginStore {
    return this.scope({ type: "session", id: sessionId });
  }
}

/**
 * Build a `PluginStore` bound to `pluginName` over the app db. The reserved
 * name "valet" holds core-owned data (the entitlement rail). Every read and
 * write carries the plugin name, so one plugin's store never reaches another's
 * rows.
 */
export function pluginStore(db: AppQueryable, pluginName: string): PluginStore {
  return new PluginStoreImpl(db, pluginName);
}

// ── Declared indexes ───────────────────────────────────────────────

/** Identifier-safe check for a plugin/collection/field that rides into a
 * `CREATE INDEX` statement. Rejects anything outside `[a-z0-9_]` so nothing
 * unsanitized reaches the DDL. Matches the manifest validator's rule. */
const IDENTIFIER_RE = /^[a-z0-9_]+$/;

/** The index name for a declared `(plugin, collection, field)` expression
 * index. All three parts are identifier-checked before this runs. */
function storeIndexName(plugin: string, collection: string, field: string): string {
  return `plugin_store_${plugin}_${collection}_${field}`;
}

/**
 * Ensure the expression index each plugin declares through
 * `ValetPlugin.storeIndexes` (docs/specs/2026-08-29-plugin-store-design.md).
 * For each declared field it creates a partial expression index on
 * `(doc->>'<field>')`, scoped by `plugin` + `collection`, so a plugin's hot
 * filter has a real index without a per-plugin table. Idempotent: every
 * statement is `CREATE INDEX IF NOT EXISTS`, so re-running at each boot is a
 * no-op once the index exists.
 *
 * A plugin name, collection, or field that is not identifier-safe (`[a-z0-9_]`)
 * is skipped with a warning rather than built — the manifest validator already
 * rejects such a declaration, so this is a defense-in-depth guard on the DDL
 * seam, never a normal path.
 */
export async function ensurePluginStoreIndexes(
  db: PgDb,
  plugins: ValetPlugin[],
): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.storeIndexes?.length) continue;
    if (!IDENTIFIER_RE.test(plugin.name)) {
      // Plugin names allow hyphens (NAME_RE), but an index name must be a
      // plain identifier — skip a hyphenated name rather than emit unsafe DDL.
      console.warn(
        `plugin store: skipping declared indexes for plugin "${plugin.name}" — name is not identifier-safe for an index`,
      );
      continue;
    }
    for (const { collection, field } of plugin.storeIndexes) {
      if (!IDENTIFIER_RE.test(collection) || !IDENTIFIER_RE.test(field)) {
        console.warn(
          `plugin store: skipping index for ${plugin.name} (collection="${collection}", field="${field}") — not identifier-safe`,
        );
        continue;
      }
      const indexName = storeIndexName(plugin.name, collection, field);
      // All identifiers are validated `[a-z0-9_]` above, so string
      // interpolation into the DDL is safe (no bind params in DDL).
      await db.query(
        `CREATE INDEX IF NOT EXISTS "${indexName}" ON plugin_store ((doc->>'${field}')) ` +
          `WHERE plugin = '${plugin.name}' AND collection = '${collection}'`,
      );
    }
  }
}
