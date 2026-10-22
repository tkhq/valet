// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadProjects, ThreadProjectsResponse } from "@valet/shared";
import { useThreadProjects } from "./thread-projects";
import { ApiError } from "~/api/client";
import { APP_MUTATION_DEFAULTS } from "~/api/query-client";

const remote = vi.hoisted(() => ({ read: vi.fn(), change: vi.fn() }));
vi.mock("~/api/client", async importOriginal => ({ ...await importOriginal<typeof import("~/api/client")>(),
  api: { getThreadProjects: remote.read, changeThreadProjects: remote.change } }));

const empty: ThreadProjects = { projects: [], assignments: {}, pinned: [], grouped: true, collapsed: false };
const project = { id: "reports", name: "Customer reports", collapsed: false };
function client() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { ...APP_MUTATION_DEFAULTS, retry: false } } });
  return { queryClient, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> };
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  remote.read.mockResolvedValue({ value: empty, revision: 0 });
  remote.change.mockReset();
});
afterEach(() => { onlineManager.setOnline(true); focusManager.setFocused(undefined); vi.restoreAllMocks(); });

it("saves a folder to the server and loads it in a separate device cache", async () => {
  const saved: ThreadProjectsResponse = { value: { ...empty, projects: [project] }, revision: 2 };
  remote.change.mockResolvedValue(saved);
  const first = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(remote.read).toHaveBeenCalledWith("runtime", "viewer", expect.any(AbortSignal)));
  await waitFor(() => expect(first.result.current.isLoading).toBe(false));
  await act(async () => { await first.result.current.update(value => ({ ...value, projects: [project] })); });
  expect(remote.change).toHaveBeenCalledWith("runtime", [{ type: "create", ...project }], "viewer");
  remote.read.mockResolvedValue(saved);
  localStorage.clear();
  const second = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(second.result.current.value.projects).toEqual([project]));
});

it("imports existing browser data once and retains its original copy", async () => {
  const key = "valet:thread-projects:viewer:runtime";
  const original = JSON.stringify({ ...empty, projects: [project], assignments: { chat: "reports" }, pinned: ["chat"] });
  localStorage.setItem(key, original);
  const merged = { ...empty, projects: [project, { id: "desktop", name: "Desktop folder", collapsed: false }], assignments: { chat: "reports" }, pinned: ["chat"] };
  remote.change.mockResolvedValue({ value: merged, revision: 2 });
  const first = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  expect(first.result.current.value.projects).toEqual([project]);
  await waitFor(() => expect(first.result.current.value.projects).toHaveLength(2));
  expect(remote.change).toHaveBeenCalledWith("runtime", [{ type: "import", value: JSON.parse(original) }], "viewer", expect.any(AbortSignal));
  expect(localStorage.getItem(key)).toBe(original);
  expect(localStorage.getItem(`${key}:synced-v1`)).toBe("1");
  first.unmount();
  remote.read.mockResolvedValue({ value: merged, revision: 2 });
  const second = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(second.result.current.isLoading).toBe(false));
  expect(remote.change).toHaveBeenCalledTimes(1);
});

it("keeps pending legacy folders and offers retry after an import fails", async () => {
  const key = "valet:thread-projects:viewer:runtime";
  const original = JSON.stringify({ ...empty, projects: [project] });
  localStorage.setItem(key, original);
  remote.change.mockRejectedValueOnce(new Error("Offline. Reconnect and retry."));
  const hook = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(hook.result.current.error).toContain("Offline"));
  expect(hook.result.current.isReady).toBe(true);
  expect(hook.result.current.value.projects).toEqual([]);
  expect(localStorage.getItem(key)).toBe(original);
  expect(localStorage.getItem(`${key}:synced-v1`)).toBeNull();
  remote.change.mockResolvedValue({ value: { ...empty, projects: [project] }, revision: 2 });
  await act(async () => { await hook.result.current.retry(); });
  await waitFor(() => expect(hook.result.current.error).toBeUndefined());
  expect(localStorage.getItem(`${key}:synced-v1`)).toBe("1");
});

