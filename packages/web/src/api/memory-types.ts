/**
 * `GET /api/memory?path=…` isn't part of `@valet/api/wire` — the route
 * returns the memory service's `ReadFileResult | ReadDirectoryResult`
 * directly (see `packages/api/src/services/memory.ts` and
 * `packages/api/src/routes/memory.ts`), which lives outside the wire
 * package boundary web is allowed to import (`@valet/api/wire` only —
 * pulling in `@valet/api`'s server entry would drag server-only deps into
 * the web bundle).
 *
 * This is a minimal local projection of that response shape, typed to what
 * the web client actually reads (CLAUDE.md persistence-shape discipline:
 * treat cross-boundary payloads as their own contract, narrow to what's
 * used rather than casting). `file` is only present for `kind: "file"`.
 */
export interface GetMemoryDocResponse {
  kind: "file" | "directory";
  path: string;
  rendered: string;
  file?: {
    path: string;
    title: string;
    content: string;
    type: string;
    /** Boolean on the wire — `memory_files.pinned` is a Postgres boolean and
     * the service passes `row.pinned` straight through. This projection said
     * `number`, so the reader's `=== 1` test never matched and a pinned file
     * showed its pin in the tree and none on the page. */
    pinned: boolean;
    updatedAt: number;
  };
}

/**
 * `GET /api/memory/search?q=` isn't part of `@valet/api/wire` either — same
 * boundary reasoning as `GetMemoryDocResponse` above. Mirrors the service's
 * `SearchResult` (`packages/api/src/services/memory.ts`), narrowed to what
 * the explorer's result list actually reads.
 */
export interface SearchMemoryResult {
  path: string;
  title: string;
  description: string;
  type: string;
  rank: number;
}

export interface SearchMemoryResponse {
  results: SearchMemoryResult[];
}

/**
 * `GET /api/memory/graph` — same boundary reasoning as above. Mirrors
 * `MemoryGraph` in `packages/api/src/lib/memory-graph.ts`.
 */
export interface MemoryGraphNode {
  id: string;
  kind: "concept" | "dir" | "phantom";
  path?: string;
  title?: string;
  type?: string;
  topDir?: string;
}

export interface MemoryGraphEdge {
  from: string;
  to: string;
  kind: "link" | "containment";
}

export interface MemoryGraphResponse {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

/**
 * `GET /api/memory/export` / `POST /api/memory/import` — same boundary
 * reasoning as above. Export returns the OKF manifest; import accepts
 * either `{ path → content }` (the V1 bundle shape) or the manifest shape
 * and reports what it did per file (`ImportResult` in
 * `packages/api/src/services/memory.ts`).
 */
export interface ExportMemoryResponse {
  files: Record<string, { content: string; hash: string }>;
}

export interface ImportMemoryRequest {
  files: Record<string, string | { content: string }>;
  trusted: boolean;
}

export interface ImportMemoryResponse {
  imported: string[];
  skipped: { path: string; reason: string }[];
  remapped: { from: string; to: string }[];
  warnings: string[];
}
