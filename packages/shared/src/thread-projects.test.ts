import { expect, it } from "vitest";
import { applyThreadProjectsOperations, threadProjectsChanges, type ThreadProjects, type ThreadProjectsDocument } from "./thread-projects.js";

it("keeps another device's newer move and pin when deleting a stale project snapshot", () => {
  const before: ThreadProjects = { projects: [{ id: "p", name: "P", collapsed: false }, { id: "q", name: "Q", collapsed: false }],
    assignments: { chat: "p" }, pinned: ["chat"], grouped: true, collapsed: false };
  const operations = threadProjectsChanges(before, { ...before, projects: before.projects.filter(project => project.id !== "p"), assignments: {}, pinned: [] });
  const current: ThreadProjectsDocument = { value: { ...before, assignments: { chat: "q" } },
    retiredProjects: [], touchedAssignments: ["chat"], touchedPins: ["chat"], initialized: true };
  const saved = applyThreadProjectsOperations(current, operations);
  expect(saved.value.assignments).toEqual({ chat: "q" });
  expect(saved.value.pinned).toEqual(["chat"]);
  expect(saved.value.projects.map(project => project.id)).toEqual(["q"]);
});

function document(): ThreadProjectsDocument {
  return { value: { projects: [], pinned: [], assignments: {}, grouped: true, collapsed: false },
    retiredProjects: [], touchedAssignments: [], touchedPins: [], initialized: false };
}

it("rejects an overflowing legacy import without changing either folder collection", () => {
  const current = document();
  current.value.projects = Array.from({ length: 150 }, (_, i) => ({ id: `server-${i}`, name: `Server ${i}`, collapsed: false }));
  const legacy = { ...document().value,
    projects: Array.from({ length: 60 }, (_, i) => ({ id: `local-${i}`, name: `Local ${i}`, collapsed: false })) };
  let error: unknown;
  try { applyThreadProjectsOperations(current, [{ type: "import", value: legacy }]); }
  catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "import-limit" });
  expect(current.value.projects).toHaveLength(150);
  expect(legacy.projects).toHaveLength(60);
});

it("suffixes imported duplicate names while preserving IDs, assignments, and the name limit", () => {
  const current = document();
  const name = "A".repeat(100);
  current.value.projects = [{ id: "server", name, collapsed: false }];
  const legacy = { ...document().value, projects: [
    { id: "one", name: name.toLowerCase(), collapsed: false },
    { id: "two", name: name.toLowerCase(), collapsed: false },
  ], assignments: { chat: "one", other: "two" } };
  const saved = applyThreadProjectsOperations(current, [{ type: "import", value: legacy }]);
  expect(saved.value.projects).toEqual([
    { id: "server", name, collapsed: false },
    { id: "one", name: `${"a".repeat(96)} (2)`, collapsed: false },
    { id: "two", name: `${"a".repeat(96)} (3)`, collapsed: false },
  ]);
  expect(saved.value.assignments).toEqual({ chat: "one", other: "two" });
  expect(applyThreadProjectsOperations(saved, [{ type: "import", value: legacy }]).value).toEqual(saved.value);
});

it("closes legacy imports at the history limit and keeps ordinary changes usable", () => {
  const current = document();
  current.value.projects = [{ id: "p", name: "Project", collapsed: false }];
  current.touchedPins = Array.from({ length: 19999 }, (_, i) => `old-${i}`);
  const saved = applyThreadProjectsOperations(current, [{ type: "pin", threadId: "last", pinned: false }]);
  expect(saved).toMatchObject({ importsClosed: true, generation: 1, retiredProjects: [], touchedAssignments: [], touchedPins: [] });
  expect(() => applyThreadProjectsOperations(saved, [{ type: "import", value: document().value }])).toThrow();
  expect(() => applyThreadProjectsOperations(saved, [{ type: "create", id: "stale", name: "Stale" }])).toThrow();
  const changed = applyThreadProjectsOperations(saved, [
    { type: "create", id: "fresh", name: "Fresh", generation: 1 },
    { type: "assign", threadId: "chat", projectId: "fresh" },
    { type: "pin", threadId: "chat", pinned: true },
  ]);
  expect(changed.value.assignments).toEqual({ chat: "fresh" });
  expect(changed.value.pinned).toEqual(["chat"]);
  expect(changed.touchedAssignments).toEqual([]);
  expect(changed.touchedPins).toEqual([]);
});

it("rejects stale creates after repeated retirement compaction", () => {
  const current = document();
  current.value.projects = [{ id: "last", name: "Last", collapsed: false }];
  current.retiredProjects = Array.from({ length: 19999 }, (_, i) => `gone-${i}`);
  const compacted = applyThreadProjectsOperations(current, [{ type: "delete", id: "last", archivedThreadIds: [] }]);
  expect(compacted).toMatchObject({ importsClosed: true, generation: 1, retiredProjects: [] });
  expect(() => applyThreadProjectsOperations(compacted, [{ type: "create", id: "last", name: "Replay" }])).toThrow();
  const created = applyThreadProjectsOperations(compacted, [{ type: "create", id: "new", name: "New", generation: 1 }]);
  const deleted = applyThreadProjectsOperations(created, [{ type: "delete", id: "new", archivedThreadIds: [] }]);
  expect(() => applyThreadProjectsOperations(deleted, [{ type: "create", id: "new", name: "Replay", generation: 1 }])).toThrow();
  deleted.retiredProjects = [...current.retiredProjects, "new"];
  const compactedAgain = applyThreadProjectsOperations(deleted, [{ type: "grouped", value: false }]);
  expect(compactedAgain.generation).toBe(2);
  expect(() => applyThreadProjectsOperations(compactedAgain, [{ type: "create", id: "new", name: "Replay", generation: 1 }])).toThrow();
  expect(applyThreadProjectsOperations(compactedAgain, [{ type: "create", id: "later", name: "Later", generation: 2 }]).value.projects).toEqual([
    { id: "later", name: "Later", collapsed: false },
  ]);
});