it("does not block server persistence or replace original data when browser storage is full", async () => {
  const key = "valet:thread-projects:viewer:runtime";
  const original = JSON.stringify({ ...empty, projects: [project] });
  localStorage.setItem(key, original);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage full", "QuotaExceededError"); });
  remote.change.mockResolvedValue({ value: { ...empty, projects: [project] }, revision: 2 });
  const hook = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  expect(hook.result.current.error).toBeUndefined();
  expect(remote.change).toHaveBeenCalledOnce();
  expect(localStorage.getItem(key)).toBe(original);
});

it("settles offline writes with an actionable error instead of pausing forever", async () => {
  onlineManager.setOnline(false);
  remote.change.mockRejectedValue(new Error("Offline. Reconnect and retry."));
  const hook = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  await act(async () => { await hook.result.current.update(value => ({ ...value, projects: [project] })); });
  expect(hook.result.current.isSaving).toBe(false);
  expect(hook.result.current.error).toContain("Reconnect and retry");
  expect(hook.result.current.value.projects).toEqual([]);
});

it.each(["viewer", "runtime", "unmount"])("does not import an old identity after %s changes during GET", async change => {
  const key = "valet:thread-projects:viewer:runtime";
  localStorage.setItem(key, JSON.stringify({ ...empty, projects: [project] }));
  let finish: (value: ThreadProjectsResponse) => void = () => {};
  remote.read.mockImplementationOnce(() => new Promise<ThreadProjectsResponse>(resolve => { finish = resolve; }));
  const hook = renderHook(({ viewer, runtime }) => useThreadProjects(viewer, runtime), {
    initialProps: { viewer: "viewer", runtime: "runtime" }, wrapper: client().wrapper,
  });
  await waitFor(() => expect(remote.read).toHaveBeenCalledOnce());
  if (change === "unmount") hook.unmount();
  else hook.rerender({ viewer: change === "viewer" ? "other" : "viewer", runtime: change === "runtime" ? "other" : "runtime" });
  await act(async () => { finish({ value: empty, revision: 0 }); });
  expect(remote.change).not.toHaveBeenCalled();
  expect(localStorage.getItem(`${key}:synced-v1`)).toBeNull();
  if (change !== "unmount") expect(hook.result.current.value.projects).toEqual([]);
});

it("does not send a queued write under a new viewer's identity", async () => {
  let finish: (value: ThreadProjectsResponse) => void = () => {};
  remote.change.mockImplementationOnce(() => new Promise<ThreadProjectsResponse>(resolve => { finish = resolve; }));
  const hook = renderHook(({ viewer }) => useThreadProjects(viewer, "runtime"), { initialProps: { viewer: "viewer" }, wrapper: client().wrapper });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  let first: Promise<ThreadProjects | undefined> | undefined;
  let queued: Promise<ThreadProjects | undefined> | undefined;
  act(() => {
    first = hook.result.current.update(value => ({ ...value, projects: [project] }));
    queued = hook.result.current.update(value => ({ ...value, grouped: false }));
  });
  await waitFor(() => expect(remote.change).toHaveBeenCalledOnce());
  hook.rerender({ viewer: "other" });
  await act(async () => { finish({ value: { ...empty, projects: [project] }, revision: 2 }); await first; await queued; });
  expect(remote.change).toHaveBeenCalledTimes(1);
  expect(hook.result.current.value.projects).toEqual([]);
});

