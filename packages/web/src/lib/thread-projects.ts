import { useEffect, useMemo, useRef, useState } from "react";
import { CancelledError, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { applyThreadProjectsOperations, threadProjectsChanges, type ThreadProjectsOperation, type ThreadProjectsResponse } from "@valet/shared";
import { api, ApiError } from "~/api/client";
import { errorText } from "./error-text";
import { safeLocalStorage } from "./safe-storage";

const schema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), collapsed: z.boolean() })),
  pinned: z.array(z.string()).default([]),
  assignments: z.record(z.string(), z.string()),
  grouped: z.boolean(),
  collapsed: z.boolean(),
});
export type ThreadProjects = z.infer<typeof schema>;

function read(key: string): ThreadProjects {
  try {
    const parsed = schema.safeParse(JSON.parse(safeLocalStorage().getItem(key) ?? "null"));
    if (parsed.success) return parsed.data;
  } catch { /* Invalid or unavailable browser preferences. */ }
  return { pinned: [], projects: [], assignments: {}, grouped: true, collapsed: false };
}

function stored(key: string): string | null {
  try { return safeLocalStorage().getItem(key); } catch { return null; }
}
function remember(key: string, value: string) {
  try { safeLocalStorage().setItem(key, value); } catch { /* Storage can be blocked or full. The original browser data stays intact. */ }
}

