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