it("finishes an already-owned operation only in its original viewer and runtime cache", async () => {
  const device = client();
  remote.change.mockResolvedValue({ value: { ...empty, projects: [project] }, revision: 2 });
  const hook = renderHook(({ viewer, runtime }) => useThreadProjects(viewer, runtime), {
    initialProps: { viewer: "viewer", runtime: "runtime" }, wrapper: device.wrapper,
  });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  const owner = hook.result.current.beginOperation();
  hook.rerender({ viewer: "other", runtime: "other-runtime" });
  await act(async () => { await owner.update(value => ({ ...value, projects: [project] })); });
  expect(remote.change).toHaveBeenCalledWith("runtime", [{ type: "create", ...project }], "viewer");
  expect(device.queryClient.getQueryData(["thread-projects", "viewer", "runtime"])).toEqual({ value: { ...empty, projects: [project] }, revision: 2 });
  expect(hook.result.current.value.projects).toEqual([]);
  expect(hook.result.current.isSaving).toBe(false);
});

it("keeps a new viewer's failed write available when an old continuation succeeds", async () => {
  const hook = renderHook(({ viewer }) => useThreadProjects(viewer, "runtime"), {
    initialProps: { viewer: "viewer" }, wrapper: client().wrapper,
  });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  const owner = hook.result.current.beginOperation();
  hook.rerender({ viewer: "other" });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  remote.change.mockRejectedValueOnce(new Error("Offline. Retry saving."));
  await act(async () => { await hook.result.current.update(value => ({ ...value, grouped: false })); });
  remote.change.mockResolvedValueOnce({ value: { ...empty, projects: [project] }, revision: 2 });
  await act(async () => { await owner.update(value => ({ ...value, projects: [project] })); });
  remote.change.mockResolvedValueOnce({ value: { ...empty, grouped: false }, revision: 2 });
  await act(async () => { await hook.result.current.retry(); });
  expect(remote.change).toHaveBeenLastCalledWith("runtime", [{ type: "grouped", value: false }], "other");
  expect(hook.result.current.value.grouped).toBe(false);
});

it("tracks saving correctly after an uncounted continuation finishes in a reopened scope", async () => {
  let finish: (value: ThreadProjectsResponse) => void = () => {};
  remote.change.mockImplementation(() => new Promise<ThreadProjectsResponse>(resolve => { finish = resolve; }));
  const hook = renderHook(({ viewer }) => useThreadProjects(viewer, "runtime"), {
    initialProps: { viewer: "viewer" }, wrapper: client().wrapper,
  });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  const owner = hook.result.current.beginOperation();
  hook.rerender({ viewer: "other" });
  let original: Promise<ThreadProjects | undefined> | undefined;
  act(() => { original = owner.update(value => ({ ...value, projects: [project] })); });
  await waitFor(() => expect(remote.change).toHaveBeenCalledOnce());
  hook.rerender({ viewer: "viewer" });
  await act(async () => { finish({ value: { ...empty, projects: [project] }, revision: 2 }); await original; });
  await waitFor(() => expect(hook.result.current.value.projects).toEqual([project]));
  let next: Promise<ThreadProjects | undefined> | undefined;
  act(() => { next = hook.result.current.update(value => ({ ...value, grouped: false })); });
  await waitFor(() => expect(remote.change).toHaveBeenCalledTimes(2));
  expect(hook.result.current.isSaving).toBe(true);
  await act(async () => { finish({ value: { ...empty, projects: [project], grouped: false }, revision: 3 }); await next; });
  expect(hook.result.current.isSaving).toBe(false);
});

it("refreshes changes from another device on window focus", async () => {
  const hook = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  act(() => focusManager.setFocused(false));
  remote.read.mockResolvedValue({ value: { ...empty, projects: [project] }, revision: 3 });
  act(() => focusManager.setFocused(true));
  await waitFor(() => expect(hook.result.current.value.projects).toEqual([project]));
});

