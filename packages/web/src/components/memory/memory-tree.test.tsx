// @vitest-environment jsdom
/**
 * Memory tree derivation + rendering (Task 6 brief): dirs, pinned marker,
 * journal newest-first ordering, and today's highlight.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { buildMemoryTree, MemoryTree } from "./memory-tree";

function entry(overrides: Partial<MemoryTreeEntry> = {}): MemoryTreeEntry {
  return {
    path: "note.md",
    title: "Note",
    type: "note",
    pinned: false,
    updatedAt: Date.now(),
    dir: false,
    ...overrides,
  };
}

describe("buildMemoryTree", () => {
  it("derives nested directories from flat paths", () => {
    const entries = [
      entry({ path: "projects/valet/notes.md", title: "Notes" }),
      entry({ path: "preferences/style.md", title: "Style" }),
    ];
    const tree = buildMemoryTree(entries);
    expect(tree.map((n) => (n.kind === "dir" ? n.name : n.entry.path))).toEqual([
      "preferences",
      "projects",
    ]);
    const projects = tree.find((n) => n.kind === "dir" && n.name === "projects");
    expect(projects?.kind).toBe("dir");
    if (projects?.kind === "dir") {
      const valet = projects.children[0];
      expect(valet.kind).toBe("dir");
      if (valet.kind === "dir") {
        expect(valet.path).toBe("projects/valet");
        expect(valet.children).toHaveLength(1);
        expect(valet.children[0]).toEqual({ kind: "file", entry: entries[0] });
      }
    }
  });

  it("root-level files sort alongside directories, dirs first", () => {
    const entries = [entry({ path: "root-note.md", title: "Zebra" }), entry({ path: "preferences/a.md" })];
    const tree = buildMemoryTree(entries);
    expect(tree[0].kind).toBe("dir");
    expect(tree[1].kind).toBe("file");
  });

  it("sorts journal/ files newest-first by path", () => {
    const entries = [
      entry({ path: "journal/2026-07-10.md", title: "old" }),
      entry({ path: "journal/2026-07-13.md", title: "new" }),
      entry({ path: "journal/2026-07-11.md", title: "mid" }),
    ];
    const tree = buildMemoryTree(entries);
    const journalDir = tree.find((n) => n.kind === "dir" && n.name === "journal");
    expect(journalDir?.kind).toBe("dir");
    if (journalDir?.kind === "dir") {
      expect(journalDir.children.map((c) => (c.kind === "file" ? c.entry.path : ""))).toEqual([
        "journal/2026-07-13.md",
        "journal/2026-07-11.md",
        "journal/2026-07-10.md",
      ]);
    }
  });

  it("sorts non-journal directories alphabetically by title", () => {
    const entries = [
      entry({ path: "preferences/b.md", title: "Bravo" }),
      entry({ path: "preferences/a.md", title: "Alpha" }),
    ];
    const tree = buildMemoryTree(entries);
    const prefsDir = tree.find((n) => n.kind === "dir" && n.name === "preferences");
    expect(prefsDir?.kind).toBe("dir");
    if (prefsDir?.kind === "dir") {
      expect(prefsDir.children.map((c) => (c.kind === "file" ? c.entry.title : ""))).toEqual([
        "Alpha",
        "Bravo",
      ]);
    }
  });

  it("returns an empty tree for no entries", () => {
    expect(buildMemoryTree([])).toEqual([]);
  });
});

describe("MemoryTree component", () => {
  it("marks pinned files with 📌", () => {
    render(
      <MemoryTree
        entries={[entry({ path: "preferences/style.md", title: "Style", pinned: true })]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/📌/)).toBeTruthy();
    expect(screen.getByText("Style")).toBeTruthy();
  });

  it("highlights today's journal entry with a marker", () => {
    const todayPath = `journal/${new Date().toISOString().slice(0, 10)}.md`;
    render(<MemoryTree entries={[entry({ path: todayPath, title: "Today" })]} onSelect={vi.fn()} />);
    expect(screen.getByText("← today")).toBeTruthy();
  });

  it("does not mark a non-today journal entry", () => {
    render(
      <MemoryTree entries={[entry({ path: "journal/2020-01-01.md", title: "Old" })]} onSelect={vi.fn()} />,
    );
    expect(screen.queryByText("← today")).toBeNull();
  });

  it("highlights the active file", () => {
    render(
      <MemoryTree
        entries={[entry({ path: "preferences/style.md", title: "Style" })]}
        activePath="preferences/style.md"
        onSelect={vi.fn()}
      />,
    );
    const btn = screen.getByText("Style").closest("button");
    expect(btn?.getAttribute("aria-current")).toBe("page");
  });

  it("calls onSelect with the file's path when clicked", () => {
    const onSelect = vi.fn();
    render(
      <MemoryTree entries={[entry({ path: "preferences/style.md", title: "Style" })]} onSelect={onSelect} />,
    );
    screen.getByText("Style").click();
    expect(onSelect).toHaveBeenCalledWith("preferences/style.md");
  });
});
