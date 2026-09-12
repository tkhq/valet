// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BakeQueueItem, ListBakeQueueResponse } from "~/api/sources";

const reorder = vi.fn();
const refetch = vi.fn();
let data: ListBakeQueueResponse | undefined;
let error: Error | null = null;
let pending = false;
let dataUpdatedAt = Date.now();
vi.mock("~/api/sources", () => ({
  useBakeQueue: () => ({ data, error, isLoading: !data && !error, refetch, dataUpdatedAt }),
  useReorderBakeQueue: () => ({ mutate: reorder, isPending: pending }),
}));
import { BakeQueuePanel } from "./bake-queue-panel";

function bake(id: string, overrides: Partial<BakeQueueItem> = {}): BakeQueueItem {
  return {
    id, sourceId: `source-${id}`, sourceName: id, sourceKind: "repo", repoFullName: `acme/${id}`,
    identityHash: "hash", commitSha: "abcdef123", imageRef: "registry/image", status: "queued",
    builderBackend: "docker", error: null, logTail: null, createdAt: 1000, startedAt: 1000,
    finishedAt: null, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  error = null;
  pending = false;
  data = { builderAvailable: true, reorderAvailable: true, running: [], queued: [], recent: [], blocked: [] };
});

describe("BakeQueuePanel", () => {
  it("shows a loading and recoverable error state", () => {
    data = undefined;
    const { rerender } = render(<BakeQueuePanel />);
    expect(screen.getByText("Loading bake queue…")).toBeTruthy();
    error = new Error("offline");
    rerender(<BakeQueuePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Retry queue" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("distinguishes an idle queue from an unavailable builder", () => {
    const { rerender } = render(<BakeQueuePanel />);
    expect(screen.getByText("No builds in progress")).toBeTruthy();
    data = { ...data!, builderAvailable: false, reorderAvailable: false };
    rerender(<BakeQueuePanel />);
    expect(screen.getByText(/Image builds are unavailable/)).toBeTruthy();
    expect(screen.queryByText("No builds in progress")).toBeNull();
  });

  it("shows running, actual queue order, waiting dependencies, and recent outcomes", () => {
    data = {
      ...data!,
      running: [bake("base", { sourceKind: "base", sourceName: "Base image", repoFullName: null, status: "building", logTail: "Installing packages" })],
      queued: [bake("zebra"), bake("alpha")],
      blocked: [{ sourceId: "blocked", name: "pending", repoFullName: "acme/pending", parentName: "Base image" }],
      recent: [bake("failed", { status: "failed", error: "Install failed", finishedAt: 2000 })],
    };
    render(<BakeQueuePanel />);
    expect(screen.getByText("Installing packages")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Move .* up$/ }).map((button) => button.getAttribute("aria-label"))).toEqual(["Move acme/zebra up", "Move acme/alpha up"]);
    expect(screen.getByText("acme/pending")).toBeTruthy();
    expect(screen.getByText("Waiting for Base image")).toBeTruthy();
    expect(screen.getByText("Build failed")).toBeTruthy();
    expect(screen.getByText("Install failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move Base image up" })).toBeNull();
  });

  it("submits the complete queue order for build-next and move-down controls", () => {
    data = { ...data!, queued: [bake("one"), bake("two"), bake("three")] };
    render(<BakeQueuePanel />);
    expect((screen.getByRole("button", { name: "Move acme/one up" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Build acme/three next" }));
    expect(reorder).toHaveBeenLastCalledWith(["three", "one", "two"], expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Move acme/one down" }));
    expect(reorder).toHaveBeenLastCalledWith(["two", "one", "three"], expect.anything());
  });

  it("disables reorder controls while saving and for unsupported builders", () => {
    data = { ...data!, queued: [bake("one"), bake("two")] };
    pending = true;
    const { rerender } = render(<BakeQueuePanel />);
    expect((screen.getByRole("button", { name: "Move acme/two up" }) as HTMLButtonElement).disabled).toBe(true);
    pending = false;
    data = { ...data, reorderAvailable: false };
    rerender(<BakeQueuePanel />);
    expect(screen.queryByRole("button", { name: "Move acme/two up" })).toBeNull();
  });

  it("keeps a finishing build visible until its result is saved", () => {
    data = { ...data!, running: [bake("one", { status: "building", phase: "finalizing" })] };
    render(<BakeQueuePanel />);
    expect(screen.getByText("Finalizing")).toBeTruthy();
    expect(screen.queryByText("No builds in progress")).toBeNull();
    expect(screen.queryByRole("button", { name: "Move acme/one up" })).toBeNull();
  });

  it("advances relative times when an unchanged queue refreshes", () => {
    const createdAt = Date.now();
    dataUpdatedAt = createdAt;
    data = { ...data!, running: [bake("one", { createdAt, status: "building" })] };
    const { rerender } = render(<BakeQueuePanel />);
    expect(screen.getByText("Submitted just now")).toBeTruthy();
    dataUpdatedAt += 120_000;
    rerender(<BakeQueuePanel />);
    expect(screen.getByText("Submitted 2m ago")).toBeTruthy();
  });

  it("shows a corrective error when a queue reorder fails", () => {
    data = { ...data!, queued: [bake("one"), bake("two")] };
    reorder.mockImplementation((_ids, options) => options.onError(new Error("conflict")));
    render(<BakeQueuePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Move acme/two up" }));
    expect(screen.getByRole("alert").textContent).toContain("Refresh the queue and try again.");
  });
});
