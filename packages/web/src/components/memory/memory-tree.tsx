import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { todayJournalPath } from "~/components/assistant/memory-card";
import { cn } from "~/lib/cn";
import { relativeTime } from "~/lib/relative-time";

export interface MemoryTreeDirNode {
  kind: "dir";
  name: string;
  /** Full path from the root, e.g. `"journal"` or `"projects/valet"`. */
  path: string;
  /** Files under this directory, recursively — the count badge. */
  fileCount: number;
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

  function countFiles(dir: DirAccum): number {
    let n = dir.files.length;
    for (const d of dir.dirs.values()) n += countFiles(d);
    return n;
  }

  function finalize(dir: DirAccum): MemoryTreeNode[] {
    const dirNodes: MemoryTreeDirNode[] = Array.from(dir.dirs.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({
        kind: "dir" as const,
        name: d.name,
        path: d.path,
        fileCount: countFiles(d),
        children: finalize(d),
      }));

    const files = [...dir.files].sort((a, b) => {
      if (isJournalDir(dir)) return b.path.localeCompare(a.path); // newest first
      return (a.title || a.path).localeCompare(b.title || b.path);
    });
    const fileNodes: MemoryTreeFileNode[] = files.map((entry) => ({ kind: "file" as const, entry }));

    return [...dirNodes, ...fileNodes];
  }

  return finalize(root);
}

/** Above this many files, top-level directories start collapsed — an
 * imported V1 archive (hundreds of files) as one flat expansion is
 * unusable. At or below it, a small tree stays fully visible. */
export const EXPAND_ALL_MAX = 15;

/** Pure: which directories start open when the user has no saved state.
 * Small tree → every top-level dir; large tree → none. */
export function defaultOpenDirs(nodes: MemoryTreeNode[], totalFiles: number): Set<string> {
  if (totalFiles > EXPAND_ALL_MAX) return new Set();
  const open = new Set<string>();
  for (const n of nodes) if (n.kind === "dir") open.add(n.path);
  return open;
}

/** Pure: every ancestor directory of a file path — `"a/b/c.md"` →
 * `["a", "a/b"]`. Used to force the active file's chain open. */
export function ancestorDirs(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  const out: string[] = [];
  let acc = "";
  for (const s of segments) {
    acc = acc ? `${acc}/${s}` : s;
    out.push(acc);
  }
  return out;
}

/** Deterministic accent color for a top-level directory — same
 * default-palette approach as the dashboard's origin pills. Orange rather
 * than amber to stay clearly apart from the `amber` "waiting" token used
 * on status dots. Class and hex arrays are index-aligned: the tree renders
 * Tailwind classes, the graph canvas needs raw hex for inline styles. */
const DIR_DOT_PALETTE = [
  "bg-sky-500",
  "bg-orange-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
];

export const DIR_HEX_PALETTE = [
  "#0ea5e9", // sky-500
  "#f97316", // orange-500
  "#8b5cf6", // violet-500
  "#f43f5e", // rose-500
  "#14b8a6", // teal-500
  "#6366f1", // indigo-500
];

export function dirPaletteIndex(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return Math.abs(h) % DIR_DOT_PALETTE.length;
}

export function dirDotClass(name: string): string {
  return DIR_DOT_PALETTE[dirPaletteIndex(name)];
}

export function dirDotHex(name: string): string {
  return DIR_HEX_PALETTE[dirPaletteIndex(name)];
}

const OPEN_DIRS_KEY = "valet:memory-tree-open";

function loadStoredOpen(): Set<string> | null {
  try {
    const raw = localStorage.getItem(OPEN_DIRS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return null;
  }
}

function storeOpen(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_DIRS_KEY, JSON.stringify([...open]));
  } catch {
    // Storage full/blocked — collapse state just won't persist.
  }
}

export interface MemoryTreeProps {
  entries: MemoryTreeEntry[];
  /** Currently open file's path, for the active-row highlight. */
  activePath?: string;
  onSelect: (path: string) => void;
}

