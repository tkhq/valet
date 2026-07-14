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
    pinned: number;
    updatedAt: number;
  };
}
