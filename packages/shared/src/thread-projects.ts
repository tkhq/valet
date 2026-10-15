/** Personal sidebar organization within one workspace runtime. */
export interface ThreadProjects {
  projects: Array<{ id: string; name: string; collapsed: boolean }>;
  pinned: string[];
  assignments: Record<string, string>;
  grouped: boolean;
  collapsed: boolean;
}

export type ThreadProjectsOperation =
  | { type: "create"; id: string; name: string; collapsed?: boolean; generation?: number }
  | { type: "rename"; id: string; name: string }
  | { type: "collapse-project"; id: string; collapsed: boolean }
  | { type: "delete"; id: string; archivedThreadIds: string[] }
  | { type: "assign"; threadId: string; projectId: string | null }
  | { type: "pin"; threadId: string; pinned: boolean }
  | { type: "grouped"; value: boolean }
  | { type: "collapsed"; value: boolean }
  | { type: "import"; value: ThreadProjects };

export interface ThreadProjectsResponse {
  value: ThreadProjects;
  revision: number;
  generation?: number;
}

/** Send only the user's changes, so a stale device cannot replace other edits. */
export function threadProjectsChanges(before: ThreadProjects, after: ThreadProjects): ThreadProjectsOperation[] {
  const operations: ThreadProjectsOperation[] = [];
  const removed = new Set(before.projects.filter(project => !after.projects.some(next => next.id === project.id)).map(project => project.id));
  for (const project of before.projects) {
    if (!after.projects.some(next => next.id === project.id)) {
      operations.push({ type: "delete", id: project.id,
        archivedThreadIds: Object.keys(before.assignments).filter(id => before.assignments[id] === project.id) });
    }
  }
  for (const project of after.projects) {
    const previous = before.projects.find(item => item.id === project.id);
    if (!previous) operations.push({ type: "create", ...project });
    else {
      if (project.name !== previous.name) operations.push({ type: "rename", id: project.id, name: project.name });
      if (project.collapsed !== previous.collapsed) operations.push({ type: "collapse-project", id: project.id, collapsed: project.collapsed });
    }
  }
  for (const threadId of new Set([...Object.keys(before.assignments), ...Object.keys(after.assignments)])) {
    if (before.assignments[threadId] !== after.assignments[threadId]) {
      if (removed.has(before.assignments[threadId]) && after.assignments[threadId] === undefined) continue;
      operations.push({ type: "assign", threadId, projectId: after.assignments[threadId] ?? null });
    }
  }
  for (const threadId of new Set([...before.pinned, ...after.pinned])) {
    if (before.pinned.includes(threadId) !== after.pinned.includes(threadId)) {
      if (removed.has(before.assignments[threadId]) && !after.pinned.includes(threadId)) continue;
      operations.push({ type: "pin", threadId, pinned: after.pinned.includes(threadId) });
    }
  }
  if (before.grouped !== after.grouped) operations.push({ type: "grouped", value: after.grouped });
  if (before.collapsed !== after.collapsed) operations.push({ type: "collapsed", value: after.collapsed });
  return operations;
}

export interface ThreadProjectsDocument {
  value: ThreadProjects;
  retiredProjects: string[];
  touchedAssignments: string[];
  touchedPins: string[];
  initialized: boolean;
  importsClosed?: boolean;
  generation?: number;
}

export class ThreadProjectsConflict extends Error {}

export class ThreadProjectsImportConflict extends ThreadProjectsConflict {
  constructor(public readonly code: "import-limit" | "import-closed", message: string) { super(message); }
}