/**
 * Left-pane tree (Task 6 brief, revised after the V1-import usability pass):
 * directories collapsible with a per-dir file count and a top-level accent
 * dot; small trees start fully open, large trees start collapsed
 * (`EXPAND_ALL_MAX`); open/closed state persists in localStorage; the
 * active file's ancestor chain is always forced open. File rows show
 * pinned 📌, a "← today" marker on today's journal entry, and a relative
 * updated-time otherwise. Selection is a plain callback rather than a
 * router `Link` — same pattern as `signal-card.tsx`'s `onOpenChild` — so
 * this renders and tests without a `RouterProvider`.
 */
export function MemoryTree({ entries, activePath, onSelect }: MemoryTreeProps) {
  const nodes = buildMemoryTree(entries);
  const todayPath = todayJournalPath();

  // null = user has never toggled anything → derive defaults per render
  // (entries arrive async; a snapshot at mount would freeze the wrong
  // default). First toggle snapshots the effective set and persists it.
  const [userOpen, setUserOpen] = useState<Set<string> | null>(() => loadStoredOpen());

  const open = new Set(userOpen ?? defaultOpenDirs(nodes, entries.length));
  for (const dir of ancestorDirs(activePath ?? "")) {
    if (!open.has(`closed:${dir}`)) open.add(dir);
  }

  // Navigating to a file clears any manual collapse of its ancestor chain,
  // so the chain re-opens even after the user closed it.
  useEffect(() => {
    if (activePath === undefined) return;
    setUserOpen((prev) => {
      if (prev === null) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const dir of ancestorDirs(activePath)) {
        if (next.has(`closed:${dir}`) || !next.has(dir)) changed = true;
        next.add(dir);
        next.delete(`closed:${dir}`);
      }
      if (!changed) return prev;
      storeOpen(next);
      return next;
    });
  }, [activePath]);

  function toggle(path: string) {
    const next = new Set(userOpen ?? open);
    if (next.has(path)) {
      next.delete(path);
      next.add(`closed:${path}`); // beat the active-chain force-open
    } else {
      next.add(path);
      next.delete(`closed:${path}`);
    }
    storeOpen(next);
    setUserOpen(next);
  }

  return (
    <nav className="space-y-0.5" aria-label="Memory files">
      {nodes.map((node) => (
        <TreeRow
          key={node.kind === "dir" ? `dir:${node.path}` : `file:${node.entry.path}`}
          node={node}
          depth={0}
          open={open}
          onToggle={toggle}
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
  open,
  onToggle,
  activePath,
  todayPath,
  onSelect,
}: {
  node: MemoryTreeNode;
  depth: number;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
  activePath?: string;
  todayPath: string;
  onSelect: (path: string) => void;
}) {
  if (node.kind === "dir") {
    const isOpen = open.has(node.path);
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="flex w-full items-center gap-1 rounded px-2 py-1 text-xs font-medium text-muted hover:text-ink"
          style={{ paddingLeft: 8 + depth * 12 }}
          aria-expanded={isOpen}
        >
          {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          {depth === 0 && (
            <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dirDotClass(node.name))} />
          )}
          <span className="truncate">{node.name}</span>
          <span className="ml-auto shrink-0 tabular-nums text-[10px] font-normal text-muted">
            {node.fileCount}
          </span>
        </button>
        {isOpen &&
          node.children.map((child) => (
            <TreeRow
              key={child.kind === "dir" ? `dir:${child.path}` : `file:${child.entry.path}`}
              node={child}
              depth={depth + 1}
              open={open}
              onToggle={onToggle}
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
        "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm",
        isActive ? "bg-moss-wash font-medium text-moss" : "text-ink hover:bg-ink-wash",
      )}
      style={{ paddingLeft: 20 + depth * 12 }}
    >
      {entry.pinned && <span aria-hidden="true">📌</span>}
      <span className="truncate">{entry.title || entry.path}</span>
      {isToday ? (
        <span className="ml-auto shrink-0 text-xs text-muted">← today</span>
      ) : (
        <span className="ml-auto shrink-0 text-[10px] text-muted">
          {relativeTime(entry.updatedAt)}
        </span>
      )}
    </button>
  );
}
