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
  {
    path: "b.md",
    title: "Beta match",
    description: "a matching description",
    type: "note",
    rank: 1,
    snippet: [
      { text: "the line that holds the ", match: false },
      { text: "beta", match: true },
      { text: " term", match: false },
    ],
  },
  // Agent-authored bodies can hold anything. The snippet is text, so this
  // must render as visible characters, not as an element.
  {
    path: "c.md",
    title: "Gamma match",
    description: "",
    type: "note",
    rank: 0.5,
    snippet: [{ text: '<img src=x onerror="boom"> beta', match: false }],
  },
];

// The pane reads the workspace it is searching. `useListOwner` needs the
// caller's own id, because the switcher holds a routing key rather than a
// principal — mocked here rather than wrapping in a provider, matching how
// this file already isolates the pane from the network.
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-1" }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: false } }, isLoading: false, error: null }),
}));

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

  /** Without the snippet, a result list of 300 journal entries is a list of
   * dates: the reader has to open each file to find out why it matched. */
  it("shows the matched text and marks the matched words", () => {
    const { container } = render(<MemorySearchPane onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search memory"), { target: { value: "beta" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(screen.getByText("the line that holds the")).toBeTruthy();
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("beta");
  });

  /** `ts_headline` marks hits with `<b>` by default and memory documents
   * are agent-authored — the snippet must reach the DOM as text, never as
   * markup the browser parses. */
  it("renders snippet text literally, never as HTML", () => {
    const { container } = render(<MemorySearchPane onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search memory"), { target: { value: "beta" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="boom"> beta')).toBeTruthy();
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
