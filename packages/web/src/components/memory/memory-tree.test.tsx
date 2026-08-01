// @vitest-environment jsdom
/**
 * Memory tree derivation + rendering (Task 6 brief): dirs, pinned marker,
 * journal newest-first ordering, and today's highlight.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MemoryTreeEntry } from "@valet/api/wire";
import {
  ancestorDirs,
  buildMemoryTree,
  defaultOpenDirs,
  EXPAND_ALL_MAX,
  MemoryTree,
} from "./memory-tree";

function entry(overrides: Partial<MemoryTreeEntry> = {}): MemoryTreeEntry {
  return {
    path: "note.md",
    title: "Note",
    type: "note",
    pinned: false,
    updatedAt: Date.now(),
    dir: false,
    sizeBytes: 100,
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

  it("counts files recursively per directory", () => {
    const entries = [
      entry({ path: "projects/a.md" }),
      entry({ path: "projects/valet/b.md" }),
      entry({ path: "projects/valet/c.md" }),
    ];
    const tree = buildMemoryTree(entries);
    const projects = tree.find((n) => n.kind === "dir" && n.name === "projects");
    expect(projects?.kind).toBe("dir");
    if (projects?.kind === "dir") {
      expect(projects.fileCount).toBe(3);
      const valet = projects.children.find((c) => c.kind === "dir");
      if (valet?.kind === "dir") expect(valet.fileCount).toBe(2);
    }
  });
});

describe("defaultOpenDirs", () => {
  it("opens all top-level dirs for a small tree", () => {
    const entries = [entry({ path: "journal/a.md" }), entry({ path: "notes/b.md" })];
    const open = defaultOpenDirs(buildMemoryTree(entries), entries.length);
    expect(open).toEqual(new Set(["journal", "notes"]));
  });

  it("opens nothing above EXPAND_ALL_MAX files (large V1 import)", () => {
    const entries = Array.from({ length: EXPAND_ALL_MAX + 1 }, (_, i) =>
      entry({ path: `journal/2026-01-${String(i + 1).padStart(2, "0")}.md` }),
    );
    const open = defaultOpenDirs(buildMemoryTree(entries), entries.length);
    expect(open.size).toBe(0);
  });
});

describe("ancestorDirs", () => {
  it("lists every ancestor of a nested path", () => {
    expect(ancestorDirs("a/b/c.md")).toEqual(["a", "a/b"]);
  });

  it("is empty for a root-level file", () => {
    expect(ancestorDirs("note.md")).toEqual([]);
  });
});

describe("MemoryTree component", () => {
  beforeEach(() => {
    // Clear persisted open-state between tests. Node ≥22 ships a stub
    // `localStorage` global (methods undefined without --localstorage-file)
    // that can shadow jsdom's — the component's own storage calls are
    // try/caught for the same reason.
    try {
      window.localStorage.removeItem("valet:memory-tree-open");
    } catch {
      // stubbed storage — nothing persisted, nothing to clear
    }
  });

  it("starts collapsed for a large tree and expands a dir on click", () => {
    const entries = Array.from({ length: EXPAND_ALL_MAX + 1 }, (_, i) =>
      entry({ path: `notes/n${i}.md`, title: `Note ${i}` }),
    );
    render(<MemoryTree entries={entries} onSelect={vi.fn()} />);
    expect(screen.queryByText("Note 0")).toBeNull();
    fireEvent.click(screen.getByText("notes"));
    expect(screen.queryByText("Note 0")).toBeTruthy();
  });

  it("shows a per-directory file count", () => {
    render(
      <MemoryTree
        entries={[entry({ path: "notes/a.md" }), entry({ path: "notes/b.md", title: "B" })]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("keeps the active file's ancestors open in a large tree", () => {
    const entries = Array.from({ length: EXPAND_ALL_MAX + 1 }, (_, i) =>
      entry({ path: `notes/n${i}.md`, title: `Note ${i}` }),
    );
    render(<MemoryTree entries={entries} activePath="notes/n3.md" onSelect={vi.fn()} />);
    expect(screen.queryByText("Note 3")).toBeTruthy();
  });

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
