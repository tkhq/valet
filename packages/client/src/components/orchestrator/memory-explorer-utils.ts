import type { MemoryFileListing } from '@/api/types';

export interface ImportableFile {
  path: string;
  content: string;
}

// ─── Directory tree ─────────────────────────────────────────────────────────
//
// Shared by the dashboard memory card and the full memory page's file list.

export interface MemoryTreeNode {
  name: string;
  path: string;
  files: MemoryFileListing[];
  children: MemoryTreeNode[];
  totalFiles: number;
  totalSize: number;
}

export function buildMemoryTree(files: MemoryFileListing[]): MemoryTreeNode[] {
  const root: MemoryTreeNode = { name: '', path: '', files: [], children: [], totalFiles: 0, totalSize: 0 };

  for (const file of files) {
    const segments = file.path.split('/');
    let current = root;

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let child = current.children.find((c) => c.name === seg);
      if (!child) {
        const childPath = segments.slice(0, i + 1).join('/');
        child = { name: seg, path: childPath, files: [], children: [], totalFiles: 0, totalSize: 0 };
        current.children.push(child);
      }
      current = child;
    }

    current.files.push(file);
  }

  function computeTotals(node: MemoryTreeNode) {
    let totalFiles = node.files.length;
    let totalSize = node.files.reduce((s, f) => s + f.size, 0);
    node.files = sortFilesForDisplay(node.files);
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of node.children) {
      computeTotals(child);
      totalFiles += child.totalFiles;
      totalSize += child.totalSize;
    }
    node.totalFiles = totalFiles;
    node.totalSize = totalSize;
  }

  computeTotals(root);
  root.children.sort((a, b) => a.name.localeCompare(b.name));
  return root.children;
}

export function collectDirPaths(nodes: MemoryTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    paths.push(node.path);
    paths.push(...collectDirPaths(node.children));
  }
  return paths;
}

export function fileName(path: string): string {
  const slashIdx = path.lastIndexOf('/');
  return slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ─── Directory color themes ─────────────────────────────────────────────────
//
// Shared by memory-explorer.tsx (tree headers) and memory-graph.tsx (node
// fills) — kept here, rather than in either component file, so the two don't
// need to import from one another. `hex` mirrors the Tailwind `-500` swatch
// used by `dot`/`bg`/`text`; it exists so non-Tailwind consumers (the SVG
// graph view needs a literal fill color, not a class name) can reuse this one
// theme map instead of duplicating a directory-to-color table.

export interface DirColorTheme {
  dot: string;
  bg: string;
  text: string;
  hex: string;
}

export const DIR_COLORS: Record<string, DirColorTheme> = {
  preferences: {
    dot: 'bg-amber-500',
    bg: 'bg-amber-500/8 dark:bg-amber-400/8',
    text: 'text-amber-700 dark:text-amber-400',
    hex: '#f59e0b',
  },
  preference: {
    dot: 'bg-amber-500',
    bg: 'bg-amber-500/8 dark:bg-amber-400/8',
    text: 'text-amber-700 dark:text-amber-400',
    hex: '#f59e0b',
  },
  projects: {
    dot: 'bg-sky-500',
    bg: 'bg-sky-500/8 dark:bg-sky-400/8',
    text: 'text-sky-700 dark:text-sky-400',
    hex: '#0ea5e9',
  },
  project: {
    dot: 'bg-sky-500',
    bg: 'bg-sky-500/8 dark:bg-sky-400/8',
    text: 'text-sky-700 dark:text-sky-400',
    hex: '#0ea5e9',
  },
  context: {
    dot: 'bg-emerald-500',
    bg: 'bg-emerald-500/8 dark:bg-emerald-400/8',
    text: 'text-emerald-700 dark:text-emerald-400',
    hex: '#10b981',
  },
  workflows: {
    dot: 'bg-violet-500',
    bg: 'bg-violet-500/8 dark:bg-violet-400/8',
    text: 'text-violet-700 dark:text-violet-400',
    hex: '#8b5cf6',
  },
  workflow: {
    dot: 'bg-violet-500',
    bg: 'bg-violet-500/8 dark:bg-violet-400/8',
    text: 'text-violet-700 dark:text-violet-400',
    hex: '#8b5cf6',
  },
  journal: {
    dot: 'bg-rose-500',
    bg: 'bg-rose-500/8 dark:bg-rose-400/8',
    text: 'text-rose-700 dark:text-rose-400',
    hex: '#f43f5e',
  },
  notes: {
    dot: 'bg-neutral-400 dark:bg-neutral-500',
    bg: 'bg-neutral-500/6 dark:bg-neutral-400/6',
    text: 'text-neutral-600 dark:text-neutral-400',
    hex: '#a3a3a3',
  },
  people: {
    dot: 'bg-teal-500',
    bg: 'bg-teal-500/8 dark:bg-teal-400/8',
    text: 'text-teal-700 dark:text-teal-400',
    hex: '#14b8a6',
  },
};

export const DEFAULT_DIR_COLOR: DirColorTheme = {
  dot: 'bg-neutral-400 dark:bg-neutral-500',
  bg: 'bg-neutral-500/6 dark:bg-neutral-400/6',
  text: 'text-neutral-600 dark:text-neutral-400',
  hex: '#a3a3a3',
};

export function getDirColor(dir: string): DirColorTheme {
  return DIR_COLORS[dir.toLowerCase()] ?? DEFAULT_DIR_COLOR;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Pulls importable { path, content } entries out of a parsed JSON value.
 * Accepts an OKF export manifest (`{ files: { path: { content } } }`), a legacy
 * export bundle (`{ files: [...] }`), or a bare array, and drops anything that
 * isn't a non-empty string path with string content.
 */
export function extractImportFiles(parsed: unknown): ImportableFile[] {
  const out: ImportableFile[] = [];

  const filesField = isRecord(parsed) ? parsed.files : undefined;

  // OKF manifest map form: path → { content } (or path → content string).
  if (isRecord(filesField)) {
    for (const [path, entry] of Object.entries(filesField)) {
      if (!path.trim()) continue;
      if (typeof entry === 'string') {
        out.push({ path, content: entry });
      } else if (isRecord(entry) && typeof entry.content === 'string') {
        out.push({ path, content: entry.content });
      }
    }
    return out;
  }

  // Legacy array forms: bare array or { files: [...] }.
  const raw = Array.isArray(parsed) ? parsed : Array.isArray(filesField) ? filesField : [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { path, content } = item;
    if (typeof path === 'string' && path.trim() && typeof content === 'string') {
      out.push({ path, content });
    }
  }
  return out;
}

/** Caps a tag list for compact row display: at most `max` tags plus an overflow count. */
export function capTags(tags: string[], max = 4): { shown: string[]; overflow: number } {
  if (tags.length <= max) return { shown: tags, overflow: 0 };
  return { shown: tags.slice(0, max), overflow: tags.length - max };
}

/**
 * Tags for row display: drops tags that duplicate the file's `type` (already
 * shown as its own badge on the same row), then caps for compactness.
 */
export function displayTags(
  tags: string[],
  type: string,
  max = 4,
): { shown: string[]; overflow: number } {
  const typeLower = type.trim().toLowerCase();
  const deduped = typeLower ? tags.filter((t) => t.trim().toLowerCase() !== typeLower) : tags;
  return capTags(deduped, max);
}

/**
 * Display order for files within a directory: pinned first, then most
 * recently updated, then path for a stable tiebreak. Returns a new array.
 */
export function sortFilesForDisplay<T extends { path: string; updatedAt: string; pinned: boolean }>(
  files: T[],
): T[] {
  return [...files].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const at = Date.parse(a.updatedAt);
    const bt = Date.parse(b.updatedAt);
    const av = Number.isNaN(at) ? 0 : at;
    const bv = Number.isNaN(bt) ? 0 : bt;
    if (av !== bv) return bv - av;
    return a.path.localeCompare(b.path);
  });
}

