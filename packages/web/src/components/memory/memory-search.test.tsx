// @vitest-environment jsdom
/**
 * Memory search pane (Task 6 brief): debounced 250ms, results replace the
 * tree while active, ESC/clear restores it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const treeEntries = [
  { path: "a.md", title: "Alpha note", type: "note", pinned: false, updatedAt: 0, dir: false, sizeBytes: 10 },
];
const searchResults = [
  { path: "b.md", title: "Beta match", description: "a matching description", type: "note", rank: 1 },
];

vi.mock("~/api/memory", () => ({
  useMemoryTree: () => ({
    data: { entries: treeEntries },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMemorySearch: () => ({
    data: { results: searchResults },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

import { MemorySearchPane } from "./memory-search";

describe("MemorySearchPane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the tree at rest", () => {
    render(<MemorySearchPane onSelect={vi.fn()} />);
    expect(screen.getByText("Alpha note")).toBeTruthy();
    expect(screen.queryByText("Beta match")).toBeNull();
  });

  it("swaps the tree for results after the debounce settles", () => {
    render(<MemorySearchPane onSelect={vi.fn()} />);
    const input = screen.getByLabelText("Search memory");

    fireEvent.change(input, { target: { value: "beta" } });
    // Still within the debounce window — tree stays.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByText("Alpha note")).toBeTruthy();
    expect(screen.queryByText("Beta match")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Alpha note")).toBeNull();
    expect(screen.getByText("Beta match")).toBeTruthy();
  });

  it("clear button restores the tree", () => {
    render(<MemorySearchPane onSelect={vi.fn()} />);
    const input = screen.getByLabelText("Search memory") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "beta" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText("Beta match")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Clear search"));
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText("Alpha note")).toBeTruthy();
    expect(screen.queryByText("Beta match")).toBeNull();
  });

  it("Escape restores the tree", () => {
    render(<MemorySearchPane onSelect={vi.fn()} />);
    const input = screen.getByLabelText("Search memory") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "beta" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText("Beta match")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText("Alpha note")).toBeTruthy();
  });

  it("calls onSelect with a search result's path when clicked", () => {
    const onSelect = vi.fn();
    render(<MemorySearchPane onSelect={onSelect} />);
    const input = screen.getByLabelText("Search memory");
    fireEvent.change(input, { target: { value: "beta" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    fireEvent.click(screen.getByText("Beta match"));
    expect(onSelect).toHaveBeenCalledWith("b.md");
  });
});
