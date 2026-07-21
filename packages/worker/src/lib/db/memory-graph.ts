/**
 * Graph query surface for orchestrator memory: `buildMemoryGraph` (whole-bundle
 * graph for the memory explorer / `GET /api/me/memory/graph`) and `queryLinks`
 * (bounded neighbor traversal backing the `mem_links` tool).
 *
 * Both load the user's files + links tables ONCE (~2 queries total) and derive
 * everything else in JS — per-neighbor queries at depth 3 would be an N+1
 * amplifier (design spec, "Graph surface"). Both call `ensureLinksIndexed`
 * first: they are two of the lazy-backfill trigger surfaces the spec requires
 * (a consumer that reads an empty, never-backfilled link table fails silently).
 *
 * Derived classes (never stored, always computed):
 *   - Session siblings: files sharing a non-empty `source_session_id` render as
 *     a star through a derived `kind: 'session'` hub node (O(k) edges) — never
 *     a pairwise clique. Empty ids produce nothing.
 *   - Phantom nodes: link rows whose `to_path` has no file become `kind: 'phantom'`.
 *   - Resource nodes: concepts sharing a normalized `resource` cluster around a
 *     derived `kind: 'resource'` node.
 *   - Tag nodes + directory containment edges: opt-in only (`opts.tags` /
 *     `opts.containment`). The `GraphEdge.kind` union has no dedicated "tag"
 *     edge kind, so tag-membership and directory-containment edges both use
 *     `kind: 'containment'` (the generic structural-edge kind) — an explicit,
 *     documented rendering choice per the design's "impl-plan decision" note.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { ensureLinksIndexed } from './memory-link-backfill.js';
import type { MemoryScope } from './memory-derived-stores.js';
import { normalizePath } from './memory-path.js';

/** Hard node cap for `buildMemoryGraph` — the memory explorer's whole-bundle view. */
export const MAX_GRAPH_NODES = 500;
/** Hard neighbor cap for `queryLinks` (`mem_links` tool + graph API neighbor calls). */
export const MAX_LINK_NODES = 100;

const JOURNAL_TYPE = 'journal-entry';

export interface GraphNode {
  id: string;
  kind: 'concept' | 'resource' | 'phantom' | 'session' | 'tag';
  path?: string;
  title?: string;
  type?: string;
  topDir?: string;
  label?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'link' | 'session' | 'resource' | 'containment';
  context?: string;
}

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface FileRow {
  path: string;
  title: string;
  type: string;
  description: string;
  resource: string;
  tags: string;
  source_session_id: string;
}

interface LinkRow {
  from_path: string;
  to_path: string;
  context: string;
}

/**
 * The two-query load both surfaces share. Expired files are excluded from the
 * returned file set AND every link row touching an expired path is dropped:
 * an expired file must not render as a node, must not be traversed — and must
 * not degrade into a `phantom` (a phantom is a TODO-stub for a file that was
 * never created; an expired file's link rows linger until the sweep deletes
 * them). Distinguishing the two requires knowing the expired path set, which
 * is why the file query fetches all rows and filters in JS.
 */
async function loadFilesAndLinks(
  rawDb: D1Database,
  scope: MemoryScope,
): Promise<{ files: FileRow[]; links: LinkRow[] }> {
  await ensureLinksIndexed(rawDb, scope);

  const fileRows = await rawDb
    .prepare(
      `SELECT path, title, type, description, resource, tags, source_session_id,
              (expires IS NOT NULL AND expires <= datetime('now')) AS expired
       FROM orchestrator_memory_files
       WHERE user_id = ?`,
    )
    .bind(scope.userId)
    .all<FileRow & { expired: number }>();

  const linkRows = await rawDb
    .prepare('SELECT from_path, to_path, context FROM memory_links WHERE user_id = ?')
    .bind(scope.userId)
    .all<LinkRow>();

  const allFiles = fileRows.results ?? [];
  const expiredPaths = new Set(allFiles.filter((f) => f.expired === 1).map((f) => f.path));
  const files = allFiles.filter((f) => f.expired !== 1);
  const links = (linkRows.results ?? []).filter(
    (l) => !expiredPaths.has(l.from_path) && !expiredPaths.has(l.to_path),
  );

  return { files, links };
}

