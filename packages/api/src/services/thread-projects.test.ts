import { beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { changeThreadProjects, readThreadProjects } from "./thread-projects.js";
import { pluginStore } from "../schema/index.js";
import { threadProjectsDocumentSchema } from "./thread-projects-schema.js";

let db: AppDb;
const scope = { orgId: "org", userId: "viewer", sessionId: "runtime" };
beforeEach(async () => { db = (await freshTestPgDb()).appDb; });

it("atomically reapplies competing operations instead of losing another writer's folders", async () => {
  await Promise.all(Array.from({ length: 16 }, (_, i) => changeThreadProjects(db, scope,
    [{ type: "create", id: `p-${i}`, name: `Project ${i}` }])));
  const saved = await readThreadProjects(db, scope);
  expect(saved.value.projects.map(project => project.id).sort()).toEqual(Array.from({ length: 16 }, (_, i) => `p-${i}`).sort());
  expect(saved.revision).toBe(17);
});

it("leaves server folders usable after an oversized legacy import is rejected", async () => {
  const projects = Array.from({ length: 150 }, (_, i) => ({ id: `server-${i}`, name: `Server ${i}`, collapsed: false }));
  const saved = await changeThreadProjects(db, scope, [{ type: "import", value: { projects, assignments: {}, pinned: [], grouped: true, collapsed: false } }]);
  const local = Array.from({ length: 60 }, (_, i) => ({ id: `local-${i}`, name: `Local ${i}`, collapsed: false }));
  await expect(changeThreadProjects(db, scope, [{ type: "import", value: {
    projects: local, assignments: {}, pinned: [], grouped: true, collapsed: false,
  } }])).rejects.toMatchObject({ code: "import-limit" });
  expect(await readThreadProjects(db, scope)).toEqual(saved);
  const changed = await changeThreadProjects(db, scope, [{ type: "rename", id: "server-0", name: "Renamed" }]);
  expect(changed.value.projects[0]?.name).toBe("Renamed");
});

it.each(["retiredProjects", "touchedAssignments", "touchedPins"] as const)("compacts saturated %s without blocking writes or restoring stale imports", async field => {
  await changeThreadProjects(db, scope, [{ type: "create", id: "p", name: "P" }]);
  const [row] = await db.select().from(pluginStore).where(eq(pluginStore.scopeId, scope.userId)).limit(1);
  if (!row) throw new Error("Missing saved folders");
  const document = threadProjectsDocumentSchema.parse(row.doc);
  document[field] = Array.from({ length: 20000 }, (_, i) => `old-${i}`);
  await db.update(pluginStore).set({ doc: document }).where(eq(pluginStore.id, row.id));
  const saved = await changeThreadProjects(db, scope, [{ type: "pin", threadId: "new", pinned: false }]);
  expect(saved.generation).toBe(1);
  await expect(changeThreadProjects(db, scope, [{ type: "import", value: {
    projects: [{ id: "stale", name: "Stale", collapsed: false }], assignments: { stale: "p" }, pinned: ["stale"], grouped: true, collapsed: false,
  } }])).rejects.toMatchObject({ code: "import-closed" });
  expect((await changeThreadProjects(db, scope, [{ type: "create", id: "fresh", name: "Fresh", generation: 1 }])).value.projects).toHaveLength(2);
});

it("includes organization, viewer, and runtime in every persisted identity", async () => {
  await changeThreadProjects(db, scope, [{ type: "create", id: "p", name: "Private" }]);
  for (const other of [{ ...scope, orgId: "other" }, { ...scope, userId: "other" }, { ...scope, sessionId: "other" }]) {
    expect((await readThreadProjects(db, other)).value.projects).toEqual([]);
  }
});

it("keeps a failed operation batch atomic and bounds stored folders", async () => {
  await expect(changeThreadProjects(db, scope, [{ type: "create", id: "p", name: "P" }, { type: "rename", id: "missing", name: "Missing" }])).rejects.toThrow("no longer available");
  expect((await readThreadProjects(db, scope)).value.projects).toEqual([]);
  const projects = Array.from({ length: 200 }, (_, i) => ({ id: `p-${i}`, name: `Project ${i}`, collapsed: false }));
  await changeThreadProjects(db, scope, [{ type: "import", value: { projects, assignments: {}, pinned: [], grouped: true, collapsed: false } }]);
  await expect(changeThreadProjects(db, scope, [{ type: "create", id: "overflow", name: "Overflow" }])).rejects.toThrow();
  expect((await readThreadProjects(db, scope)).value.projects).toHaveLength(200);
});
