import { beforeEach, expect, it } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { changeThreadProjects, readThreadProjects } from "./thread-projects.js";

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