function safeTagList(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Build the whole-bundle memory graph: concept nodes + link edges from the
 * stored tables, plus derived session/resource/phantom nodes and (opt-in)
 * tag/containment classes. Truncates to `MAX_GRAPH_NODES` nodes, dropping any
 * edge whose endpoint fell out of the truncated set.
 */
export async function buildMemoryGraph(
  rawDb: D1Database,
  scope: MemoryScope,
  opts: { tags?: boolean; containment?: boolean },
): Promise<MemoryGraph> {
  const { files, links } = await loadFilesAndLinks(rawDb, scope);
  const fileByPath = new Map(files.map((f) => [f.path, f]));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const addNode = (node: GraphNode): void => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  // ── Concept nodes ──────────────────────────────────────────────────────────
  for (const f of files) {
    const topDir = f.path.includes('/') ? f.path.split('/')[0] : '';
    addNode({ id: f.path, kind: 'concept', path: f.path, title: f.title, type: f.type, topDir });
  }

  // ── Link edges + phantom nodes ─────────────────────────────────────────────
  for (const l of links) {
    if (!fileByPath.has(l.to_path)) {
      addNode({ id: l.to_path, kind: 'phantom', path: l.to_path });
    }
    edges.push({ from: l.from_path, to: l.to_path, kind: 'link', context: l.context || undefined });
  }

  // ── Session hub stars (empty ids produce nothing; singleton groups have no
  //    siblings to star, so they're skipped too) ─────────────────────────────
  const sessionGroups = new Map<string, string[]>();
  for (const f of files) {
    if (!f.source_session_id) continue;
    const group = sessionGroups.get(f.source_session_id) ?? [];
    group.push(f.path);
    sessionGroups.set(f.source_session_id, group);
  }
  for (const [sid, paths] of sessionGroups) {
    if (paths.length < 2) continue;
    const hubId = `session:${sid}`;
    addNode({ id: hubId, kind: 'session', label: sid });
    for (const p of paths) {
      edges.push({ from: hubId, to: p, kind: 'session' });
    }
  }

  // ── Resource clusters (only when >=1 file has a resource) ──────────────────
  const resourceGroups = new Map<string, string[]>();
  for (const f of files) {
    if (!f.resource) continue;
    const group = resourceGroups.get(f.resource) ?? [];
    group.push(f.path);
    resourceGroups.set(f.resource, group);
  }
  for (const [resource, paths] of resourceGroups) {
    const resId = `resource:${resource}`;
    addNode({ id: resId, kind: 'resource', label: resource });
    for (const p of paths) {
      edges.push({ from: p, to: resId, kind: 'resource' });
    }
  }

  // ── Opt-in: tag nodes ────────────────────────────────────────────────────
  if (opts.tags) {
    for (const f of files) {
      for (const tag of safeTagList(f.tags)) {
        const tagId = `tag:${tag}`;
        addNode({ id: tagId, kind: 'tag', label: tag });
        edges.push({ from: f.path, to: tagId, kind: 'containment' });
      }
    }
  }

  // ── Opt-in: directory containment edges (parent dir -> file, parent dir ->
  //    child dir). Directories reuse `kind: 'tag'` (the only generic structural
  //    node kind in the sealed union) with a `dir:` id prefix to distinguish
  //    them from literal tag nodes. ─────────────────────────────────────────
  if (opts.containment) {
    for (const f of files) {
      const segments = f.path.split('/');
      let parent = '';
      for (let i = 0; i < segments.length - 1; i++) {
        const dir = segments.slice(0, i + 1).join('/');
        const dirId = `dir:${dir}`;
        addNode({ id: dirId, kind: 'tag', label: dir });
        if (parent) {
          edges.push({ from: `dir:${parent}`, to: dirId, kind: 'containment' });
        }
        parent = dir;
      }
      const containingDirId = parent ? `dir:${parent}` : null;
      if (containingDirId) {
        edges.push({ from: containingDirId, to: f.path, kind: 'containment' });
      }
    }
  }

  // ── Cap ──────────────────────────────────────────────────────────────────
  if (nodes.length > MAX_GRAPH_NODES) {
    const truncatedNodes = nodes.slice(0, MAX_GRAPH_NODES);
    const keep = new Set(truncatedNodes.map((n) => n.id));
    const truncatedEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    return { nodes: truncatedNodes, edges: truncatedEdges };
  }

  return { nodes, edges };
}

// ─── queryLinks ───────────────────────────────────────────────────────────────

export interface LinkNeighbor {
  path: string;
  title: string;
  type: string;
  description: string;
  context?: string;
  phantom: boolean;
  relation: 'out' | 'in' | 'session';
}

/**
 * Bounded neighbor traversal from `path`, ring by ring (`neighbors[d]` = depth
 * `d + 1`). Session siblings appear as `relation: 'session'` entries at depth 1
 * (leaves — not themselves expanded). Journal-entry-type nodes stop traversal
 * beyond depth 1 unless `includeJournal`. `context` (the link's surrounding
 * text) is only populated for depth-1 entries — it describes the direct edge
 * from the queried path, not a multi-hop path. Truncates at `MAX_LINK_NODES`
 * total neighbors across all rings.
 */
export async function queryLinks(
  rawDb: D1Database,
  scope: MemoryScope,
  path: string,
  direction: 'out' | 'in' | 'both',
  depth: 1 | 2 | 3,
  includeJournal: boolean,
): Promise<{ neighbors: LinkNeighbor[][]; truncated: boolean }> {
  const root = normalizePath(path);
  const { files, links } = await loadFilesAndLinks(rawDb, scope);
  const fileByPath = new Map(files.map((f) => [f.path, f]));

  const outAdj = new Map<string, LinkRow[]>();
  const inAdj = new Map<string, LinkRow[]>();
  for (const l of links) {
    if (!outAdj.has(l.from_path)) outAdj.set(l.from_path, []);
    outAdj.get(l.from_path)!.push(l);
    if (!inAdj.has(l.to_path)) inAdj.set(l.to_path, []);
    inAdj.get(l.to_path)!.push(l);
  }

  // Session siblings of the root file (leaves; not expanded further).
  const rootFile = fileByPath.get(root);
  const siblingPaths = new Set<string>();
  if (rootFile?.source_session_id) {
    for (const f of files) {
      if (f.path !== root && f.source_session_id === rootFile.source_session_id) {
        siblingPaths.add(f.path);
      }
    }
  }

  const toNeighbor = (targetPath: string, relation: 'out' | 'in' | 'session', context: string | undefined): LinkNeighbor => {
    const f = fileByPath.get(targetPath);
    return {
      path: targetPath,
      title: f?.title ?? '',
      type: f?.type ?? '',
      description: f?.description ?? '',
      context,
      phantom: !f,
      relation,
    };
  };

  const visited = new Set<string>([root]);
  const neighbors: LinkNeighbor[][] = [];
  let truncated = false;
  let totalCount = 0;

  // Frontier for ring expansion: paths reached at the current depth that are
  // eligible to be expanded into the next ring (session siblings are leaves —
  // excluded from the frontier).
  let frontier: string[] = [root];

  for (let d = 0; d < depth; d++) {
    if (truncated) {
      neighbors.push([]);
      continue;
    }

    const ringMap = new Map<string, LinkNeighbor>();

    for (const current of frontier) {
      // Journal-entry nodes don't propagate traversal beyond depth 1 unless
      // includeJournal — but the root itself is always expanded from.
      const currentFile = fileByPath.get(current);
      if (d > 0 && currentFile?.type === JOURNAL_TYPE && !includeJournal) continue;

      if (direction === 'out' || direction === 'both') {
        for (const l of outAdj.get(current) ?? []) {
          if (visited.has(l.to_path) || ringMap.has(l.to_path)) continue;
          ringMap.set(l.to_path, toNeighbor(l.to_path, 'out', d === 0 ? l.context || undefined : undefined));
        }
      }
      if (direction === 'in' || direction === 'both') {
        for (const l of inAdj.get(current) ?? []) {
          if (visited.has(l.from_path) || ringMap.has(l.from_path)) continue;
          ringMap.set(l.from_path, toNeighbor(l.from_path, 'in', d === 0 ? l.context || undefined : undefined));
        }
      }
    }

    if (d === 0) {
      for (const sib of siblingPaths) {
        if (ringMap.has(sib)) continue;
        ringMap.set(sib, toNeighbor(sib, 'session', undefined));
      }
    }

    let ring = [...ringMap.values()];

    // Cap total neighbors across all rings at MAX_LINK_NODES.
    if (totalCount + ring.length > MAX_LINK_NODES) {
      ring = ring.slice(0, MAX_LINK_NODES - totalCount);
      truncated = true;
    }
    totalCount += ring.length;

    for (const n of ring) visited.add(n.path);
    neighbors.push(ring);

    // Next frontier: everything reached this ring except session siblings
    // (leaves — never expanded).
    frontier = ring.filter((n) => n.relation !== 'session').map((n) => n.path);
  }

  return { neighbors, truncated };
}
