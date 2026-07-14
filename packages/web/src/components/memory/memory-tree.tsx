import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { todayJournalPath } from "~/components/assistant/memory-card";
import { cn } from "~/lib/cn";

export interface MemoryTreeDirNode {
  kind: "dir";
  name: string;
  /** Full path from the root, e.g. `"journal"` or `"projects/valet"`. */
  path: string;
  children: MemoryTreeNode[];
}

export interface MemoryTreeFileNode {
  kind: "file";
  entry: MemoryTreeEntry;
}

export type MemoryTreeNode = MemoryTreeDirNode | MemoryTreeFileNode;

/**
 * Pure — derives a nested dir/file tree from the flat `GET /api/memory/tree`
 * listing (decision 7: the endpoint ships no dir rows on purpose; the
 * client owns tree shape). Within each directory: subdirectories first
 * (alphabetical), then files. `journal/` (and any dir literally named
 * `journal`, wherever it sits) sorts its files newest-first by path — the
 * `journal/YYYY-MM-DD.md` naming convention makes that a plain string sort.
 * Every other directory sorts files alphabetically by title (falling back
 * to path when title is empty).
 */
export function buildMemoryTree(entries: MemoryTreeEntry[]): MemoryTreeNode[] {
  interface DirAccum {
    name: string;
    path: string;
    dirs: Map<string, DirAccum>;
    files: MemoryTreeEntry[];
  }

  const root: DirAccum = { name: "", path: "", dirs: new Map(), files: [] };

  for (const entry of entries) {
    const segments = entry.path.split("/");
    const fileName = segments.pop();
    if (fileName === undefined) continue;
    let cursor = root;
    let curPath = "";
    for (const segment of segments) {
      curPath = curPath ? `${curPath}/${segment}` : segment;
      let next = cursor.dirs.get(segment);
      if (!next) {
        next = { name: segment, path: curPath, dirs: new Map(), files: [] };
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push(entry);
  }

  function isJournalDir(dir: DirAccum): boolean {
    return dir.name === "journal";
  }

  function finalize(dir: DirAccum): MemoryTreeNode[] {
    const dirNodes: MemoryTreeDirNode[] = Array.from(dir.dirs.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ kind: "dir" as const, name: d.name, path: d.path, children: finalize(d) }));

    const files = [...dir.files].sort((a, b) => {
      if (isJournalDir(dir)) return b.path.localeCompare(a.path); // newest first
      return (a.title || a.path).localeCompare(b.title || b.path);
    });
    const fileNodes: MemoryTreeFileNode[] = files.map((entry) => ({ kind: "file" as const, entry }));

    return [...dirNodes, ...fileNodes];
  }

  return finalize(root);
}

export interface MemoryTreeProps {
  entries: MemoryTreeEntry[];
  /** Currently open file's path, for the active-row highlight. */
  activePath?: string;
  onSelect: (path: string) => void;
}

/**
 * Left-pane tree (Task 6 brief): directories collapsible (top-level
 * expanded by default, nested dirs start collapsed), pinned files marked
 * 📌, active file highlighted, today's journal entry gets a "← today"
 * marker. Selection is a plain callback rather than a router `Link` — same
 * pattern as `signal-card.tsx`'s `onOpenChild` — so this renders and tests
 * without a `RouterProvider`; the route components own navigation.
 */
export function MemoryTree({ entries, activePath, onSelect }: MemoryTreeProps) {
  const nodes = buildMemoryTree(entries);
  const todayPath = todayJournalPath();

  return (
    <nav className="space-y-0.5" aria-label="Memory files">
      {nodes.map((node) => (
        <TreeRow
          key={node.kind === "dir" ? `dir:${node.path}` : `file:${node.entry.path}`}
          node={node}
          depth={0}
          activePath={activePath}
          todayPath={todayPath}
          onSelect={onSelect}
        />
      ))}
    </nav>
  );
}

function TreeRow({
  node,
  depth,
  activePath,
  todayPath,
  onSelect,
}: {
  node: MemoryTreeNode;
  depth: number;
  activePath?: string;
  todayPath: string;
  onSelect: (path: string) => void;
}) {
  // Top-level directories (depth 0) default open; anything nested starts
  // collapsed, per the brief ("dirs collapsible, default expanded
  // top-level").
  const [open, setOpen] = useState(depth === 0);

  if (node.kind === "dir") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1 rounded px-2 py-1 text-xs font-medium text-muted hover:text-ink"
          style={{ paddingLeft: 8 + depth * 12 }}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <span className="truncate">{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <TreeRow
              key={child.kind === "dir" ? `dir:${child.path}` : `file:${child.entry.path}`}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              todayPath={todayPath}
              onSelect={onSelect}
            />
          ))}
      </div>
    );
  }

  const { entry } = node;
  const isActive = activePath === entry.path;
  const isToday = entry.path === todayPath;

  return (
    <button
      type="button"
      onClick={() => onSelect(entry.path)}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm truncate",
        isActive
          ? "bg-moss/10 font-medium text-moss"
          : "text-ink hover:bg-neutral-100 dark:hover:bg-neutral-800",
      )}
      style={{ paddingLeft: 20 + depth * 12 }}
    >
      {entry.pinned && <span aria-hidden="true">📌</span>}
      <span className="truncate">{entry.title || entry.path}</span>
      {isToday && <span className="ml-auto shrink-0 text-xs text-muted">← today</span>}
    </button>
  );
}