/** Server preferences keep each viewer's organization separate in a shared runtime. */
export function useThreadProjects(viewerId: string, sessionId: string) {
  const client = useQueryClient();
  const key = `valet:thread-projects:${encodeURIComponent(viewerId)}:${encodeURIComponent(sessionId)}`;
  const initial = useMemo(() => read(stored(`${key}:cache-v1`) ? `${key}:cache-v1` : key), [key]);
  const queryKey = ["thread-projects", viewerId, sessionId];
  const [write, setWrite] = useState<{ key: string; pending: number; error?: string }>({ key, pending: 0 });
  const [migration, setMigration] = useState<{ key: string; error: string }>();
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Every failed save waits here for Retry sync. Saves overlap, so a later
  // success of another change must not drop an earlier failure.
  const failed = useRef<{ key: string; batches: ThreadProjectsOperation[][] } | undefined>(undefined);
  const identity = useRef({ key, epoch: 0 });
  if (identity.current.key !== key) identity.current = { key, epoch: identity.current.epoch + 1 };
  const epoch = identity.current.epoch;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setWrite({ key, pending: 0 }); failed.current = undefined; }, [key]);
  const isCurrent = () => mounted.current && identity.current.key === key && identity.current.epoch === epoch;
  const mutation = useMutation({ mutationKey: queryKey,
    networkMode: "always",
    mutationFn: (request: { sessionId: string; viewerId: string; key: string; epoch: number; operations: ThreadProjectsOperation[]; continuation: boolean }) => {
      if (!request.continuation && (!mounted.current || identity.current.key !== request.key || identity.current.epoch !== request.epoch)) throw new CancelledError({ silent: true });
      return api.changeThreadProjects(request.sessionId, request.operations, request.viewerId);
    } });
  const query = useQuery({
    queryKey,
    enabled: viewerId !== "loading",
    retry: false,
    networkMode: "always",
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    queryFn: async ({ signal }) => {
      const check = () => { if (signal.aborted || !isCurrent()) throw new CancelledError({ silent: true }); };
      let response = await api.getThreadProjects(sessionId, viewerId, signal);
      check();
      try {
        if (!stored(`${key}:synced-v1`)) {
          const legacy = stored(key);
          if (legacy) {
            let raw: unknown;
            try { raw = JSON.parse(legacy); }
            catch { throw new Error("Saved project folders could not be read. Download the saved folders before resetting browser data."); }
            const parsed = schema.safeParse(raw);
            if (!parsed.success) throw new Error("Saved project folders could not be read. Download the saved folders before resetting browser data.");
            if (parsed.data.projects.length || parsed.data.pinned.length || Object.keys(parsed.data.assignments).length) {
              check();
              response = await api.changeThreadProjects(sessionId, [{ type: "import", value: parsed.data }], viewerId, signal);
              check();
            }
          }
          remember(`${key}:synced-v1`, "1");
        }
        if (isCurrent()) setMigration(undefined);
      } catch (error) {
        check();
        setMigration({ key, error: errorText(error) });
      }
      const latest = client.getQueryData<ThreadProjectsResponse>(queryKey);
      const current = latest && latest.revision > response.revision ? latest : response;
      remember(`${key}:cache-v1`, JSON.stringify(current.value));
      return current;
    },
  });
  // Every change shows at once. The sidebar applies the change's operations
  // to the last server value, as the server will, while the save runs in the
  // background without a saving state. A save leaves the overlay in the same
  // tick that stores the server's answer, so nothing flickers. A failed save
  // drops its overlay: the sidebar shows the saved state and the error.
  const pending = useRef<{ key: string; changes: ThreadProjectsOperation[][] }>({ key, changes: [] });
  if (pending.current.key !== key) pending.current = { key, changes: [] };
  const [, rerender] = useState(0);
  // The cache, not the observer: the observer reports a new value a tick
  // after the overlay that it replaces has gone.
  const shown = () => pending.current.changes.reduce(applyLocally, client.getQueryData<ThreadProjectsResponse>(queryKey)?.value ?? initial);
  const value = shown();

  function optimistic(operations: ThreadProjectsOperation[]) {
    const owner = pending.current;
    owner.changes = [...owner.changes, operations];
    rerender(count => count + 1);
    return enqueue(operations, false, () => {
      owner.changes = owner.changes.filter(change => change !== operations);
      if (isCurrent()) rerender(count => count + 1);
    });
  }

  function update(change: ((previous: ThreadProjects) => ThreadProjects) | ThreadProjectsOperation[]) {
    const current = shown();
    const operations = typeof change === "function" ? threadProjectsChanges(current, change(current)) : change;
    return operations.length ? optimistic(operations) : Promise.resolve(current);
  }

  /** Folds one project, or the whole Projects section without a project ID. */
  function setCollapsed(collapsed: boolean, projectId?: string) {
    void update(current => projectId === undefined ? { ...current, collapsed }
      : { ...current, projects: current.projects.map(project => project.id === projectId ? { ...project, collapsed } : project) });
  }

  /** A change with `settled` is optimistic: it shows no saving state, and
   * `settled` runs as soon as its save stores an answer or fails. */
  function enqueue(change: ((previous: ThreadProjects) => ThreadProjects) | ThreadProjectsOperation[], continuation = false, settled?: () => void) {
    const counted = isCurrent() && !settled;
    if (counted) setWrite(previous => ({ key, pending: (previous.key === key ? previous.pending : 0) + 1 }));
    const task = queue.current.then(async () => {
      let operations: ThreadProjectsOperation[] = [];
      try {
        if (!continuation && !isCurrent()) return undefined;
        if (!query.data) throw new Error("Project folders have not synced. Retry loading before you save changes.");
        await client.cancelQueries({ queryKey });
        if (!continuation && !isCurrent()) return undefined;
        const previous = client.getQueryData<ThreadProjectsResponse>(queryKey) ?? query.data;
        operations = typeof change === "function" ? threadProjectsChanges(previous.value, change(previous.value)) : change;
        if (!operations.length) return previous.value;
        if (previous.generation) operations = operations.map(op => op.type === "create" && op.generation === undefined ? { ...op, generation: previous.generation } : op);
        const response = await mutation.mutateAsync({ sessionId, viewerId, key, epoch, operations, continuation });
        const latest = client.getQueryData<ThreadProjectsResponse>(queryKey);
        const current = latest && latest.revision > response.revision ? latest : response;
        client.setQueryData(queryKey, current);
        void client.invalidateQueries({ queryKey, refetchType: "none" });
        remember(`${key}:cache-v1`, JSON.stringify(current.value));
        if (isCurrent() && failed.current?.key === key) {
          failed.current.batches = failed.current.batches.filter(batch => batch !== change);
          if (!failed.current.batches.length) {
            failed.current = undefined;
            setWrite(previous => previous.key === key ? { ...previous, error: undefined } : previous);
          }
        }
        return current.value;
      } catch (error) {
        if (!isCurrent()) return undefined;
        const conflict = error instanceof ApiError && error.status === 409;
        const waiting = failed.current?.key === key ? failed.current : undefined;
        const retried = waiting?.batches.some(batch => batch === change) ?? false;
        // A conflict means the server state moved on: refetch, do not replay.
        if (conflict && waiting && retried) waiting.batches = waiting.batches.filter(batch => batch !== change);
        else if (!conflict && !retried && operations.length) {
          const batch = operations.map(op => op.type === "create" ? { ...op, generation: op.generation ?? 0 } : op);
          failed.current = { key, batches: [...(waiting?.batches ?? []), batch] };
        }
        setWrite(previous => previous.key === key ? { ...previous, error: errorText(error) } : previous);
        if (conflict) await query.refetch();
        return undefined;
      } finally {
        settled?.();
        if (counted && isCurrent()) setWrite(previous => previous.key === key ? { ...previous, pending: Math.max(0, previous.pending - 1) } : previous);
      }
    });
    queue.current = task.then(() => {});
    return task;
  }
  return {
    value, update, setCollapsed,
    beginOperation: () => ({
      update: (change: ((previous: ThreadProjects) => ThreadProjects) | ThreadProjectsOperation[]) => enqueue(change, true),
      readCurrent: () => client.getQueryData<ThreadProjectsResponse>(queryKey)?.value ?? value,
      refresh: async () => {
        const response = await api.getThreadProjects(sessionId, viewerId);
        const latest = client.getQueryData<ThreadProjectsResponse>(queryKey);
        const current = latest && latest.revision > response.revision ? latest : response;
        client.setQueryData(queryKey, current);
        remember(`${key}:cache-v1`, JSON.stringify(current.value));
        return current.value;
      },
    }),
    readCurrent: () => client.getQueryData<ThreadProjectsResponse>(queryKey)?.value ?? value,
    isLoading: query.isPending,
    isReady: query.data !== undefined,
    isSaving: write.key === key && write.pending > 0,
    unsyncedLegacy: migration?.key === key ? stored(key) : null,
    error: write.key === key && write.error ? write.error : query.error ? errorText(query.error) : migration?.key === key ? migration.error : undefined,
    retry: () => {
      if (failed.current?.key === key) return Promise.all(failed.current.batches.map(optimistic)).then(values => values.at(-1));
      setWrite(previous => previous.key === key ? { ...previous, error: undefined } : previous);
      return query.refetch();
    },
  };
}

