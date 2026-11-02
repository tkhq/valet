// @vitest-environment jsdom
/**
 * Memory usage view: last used and never used per file, filters and sorts
 * over them, and a trim that deletes the selected files.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemoryTreeEntry } from "@valet/api/wire";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function entry(path: string, overrides: Partial<MemoryTreeEntry> = {}): MemoryTreeEntry {
  return {
    path, title: path, type: "note", pinned: false, updatedAt: NOW - 60 * DAY, dir: false, sizeBytes: 10,
    lastUsedAt: null, useCount: 0, lastLoadedAt: null, ...overrides,
  };
}

let treeEntries: MemoryTreeEntry[] = [];
const deleteMemoryDoc = vi.fn<(path: string) => Promise<unknown>>();

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-1" }, isLoading: false, error: null }),
}));
vi.mock("~/api/memory", () => ({
  useMemoryTree: () => ({ data: { entries: treeEntries }, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock("~/api/client", () => ({
  api: { deleteMemoryDoc: (path: string) => deleteMemoryDoc(path) },
}));

import { filterUsage, isStale, MemoryUsagePanel, sortUsage, usageLabel } from "./memory-usage";

describe("usage helpers", () => {
  const recent = entry("notes/recent.md", { lastUsedAt: NOW - 2 * DAY, useCount: 4 });
  const old = entry("notes/old.md", { lastUsedAt: NOW - 45 * DAY, useCount: 9 });
  const never = entry("notes/never.md");
  const newNever = entry("notes/new.md", { updatedAt: NOW - DAY });

  it("calls a file stale when nothing used or edited it for 30 days", () => {
    expect(isStale(recent, NOW)).toBe(false);
    expect(isStale(old, NOW)).toBe(true);
    expect(isStale(never, NOW)).toBe(true);
    // Never used, but written yesterday: it has not had the chance yet.
    expect(isStale(newNever, NOW)).toBe(false);
  });

  it("filters to never-used and stale files", () => {
    const all = [recent, old, never, newNever];
    expect(filterUsage(all, "never", NOW).map((e) => e.path)).toEqual(["notes/never.md", "notes/new.md"]);
    expect(filterUsage(all, "stale", NOW).map((e) => e.path)).toEqual(["notes/old.md", "notes/never.md"]);
    expect(filterUsage(all, "all", NOW)).toHaveLength(4);
  });

  it("sorts least recently used first, never-used files at the top", () => {
    expect(sortUsage([recent, old, newNever, never], "least-recent").map((e) => e.path))
      .toEqual(["notes/never.md", "notes/new.md", "notes/old.md", "notes/recent.md"]);
    expect(sortUsage([recent, old, never], "most-used").map((e) => e.path))
      .toEqual(["notes/old.md", "notes/recent.md", "notes/never.md"]);
  });

  it("labels the last use", () => {
    expect(usageLabel(never, NOW)).toBe("Never used");
    expect(usageLabel(recent, NOW)).toBe("Used 2d ago · 4 uses");
    expect(usageLabel(entry("a.md", { lastUsedAt: NOW - DAY, useCount: 1 }), NOW)).toBe("Used 1d ago · 1 use");
  });
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryUsagePanel onSelect={vi.fn()} now={NOW} />
    </QueryClientProvider>,
  );
}

describe("MemoryUsagePanel", () => {
  beforeEach(() => {
    deleteMemoryDoc.mockReset();
    deleteMemoryDoc.mockResolvedValue({ ok: true });
    treeEntries = [
      entry("notes/recent.md", { lastUsedAt: NOW - 2 * DAY, useCount: 4 }),
      entry("notes/never.md"),
      entry("preferences/pinned.md", { pinned: true, lastLoadedAt: NOW - DAY }),
      entry("lib/mirrored.md"),
    ];
  });

  it("shows when each file was last used, and when one was only loaded at wake", () => {
    renderPanel();
    const recentRow = screen.getByRole("listitem", { name: "notes/recent.md" });
    expect(within(recentRow).getByText("Used 2d ago · 4 uses")).toBeTruthy();
    const pinnedRow = screen.getByRole("listitem", { name: "preferences/pinned.md" });
    expect(within(pinnedRow).getByText("Never used")).toBeTruthy();
    expect(within(pinnedRow).getByText("Loaded at wake 1d ago")).toBeTruthy();
  });

  it("filters to never-used files", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Never used" }));
    expect(screen.queryByRole("listitem", { name: "notes/recent.md" })).toBeNull();
    expect(screen.getByRole("listitem", { name: "notes/never.md" })).toBeTruthy();
  });

  it("offers no checkbox for a mirrored file, which only its repository can change", () => {
    renderPanel();
    const row = screen.getByRole("listitem", { name: "lib/mirrored.md" });
    expect(within(row).queryByRole("checkbox")).toBeNull();
  });

  it("deletes the selected files after a confirm", async () => {
    renderPanel();
    fireEvent.click(within(screen.getByRole("listitem", { name: "notes/never.md" })).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 file" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("notes/never.md")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 1 file" }));

    await waitFor(() => expect(deleteMemoryDoc).toHaveBeenCalledWith("notes/never.md"));
    expect(deleteMemoryDoc).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps a file it could not delete selected, and says what to do", async () => {
    deleteMemoryDoc.mockRejectedValue(new Error("not found"));
    renderPanel();
    fireEvent.click(within(screen.getByRole("listitem", { name: "notes/never.md" })).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 file" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 1 file" }));

    expect(await within(dialog).findByText(/Could not delete notes\/never\.md/)).toBeTruthy();
    expect(within(dialog).getByText(/permission to edit this workspace's memory/)).toBeTruthy();
  });
});
