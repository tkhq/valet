/**
 * Owner-tuple OKF memory HTTP surface (decision 12/13/14/15).
 *
 *   GET    /api/memory?path=            → file (rendered doc) or directory (virtual index.md)
 *   PUT    /api/memory                  → write (create/update)
 *   POST   /api/memory/patch            → exact-replace body patch
 *   DELETE /api/memory?path=            → remove
 *   GET    /api/memory/search?q=        → FTS5 search
 *   GET    /api/memory/export           → OKF bundle manifest (include=all only, decision 12)
 *   POST   /api/memory/import           → OKF bundle import
 *
 * Dual auth (decision 15): an `x-valet-internal` header carrying the
 * constant-time-matched internal token trusts the paired
 * `x-valet-owner`/`x-valet-actor` headers verbatim (this is how the
 * `mem_*` engine tools, running inside a session with an arbitrary
 * owner/actor, reach these routes). Absent that header, the route falls
 * back to the normal session user — who this phase only ever operates on
 * their own `user:{id}` scope (team/org-owned writes are internal-token
 * only, since there's no "acting as a team" session concept yet).
 */
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { parsePrincipal } from "@valet/engine";
import { NotFoundError, ValidationError, ValetError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { isValidInternalToken } from "../lib/internal-auth.js";
import { ReservedPathError } from "../lib/okf.js";
import { memoryFiles } from "../schema/index.js";
import type { GetMemoryTreeResponse, MemoryTreeEntry } from "../wire/types.js";
import {
  exportFiles,
  importFiles,
  patchFile,
  readFile,
  removeFile,
  searchFiles,
  writeFile,
  type MemoryScope,
} from "../services/memory.js";

export const memoryRouter = new Hono<AppEnv>();

function resolveScope(c: Context<AppEnv>): MemoryScope {
  const internalHeader = c.req.header("x-valet-internal");
  if (isValidInternalToken(internalHeader)) {
    const ownerHeader = c.req.header("x-valet-owner");
    const actorHeader = c.req.header("x-valet-actor");
    if (!ownerHeader || !actorHeader) {
      throw new ValidationError("internal memory requests require x-valet-owner and x-valet-actor headers");
    }
    const owner = parsePrincipal(ownerHeader);
    if (!owner) {
      throw new ValidationError(`invalid x-valet-owner header: '${ownerHeader}'`);
    }
    return { owner, actorUserId: actorHeader };
  }

  const user = c.var.user;
  return { owner: { type: "user", id: user.id }, actorUserId: user.id };
}

/** Maps service-layer errors to HTTP responses. Rethrows anything else so
 * the app's global error handler produces a 500. */
function handleServiceError(err: unknown): { body: { error: string; code?: string }; status: 400 | 404 } | null {
  if (err instanceof ReservedPathError) {
    return { body: { error: err.message, code: "reserved_path" }, status: 400 };
  }
  if (err instanceof NotFoundError) {
    return { body: { error: err.message, code: "not_found" }, status: 404 };
  }
  if (err instanceof ValidationError) {
    return { body: { error: err.message, code: "validation_error" }, status: 400 };
  }
  if (err instanceof ValetError) {
    if (err.statusCode === 404 || err.statusCode === 400) {
      return { body: { error: err.message, code: err.code }, status: err.statusCode };
    }
  }
  return null;
}

memoryRouter.get("/", async (c) => {
  let scope: MemoryScope;
  try {
    scope = resolveScope(c);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  const path = c.req.query("path") ?? "";
  try {
    const { db } = c.var.providers;
    const result = await readFile(db, scope, path);
    return c.json(result);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

/**
 * GET /api/memory/tree — decision 7. Flat file listing for the web
 * explorer (no directory rows — the client derives the tree from paths).
 * Deliberately own-scope only (unlike `readFile`/`listFiles`, which
 * read-union in team scopes): the design spec calls this out explicitly
 * ("this pass own-scope is fine"), so this queries `memory_files` directly
 * against `scope.owner` instead of going through the service's
 * `listFiles` (which would union team files under a `team:{id}/` virtual
 * prefix). Dual auth reuses `resolveScope`, same as every other route here.
 */
memoryRouter.get("/tree", async (c) => {
  let scope: MemoryScope;
  try {
    scope = resolveScope(c);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  const { db } = c.var.providers;
  const rows = await db
    .select()
    .from(memoryFiles)
    .where(and(eq(memoryFiles.ownerType, scope.owner.type), eq(memoryFiles.ownerId, scope.owner.id)))
    .all();

  const entries: MemoryTreeEntry[] = rows
    .map((r) => ({
      path: r.path,
      title: r.title,
      type: r.type,
      pinned: r.pinned === 1,
      updatedAt: r.updatedAt,
      dir: false,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const body: GetMemoryTreeResponse = { entries };
  return c.json(body);
});

memoryRouter.put("/", async (c) => {
  let scope: MemoryScope;
  try {
    scope = resolveScope(c);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  let body: {
    path?: string;
    content?: string;
    type?: string;
    description?: string;
    tags?: string[];
    resource?: string;
    sensitivity?: "private" | "shareable";
    origin?: string;
    expires?: number | null;
    pinned?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.path || typeof body.path !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  try {
    const { db } = c.var.providers;
    const result = await writeFile(db, scope, {
      path: body.path,
      content: body.content,
      type: body.type,
      description: body.description,
      tags: body.tags,
      resource: body.resource,
      sensitivity: body.sensitivity,
      origin: body.origin,
      expires: body.expires,
      pinned: body.pinned,
    });
    return c.json(result);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

memoryRouter.post("/patch", async (c) => {
  let scope: MemoryScope;
  try {
    scope = resolveScope(c);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  let body: { path?: string; oldString?: string; newString?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.path || body.oldString === undefined || body.newString === undefined) {
    return c.json({ error: "path, oldString, and newString are required" }, 400);
  }

  try {
    const { db } = c.var.providers;
    const result = await patchFile(db, scope, {
      path: body.path,
      oldString: body.oldString,
      newString: body.newString,
    });
    return c.json(result);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

memoryRouter.delete("/", async (c) => {
  let scope: MemoryScope;
  try {
    scope = resolveScope(c);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);

  try {
    const { db } = c.var.providers;
    await removeFile(db, scope, path);
    return c.json({ ok: true });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

memoryRouter.get("/search", async (c) => {
  let scope: MemoryScope;
  try {
    scope = resolveScope(c);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  const q = c.req.query("q") ?? "";
  if (!q) return c.json({ error: "q is required" }, 400);
  const limitParam = c.req.query("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  try {
    const { db } = c.var.providers;
    const results = await searchFiles(db, scope, { query: q, limit });
    return c.json({ results });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

memoryRouter.get("/export", async (c) => {
  let scope: MemoryScope;
  try {
    scope = resolveScope(c);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  const include = c.req.query("include") ?? "all";
  if (include !== "all") {
    // Shareable-export filtering is out of scope this phase (decision 12).
    return c.json({ error: "only include=all is supported this phase", code: "unsupported_include" }, 400);
  }

  const { db } = c.var.providers;
  const manifest = await exportFiles(db, scope);
  return c.json({ files: manifest });
});

memoryRouter.post("/import", async (c) => {
  let scope: MemoryScope;
  try {
    scope = resolveScope(c);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  let body: { files?: Record<string, string | { content: string }>; trusted?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.files || typeof body.files !== "object") {
    return c.json({ error: "files is required" }, 400);
  }

  // Accept either the plain `{ path → content }` shape or the export
  // manifest shape `{ path → { content, hash } }`.
  const files: Record<string, string> = {};
  for (const [path, value] of Object.entries(body.files)) {
    files[path] = typeof value === "string" ? value : value.content;
  }

  try {
    const { db } = c.var.providers;
    const result = await importFiles(db, scope, { files, trusted: body.trusted === true });
    return c.json(result);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});