/** The server's own rules, so the overlay matches what the save stores. A
 * change the server would refuse shows nothing; its save reports the error. */
function applyLocally(value: ThreadProjects, operations: ThreadProjectsOperation[]): ThreadProjects {
  // The overlay has no folder history, so it ignores a create's generation.
  const local = operations.map(op => op.type === "create" ? { type: op.type, id: op.id, name: op.name, ...(op.collapsed === undefined ? {} : { collapsed: op.collapsed }) } : op);
  try {
    return applyThreadProjectsOperations({ value, retiredProjects: [], touchedAssignments: [], touchedPins: [], initialized: true }, local).value;
  } catch {
    return value;
  }
}

/** Includes pinned, collapsed, filtered, and unloaded chats. */
export function projectThreadIds(value: ThreadProjects, projectId: string): string[] {
  return Object.keys(value.assignments).filter(id => value.assignments[id] === projectId);
}

/** Keep the folder if another tab assigned a new chat while archiving. */
export function removeArchivedProject(value: ThreadProjects, projectId: string, archivedIds: Set<string>): ThreadProjects {
  if (projectThreadIds(value, projectId).some(id => !archivedIds.has(id))) return value;
  return {
    ...value,
    projects: value.projects.filter(project => project.id !== projectId),
    assignments: Object.fromEntries(Object.entries(value.assignments).filter(([, id]) => id !== projectId)),
    pinned: value.pinned.filter(id => value.assignments[id] !== projectId),
  };
}
