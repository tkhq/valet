import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { applyThreadProjectsOperations, ThreadProjectsConflict, type ThreadProjectsOperation, type ThreadProjectsResponse } from "@valet/shared";
export { ThreadProjectsConflict, ThreadProjectsImportConflict } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { pluginStore } from "../schema/index.js";
import { threadProjectsDocumentSchema, type ThreadProjectsDocument } from "./thread-projects-schema.js";

export interface ThreadProjectsScope { orgId: string; userId: string; sessionId: string }
type ActiveThreads = (ids: string[]) => Promise<Set<string>>;

function empty(): ThreadProjectsDocument {
  return { value: { projects: [], pinned: [], assignments: {}, grouped: true, collapsed: false },
    retiredProjects: [], touchedAssignments: [], touchedPins: [], initialized: false, importsClosed: false, generation: 0 };
}

function identity(scope: ThreadProjectsScope) {
  return and(eq(pluginStore.plugin, "valet"), eq(pluginStore.scopeType, "user"), eq(pluginStore.scopeId, scope.userId),
    eq(pluginStore.collection, "thread-projects"), eq(pluginStore.key, JSON.stringify([scope.orgId, scope.sessionId])));
}

export async function readThreadProjects(db: AppDb, scope: ThreadProjectsScope, activeThreads?: ActiveThreads): Promise<ThreadProjectsResponse> {
  return changeThreadProjects(db, scope, [], activeThreads);
}

/** Reapply operations after a competing write, with the revision in the write predicate. */
export async function changeThreadProjects(db: AppDb, scope: ThreadProjectsScope, operations: ThreadProjectsOperation[], activeThreads?: ActiveThreads): Promise<ThreadProjectsResponse> {
  const now = Date.now();
  if (operations.length) await db.insert(pluginStore).values({ id: randomUUID(), plugin: "valet", scopeType: "user", scopeId: scope.userId,
    collection: "thread-projects", key: JSON.stringify([scope.orgId, scope.sessionId]), doc: empty(), revision: 1,
    createdAt: now, updatedAt: now }).onConflictDoNothing();
  for (let attempt = 0; attempt < 32; attempt++) {
    const [row] = await db.select().from(pluginStore).where(identity(scope)).limit(1);
    if (!row) {
      if (!operations.length) return { value: empty().value, revision: 0, generation: 0 };
      throw new ThreadProjectsConflict("Sidebar preferences changed. Refresh the sidebar and retry.");
    }
    const previous = threadProjectsDocumentSchema.parse(row.doc);
    const cleanup: ThreadProjectsOperation[] = [];
    if (activeThreads) {
      const ids = [...new Set([...Object.keys(previous.value.assignments), ...previous.value.pinned])];
      const active = await activeThreads(ids);
      for (const id of ids) if (!active.has(id)) {
        if (previous.value.assignments[id]) cleanup.push({ type: "assign", threadId: id, projectId: null });
        if (previous.value.pinned.includes(id)) cleanup.push({ type: "pin", threadId: id, pinned: false });
      }
    }
    const document = threadProjectsDocumentSchema.parse(applyThreadProjectsOperations(previous, [...cleanup, ...operations]));
    if (!operations.length && JSON.stringify(document) === JSON.stringify(previous)) {
      return { value: document.value, revision: row.revision, generation: document.generation };
    }
    const [updated] = await db.update(pluginStore).set({ doc: document, revision: row.revision + 1, updatedAt: Date.now() })
      .where(and(identity(scope), eq(pluginStore.revision, row.revision))).returning({ revision: pluginStore.revision });
    if (updated) return { value: document.value, revision: updated.revision, generation: document.generation };
  }
  throw new ThreadProjectsConflict("The sidebar is busy on another device. Retry saving your change.");
}