it("refreshes after a conflict and requires a fresh delete operation instead of replaying its stale snapshot", async () => {
  const before: ThreadProjects = { ...empty, projects: [project], assignments: { first: "reports" } };
  const latest: ThreadProjects = { ...before, assignments: { first: "reports", added: "reports" } };
  remote.read.mockResolvedValueOnce({ value: before, revision: 2 }).mockResolvedValue({ value: latest, revision: 3 });
  remote.change.mockRejectedValueOnce(new ApiError(409, "Sidebar changed", { error: "This project has new chats. Refresh and retry deleting." }));
  const hook = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  await act(async () => { await hook.result.current.update(value => ({ ...value, projects: [], assignments: {} })); });
  expect(hook.result.current.value.assignments).toEqual({ first: "reports", added: "reports" });
  await act(async () => { await hook.result.current.retry(); });
  expect(remote.change).toHaveBeenCalledTimes(1);
  remote.change.mockResolvedValueOnce({ value: empty, revision: 4 });
  await act(async () => { await hook.result.current.update(value => ({ ...value, projects: [], assignments: {} })); });
  expect(remote.change).toHaveBeenLastCalledWith("runtime", [{ type: "delete", id: "reports", archivedThreadIds: ["first", "added"] }], "viewer");
});

it("keeps server folders usable and original data recoverable after an oversized import", async () => {
  const key = "valet:thread-projects:viewer:runtime";
  const original = JSON.stringify({ ...empty, projects: [project] });
  const desktop = { id: "desktop", name: "Desktop", collapsed: false };
  localStorage.setItem(key, original);
  remote.read.mockResolvedValue({ value: { ...empty, projects: [desktop] }, revision: 3 });
  remote.change.mockRejectedValueOnce(new ApiError(409, "Import limit", { error: "Remove unused server folders and retry importing.", code: "import-limit" }));
  const hook = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(hook.result.current.error).toContain("Remove unused"));
  expect(hook.result.current.isReady).toBe(true);
  expect(hook.result.current.value.projects).toEqual([desktop]);
  expect(hook.result.current.unsyncedLegacy).toBe(original);
  expect(localStorage.getItem(key)).toBe(original);
  expect(localStorage.getItem(`${key}:synced-v1`)).toBeNull();
  remote.change.mockResolvedValue({ value: { ...empty, projects: [{ ...desktop, name: "Renamed" }] }, revision: 4 });
  await act(async () => { await hook.result.current.update(value => ({ ...value, projects: [{ ...desktop, name: "Renamed" }] })); });
  expect(remote.change).toHaveBeenLastCalledWith("runtime", [{ type: "rename", id: "desktop", name: "Renamed" }], "viewer");
});

it("stamps a new folder with the server generation after history compaction", async () => {
  remote.read.mockResolvedValue({ value: empty, revision: 3, generation: 2 });
  remote.change.mockResolvedValue({ value: { ...empty, projects: [project] }, revision: 4, generation: 2 });
  const hook = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: client().wrapper });
  await waitFor(() => expect(hook.result.current.isReady).toBe(true));
  await act(async () => { await hook.result.current.update(value => ({ ...value, projects: [project] })); });
  expect(remote.change).toHaveBeenLastCalledWith("runtime", [{ type: "create", ...project, generation: 2 }], "viewer");
});

it("does not upgrade a failed create retry into a generation that can resurrect its deleted ID", async () => {
  const device = client();
  remote.change.mockRejectedValueOnce(new Error("Response lost"));
  const hook = renderHook(() => useThreadProjects("viewer", "runtime"), { wrapper: device.wrapper });
  await waitFor(() => expect(hook.result.current.isReady).toBe(true));
  await act(async () => { await hook.result.current.update(value => ({ ...value, projects: [project] })); });
  const compacted = { value: empty, revision: 10, generation: 1 };
  act(() => device.queryClient.setQueryData(["thread-projects", "viewer", "runtime"], compacted));
  remote.read.mockResolvedValue(compacted);
  remote.change.mockRejectedValueOnce(new ApiError(409, "Stale create", { error: "Refresh and create a new folder." }));
  await act(async () => { await hook.result.current.retry(); });
  expect(remote.change).toHaveBeenLastCalledWith("runtime", [{ type: "create", ...project, generation: 0 }], "viewer");
  expect(hook.result.current.value.projects).toEqual([]);
});