/**
 * Extracts a displayable hostname from a `resource` field, for use as the
 * label of an outbound link chip. Returns null when `resource` is empty or
 * isn't a valid absolute URL (e.g. a bare path or malformed string).
 */
export function resourceHostname(resource: string): string | null {
  const trimmed = resource.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname;
  } catch {
    return null;
  }
}

/**
 * Client-side mirror of the worker's `resolveLinkTarget` + `normalizePath`
 * (packages/worker/src/lib/memory-okf-helpers.ts): turns an anchor href found
 * inside rendered memory markdown into a memory file path, or null when the
 * link is external / anchor-only and should keep its default browser behavior.
 *
 * Resolution rules (must stay in sync with the worker):
 * - any scheme (https:, mailto:, …) → null (external)
 * - `#anchor` only → null
 * - leading `/` → memory-root-relative
 * - otherwise relative to `fromPath`'s directory, with `.`/`..` resolution
 * - normalized: lowercased, spaces/underscores → hyphens, invalid chars dropped
 */
export function resolveMemoryLinkTarget(fromPath: string, href: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    decoded = href;
  }

  // Any scheme'd URL (https:, mailto:, tel:, …) is external — leave it alone.
  if (/^[a-z][a-z0-9+\-.]*:/i.test(decoded)) return null;

  const hashIdx = decoded.indexOf('#');
  if (hashIdx === 0) return null; // anchor-only — not a cross-file link
  const path = hashIdx > 0 ? decoded.slice(0, hashIdx) : decoded;
  if (!path) return null;

  let absolute: string;
  if (path.startsWith('/')) {
    absolute = path.slice(1);
  } else {
    const lastSlash = fromPath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? fromPath.slice(0, lastSlash + 1) : '';
    absolute = dir + path;
  }

  // Resolve . and .. segments manually (pure path math, no URL object).
  const resolved: string[] = [];
  for (const seg of absolute.split('/')) {
    if (seg === '..') resolved.pop();
    else if (seg !== '.' && seg !== '') resolved.push(seg);
  }

  const normalized = resolved
    .join('/')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-./]/g, '');
  return normalized || null;
}

/** True when `expires` parses to a valid timestamp that is in the past relative to `now`. */
export function isExpired(expires: string | null, now: Date = new Date()): boolean {
  if (!expires) return false;
  const t = Date.parse(expires);
  return !Number.isNaN(t) && t < now.getTime();
}
