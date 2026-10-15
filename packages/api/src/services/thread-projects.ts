import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { applyThreadProjectsOperations, ThreadProjectsConflict, type ThreadProjectsOperation, type ThreadProjectsResponse } from "@valet/shared";
export { ThreadProjectsConflict } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { pluginStore } from "../schema/index.js";
import { threadProjectsDocumentSchema, type ThreadProjectsDocument } from "./thread-projects-schema.js";

export interface ThreadProjectsScope { orgId: string; userId: string; sessionId: string }

function empty(): ThreadProjectsDocument {
  return { value: { projects: [], pinned: [], assignments: {}, grouped: true, collapsed: false },
    retiredProjects: [], touchedAssignments: [], touchedPins: [], initialized: false };
}

function identity(scope: ThreadProjectsScope) {
  return and(eq(pluginStore.plugin, "valet"), eq(pluginStore.scopeType, "user"), eq(pluginStore.scopeId, scope.userId),
    eq(pluginStore.collection, "thread-projects"), eq(pluginStore.key, JSON.stringify([scope.orgId, scope.sessionId])));
}

export async function readThreadProjects(db: AppDb, scope: ThreadProjectsScope): Promise<ThreadProjectsResponse> {
  const [row] = await db.select().from(pluginStore).where(identity(scope)).limit(1);
  return { value: row ? threadProjectsDocumentSchema.parse(row.doc).value : empty().value, revision: row?.revision ?? 0 };
}

/** Reapply operations after a competing write, with the revision in the write predicate. */
export async function changeThreadProjects(db: AppDb, scope: ThreadProjectsScope, operations: ThreadProjectsOperation[]): Promise<ThreadProjectsResponse> {
  const now = Date.now();
  await db.insert(pluginStore).values({ id: randomUUID(), plugin: "valet", scopeType: "user", scopeId: scope.userId,
    collection: "thread-projects", key: JSON.stringify([scope.orgId, scope.sessionId]), doc: empty(), revision: 1,
    createdAt: now, updatedAt: now }).onConflictDoNothing();
  for (let attempt = 0; attempt < 32; attempt++) {
    const [row] = await db.select().from(pluginStore).where(identity(scope)).limit(1);
    if (!row) throw new ThreadProjectsConflict("Sidebar preferences changed. Refresh the sidebar and retry.");
    const document = threadProjectsDocumentSchema.parse(applyThreadProjectsOperations(threadProjectsDocumentSchema.parse(row.doc), operations));
    const [updated] = await db.update(pluginStore).set({ doc: document, revision: row.revision + 1, updatedAt: Date.now() })
      .where(and(identity(scope), eq(pluginStore.revision, row.revision))).returning({ revision: pluginStore.revision });
    if (updated) return { value: document.value, revision: updated.revision };
  }
  throw new ThreadProjectsConflict("The sidebar is busy on another device. Retry saving your change.");
}