export function applyThreadProjectsOperations(document: ThreadProjectsDocument, operations: ThreadProjectsOperation[]): ThreadProjectsDocument {
  const next = structuredClone(document);
  const value = next.value;
  const retired = new Set(next.retiredProjects);
  const assigned = new Set(next.touchedAssignments);
  const pinned = new Set(next.touchedPins);
  for (const op of operations) {
    if (op.type === "import") {
      if (next.importsClosed) throw new ThreadProjectsImportConflict("import-closed",
        "Automatic folder import has closed. Download your saved folders and add them manually.");
      for (const project of op.value.projects) {
        if (retired.has(project.id) || value.projects.some(existing => existing.id === project.id)) continue;
        let name = project.name;
        for (let suffix = 2; value.projects.some(existing => existing.name.toLocaleLowerCase() === name.toLocaleLowerCase()); suffix++) {
          const ending = ` (${suffix})`;
          name = `${project.name.slice(0, 100 - ending.length)}${ending}`;
        }
        value.projects.push({ ...project, name });
      }
      for (const [threadId, projectId] of Object.entries(op.value.assignments)) {
        if (!assigned.has(threadId) && !value.assignments[threadId] && value.projects.some(project => project.id === projectId)) {
          value.assignments[threadId] = projectId;
        }
      }
      for (const threadId of op.value.pinned) {
        if (!pinned.has(threadId) && !value.pinned.includes(threadId)) value.pinned.push(threadId);
      }
      if (value.projects.length > 200 || value.pinned.length > 5000 || Object.keys(value.assignments).length > 5000) {
        throw new ThreadProjectsImportConflict("import-limit",
          "Saved folders exceed the sidebar limit. Download your saved folders, free space, and retry importing.");
      }
      if (!next.initialized) {
        value.grouped = op.value.grouped;
        value.collapsed = op.value.collapsed;
      }
      next.initialized = true;
      continue;
    }
    next.initialized = true;
    switch (op.type) {
      case "create": {
        if (retired.has(op.id)) throw new ThreadProjectsConflict("This project was deleted on another device. Create a new project.");
        if (value.projects.some(project => project.id === op.id)) break;
        if ((op.generation ?? 0) !== (next.generation ?? 0)) {
          throw new ThreadProjectsConflict("Folder history changed. Refresh the sidebar and create the project again.");
        }
        if (value.projects.some(project => project.name.toLocaleLowerCase() === op.name.toLocaleLowerCase())) {
          throw new ThreadProjectsConflict("A project with this name already exists. Choose another name.");
        }
        value.projects.push({ id: op.id, name: op.name, collapsed: op.collapsed ?? false });
        break;
      }
      case "rename":
      case "collapse-project": {
        const project = value.projects.find(item => item.id === op.id);
        if (!project) throw new ThreadProjectsConflict("This project is no longer available. Refresh the sidebar.");
        if (op.type === "rename") {
          if (value.projects.some(item => item.id !== op.id && item.name.toLocaleLowerCase() === op.name.toLocaleLowerCase())) {
            throw new ThreadProjectsConflict("A project with this name already exists. Choose another name.");
          }
          project.name = op.name;
        } else project.collapsed = op.collapsed;
        break;
      }
      case "delete": {
        const archived = new Set(op.archivedThreadIds);
        if (Object.entries(value.assignments).some(([id, projectId]) => projectId === op.id && !archived.has(id))) {
          throw new ThreadProjectsConflict("This project has new chats. Refresh the sidebar and retry deleting the project.");
        }
        retired.add(op.id);
        value.projects = value.projects.filter(project => project.id !== op.id);
        const removedThreads = new Set<string>();
        for (const [id, projectId] of Object.entries(value.assignments)) if (projectId === op.id) {
          delete value.assignments[id];
          assigned.add(id);
          removedThreads.add(id);
        }
        value.pinned = value.pinned.filter(id => !removedThreads.has(id));
        for (const id of removedThreads) pinned.add(id);
        break;
      }
      case "assign":
        if (op.projectId !== null && !value.projects.some(project => project.id === op.projectId)) {
          throw new ThreadProjectsConflict("This project is no longer available. Refresh the sidebar and choose a project.");
        }
        assigned.add(op.threadId);
        if (op.projectId === null) delete value.assignments[op.threadId];
        else value.assignments[op.threadId] = op.projectId;
        break;
      case "pin":
        pinned.add(op.threadId);
        value.pinned = value.pinned.filter(id => id !== op.threadId);
        if (op.pinned) value.pinned.push(op.threadId);
        break;
      case "grouped": value.grouped = op.value; break;
      case "collapsed": value.collapsed = op.value; break;
    }
  }
  if (Math.max(retired.size, assigned.size, pinned.size) >= 20000) {
    // Closing legacy import makes old assignment and pin markers safe to discard.
    // A new generation also rejects create retries for discarded project tombstones.
    next.importsClosed = true;
    next.generation = (next.generation ?? 0) + 1;
    retired.clear();
    assigned.clear();
    pinned.clear();
  }
  next.retiredProjects = [...retired];
  next.touchedAssignments = next.importsClosed ? [] : [...assigned];
  next.touchedPins = next.importsClosed ? [] : [...pinned];
  return next;
}
