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
import { resolveLinkTarget } from "./memory-links.js";

/** Re-exported so graph callers keep one import site. The implementation
 * lives in `memory-links.ts` because the web client needs the same
 * resolution rules to navigate cross-references in place — see that file's
 * header for the sharing rationale. */
export { resolveLinkTarget };

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
 * The one link scanner. Walks the scannable prefix (`MAX_SCAN_CHARS`) of
 * `body` line by line — code fences and inline code skipped, the inline-code
 * mask length-preserving so match indices address the raw line — and calls
 * `mapTarget` for every markdown link target. A non-null return replaces the
 * target text in place; the unscanned remainder is appended untouched.
 *
 * Extraction (`extractLinkTargets`) and rewriting (`rewriteLinkTargets`,
 * `absolutizeLinkTargets`) all drive this walker, so the fence, mask, and
 * scan-budget rules cannot drift between "which links exist" and "which
 * links get rewritten".
 */
function walkLinkTargets(
  body: string,
  mapTarget: (target: string) => string | null,
): { content: string; changed: boolean; targets: string[] } {
  const head = body.length > MAX_SCAN_CHARS ? body.slice(0, MAX_SCAN_CHARS) : body;
  const tail = body.slice(head.length);
  const targets: string[] = [];
  let inFence = false;
  let changed = false;

  const lines = head.split("\n").map((rawLine) => {
    if (rawLine.startsWith("```") || rawLine.startsWith("~~~")) {
      inFence = !inFence;
      return rawLine;
    }
    if (inFence) return rawLine;

    const masked = rawLine.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    let result = "";
    let last = 0;
    LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_RE.exec(masked)) !== null) {
      const target = match[2] ?? "";
      targets.push(target);
      const replacement = mapTarget(target);
      if (replacement === null) continue;
      // `[` + text + `](` precede the target inside the match.
      const targetStart = match.index + 1 + (match[1]?.length ?? 0) + 2;
      result += rawLine.slice(last, targetStart) + replacement;
      last = targetStart + target.length;
      changed = true;
    }
    return result + rawLine.slice(last);
  });

  return { content: lines.join("\n") + tail, changed, targets };
}

/** Markdown `[text](target)` targets in `body`, resolved to bundle paths,
 * deduped, code fences and inline code skipped. */
export function extractLinkTargets(fromPath: string, body: string): string[] {
  const seen = new Set<string>();
  const { targets } = walkLinkTargets(body, () => null);
  for (const target of targets) {
    const toPath = resolveLinkTarget(fromPath, target);
    if (toPath !== null && toPath !== fromPath) seen.add(toPath);
  }
  return [...seen];
}

/** A dangling target only becomes a phantom node when it plausibly names a
 * memory file — inside a directory or with a .md suffix. Exported for
 * `services/memory.ts`'s `linksForFile`, which applies the same rule to
 * outbound phantom edges. */
export function isPathShaped(target: string): boolean {
  return target.includes("/") || target.endsWith(".md");
}

/** `decodeURIComponent` with the same malformed-input fallback
 * `resolveLinkTarget` uses: a target that fails to decode is treated as
 * literal text. */
function tryDecode(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/** Percent-encodes the characters that would break LINK_RE parsing of a
 * spliced-in target — whitespace and parens (stored paths may legally
 * contain both), plus `%` itself so decoding round-trips. Without this, a
 * rewritten link to `notes/c d.md` could never be matched again. */
function encodeLinkTarget(target: string): string {
  return target.replace(/[%\s()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** The `#anchor` suffix of a link target, read from the DECODED form —
 * `resolveLinkTarget` decodes before splitting on `#`, so a
 * percent-encoded `%23` anchor must survive a rewrite too. */
function anchorOf(target: string): string {
  const decoded = tryDecode(target);
  const hashIdx = decoded.indexOf("#");
  return hashIdx > 0 ? decoded.slice(hashIdx) : "";
}

/**
 * Rewrites markdown link targets in `body` that resolve to `oldTarget`
 * so they point at `newTargetPath` instead (written in the bundle-rooted
 * `/path` form, preserving any `#anchor` suffix). Scan rules are shared
 * with `extractLinkTargets` via `walkLinkTargets`; extension drift is
 * tolerated (`a/b` matches `a/b.md`).
 */
export function rewriteLinkTargets(
  fromPath: string,
  body: string,
  oldTarget: string,
  newTargetPath: string,
): { content: string; rewrote: boolean } {
  const { content, changed } = walkLinkTargets(body, (target) => {
    const resolved = resolveLinkTarget(fromPath, target);
    if (resolved === null || (resolved !== oldTarget && `${resolved}.md` !== oldTarget)) return null;
    return encodeLinkTarget(`/${newTargetPath}${anchorOf(target)}`);
  });
  return { content, rewrote: changed };
}

/**
 * Rewrites every RELATIVE link target in `body` to the bundle-rooted
 * `/path` form of what it resolves to from `fromPath`, so the body keeps
 * resolving to the same files after the file moves to another directory.
 * Rooted targets are already location-independent and are left alone;
 * external URLs, anchors, and template garbage are skipped. `moveFile`
 * runs this over the moved file's own content — without it, a
 * cross-directory move silently re-points every relative link.
 */
export function absolutizeLinkTargets(fromPath: string, body: string): { content: string; changed: boolean } {
  return walkLinkTargets(body, (target) => {
    if (tryDecode(target).startsWith("/")) return null;
    const resolved = resolveLinkTarget(fromPath, target);
    if (resolved === null) return null;
    return encodeLinkTarget(`/${resolved}${anchorOf(target)}`);
  });
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
