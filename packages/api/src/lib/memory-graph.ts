/**
 * Derived memory graph — V2 has no stored links table (decision 12 fenced
 * it off), so `GET /api/memory/graph` derives the whole graph per request
 * from `memory_files` content. Link extraction ports V1's
 * `memory-okf-helpers.ts` rules: markdown `[text](target)` links, code
 * fences and inline code skipped, external URLs and anchors skipped,
 * relative targets resolved against the source file's directory,
 * `/rooted` targets resolved from the bundle root.
 *
 * Node classes:
 *   - `concept` — a stored file.
 *   - `dir`     — one hub per top-level directory (`containment` edges to
 *                 its files) so the graph has structure even where link
 *                 density is low.
 *   - `phantom` — a link target that resolves to no stored file (a
 *                 dangling reference worth seeing), capped and filtered
 *                 to path-shaped targets only.
 */

export interface MemoryGraphNode {
  id: string;
  kind: "concept" | "dir" | "phantom";
  /** concept/phantom: the (target) path. */
  path?: string;
  title?: string;
  type?: string;
  /** concept: first path segment, "" for root files — the color key. */
  topDir?: string;
}

export interface MemoryGraphEdge {
  from: string;
  to: string;
  kind: "link" | "containment";
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

/** Hard node cap — matches V1's whole-bundle explorer cap. */
export const MAX_GRAPH_NODES = 500;
/** Phantom (dangling-target) node cap: signal, not noise. */
export const MAX_PHANTOM_NODES = 40;
/** Per-file link-scan budget. Link extraction is O(content) per request;
 * without a cap, 500 multi-MB files make GET /graph an OOM/DoS vector.
 * Links past this offset are simply not discovered. */
export const MAX_SCAN_CHARS = 256 * 1024;

export interface GraphSourceFile {
  path: string;
  title: string;
  type: string;
  content: string;
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Resolve a markdown link target to a bundle path, or null when the target
 * is not a cross-file reference (external URL, anchor, template garbage).
 */
export function resolveLinkTarget(fromPath: string, target: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }

  if (/^[a-z][a-z0-9+\-.]*:/i.test(decoded)) return null; // any scheme (http:, mailto:)
  if (/[{}<>]/.test(decoded)) return null; // template placeholders like {url}

  const hashIdx = decoded.indexOf("#");
  if (hashIdx === 0) return null; // anchor-only
  const path = hashIdx > 0 ? decoded.slice(0, hashIdx) : decoded;
  if (path === "") return null;

  let absolute: string;
  if (path.startsWith("/")) {
    absolute = path.slice(1);
  } else {
    const lastSlash = fromPath.lastIndexOf("/");
    const dir = lastSlash >= 0 ? fromPath.slice(0, lastSlash + 1) : "";
    absolute = dir + path;
  }

  const resolved: string[] = [];
  for (const seg of absolute.split("/")) {
    if (seg === "..") resolved.pop();
    else if (seg !== "." && seg !== "") resolved.push(seg);
  }
  const joined = resolved.join("/");
  return joined === "" ? null : joined;
}

/** Markdown `[text](target)` targets in `body`, resolved to bundle paths,
 * deduped, code fences and inline code skipped. */
export function extractLinkTargets(fromPath: string, body: string): string[] {
  const seen = new Set<string>();
  let inFence = false;

  const scanBody = body.length > MAX_SCAN_CHARS ? body.slice(0, MAX_SCAN_CHARS) : body;
  for (const rawLine of scanBody.split("\n")) {
    if (rawLine.startsWith("```") || rawLine.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = rawLine.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_RE.exec(line)) !== null) {
      const toPath = resolveLinkTarget(fromPath, match[2] ?? "");
      if (toPath !== null && toPath !== fromPath) seen.add(toPath);
    }
  }

  return [...seen];
}

/** A dangling target only becomes a phantom node when it plausibly names a
 * memory file — inside a directory or with a .md suffix. */
function isPathShaped(target: string): boolean {
  return target.includes("/") || target.endsWith(".md");
}

export function buildMemoryGraph(files: GraphSourceFile[]): MemoryGraph {
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  const capped = files.slice(0, MAX_GRAPH_NODES);
  const includedPaths = new Set(capped.map((f) => f.path));

  for (const f of capped) {
    const topDir = f.path.includes("/") ? f.path.split("/")[0]! : "";
    nodes.push({ id: f.path, kind: "concept", path: f.path, title: f.title, type: f.type, topDir });
  }

  // Directory hubs + containment.
  const dirs = new Map<string, number>();
  for (const f of capped) {
    if (!f.path.includes("/")) continue;
    const top = f.path.split("/")[0]!;
    dirs.set(top, (dirs.get(top) ?? 0) + 1);
    edges.push({ from: `dir:${top}`, to: f.path, kind: "containment" });
  }
  for (const dir of dirs.keys()) {
    nodes.push({ id: `dir:${dir}`, kind: "dir", title: dir, topDir: dir });
  }

  // Link edges + phantom targets, one extraction pass per file. A link to
  // a file beyond the node cap is dropped with its endpoint (mirrors V1's
  // truncation rule). Targets tolerate extension drift (`a/b` ↔ `a/b.md`).
  const phantoms = new Map<string, number>();
  const pendingPhantomEdges: MemoryGraphEdge[] = [];
  const edgeSeen = new Set<string>();
  for (const f of capped) {
    for (const target of extractLinkTargets(f.path, f.content)) {
      const resolvedTarget = byPath.has(target)
        ? target
        : byPath.has(`${target}.md`)
          ? `${target}.md`
          : target;

      const key = `${f.path}→${resolvedTarget}`;
      if (edgeSeen.has(key)) continue;

      if (includedPaths.has(resolvedTarget)) {
        edgeSeen.add(key);
        edges.push({ from: f.path, to: resolvedTarget, kind: "link" });
      } else if (!byPath.has(resolvedTarget) && isPathShaped(resolvedTarget)) {
        edgeSeen.add(key);
        phantoms.set(resolvedTarget, (phantoms.get(resolvedTarget) ?? 0) + 1);
        pendingPhantomEdges.push({ from: f.path, to: resolvedTarget, kind: "link" });
      }
    }
  }

  // Most-referenced phantoms first, capped; edges to dropped phantoms drop.
  const phantomSet = new Set(
    [...phantoms.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PHANTOM_NODES)
      .map(([p]) => p),
  );
  for (const p of phantomSet) {
    nodes.push({ id: p, kind: "phantom", path: p, title: p.split("/").pop() ?? p });
  }
  for (const e of pendingPhantomEdges) {
    if (phantomSet.has(e.to)) edges.push(e);
  }

  return { nodes, edges };
}
