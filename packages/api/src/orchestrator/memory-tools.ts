/**
 * `mem_*` engine ToolDefs (Phase 4 decision 15) — the orchestrator's memory
 * surface. These call the memory HTTP routes (`packages/api/src/routes/memory.ts`)
 * over `fetch` against `ctx.config.apiBaseUrl`, authenticating with the
 * internal-token dual-auth header pair (`x-valet-internal` + explicit
 * `x-valet-owner`/`x-valet-actor`) — never the `../services/memory.js`
 * module directly. The HTTP seam is the portability contract: these tools
 * must work identically whether the orchestrator host and the API process
 * are the same process (today) or split across a network boundary later.
 *
 * Right-sized per decision 12: mem_write / mem_patch / mem_read /
 * mem_search / mem_rm (mem_move / mem_links deferred), plus mem_share
 * (2026-08-22 artifacts design — snapshots a file into a share link via
 * `POST /api/artifacts/share`).
 *
 * Metadata-setting guidance (when to set `resource`, `sensitivity`,
 * `origin`, `expires`, `pinned`) lives in the TypeBox param descriptions
 * below, per the OKF spec's "Tool surface" note: schemas survive context
 * pressure; persona prose doesn't.
 */
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { serializePrincipal, type Principal } from "@valet/engine";
import type { ToolContext, ToolDef, ToolResult } from "@valet/engine";

const UNAVAILABLE_TEXT = "[memory_unavailable] memory endpoint not configured";

/** Preserves the schema's static type through the ToolDef so `args` in
 * `execute` is typed precisely instead of `unknown` (same idiom as
 * `packages/engine/src/builtin-tools/index.ts`'s `defineTool` — not
 * exported from `@valet/engine`, so reproduced locally here). */
function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

interface MemoryToolConfig {
  apiBaseUrl: string;
  internalToken: string;
}

/** `ctx.config` is a verbatim `Record<string, unknown>` passthrough
 * (Phase 4 decision 7) — a memory-config shape is only known by
 * convention, hence the typeof narrowing before use. */
function resolveMemoryConfig(ctx: ToolContext): MemoryToolConfig | null {
  const apiBaseUrl = ctx.config?.apiBaseUrl;
  const internalToken = ctx.config?.internalToken;
  if (typeof apiBaseUrl !== "string" || apiBaseUrl.length === 0) return null;
  if (typeof internalToken !== "string" || internalToken.length === 0) return null;
  return { apiBaseUrl, internalToken };
}

function resolveOwner(ctx: ToolContext): Principal {
  return ctx.owner ?? { type: "user", id: ctx.userId };
}

function memoryHeaders(cfg: MemoryToolConfig, owner: Principal, actorUserId: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "x-valet-internal": cfg.internalToken,
    "x-valet-owner": serializePrincipal(owner),
    "x-valet-actor": actorUserId,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function parseJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Non-2xx → `[memory_error] …` text, never a throw — memory failures
 * shouldn't kill an orchestrator turn. */
async function memoryErrorResult(res: Response): Promise<ToolResult> {
  const body = await parseJsonBody(res);
  const message = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  return { text: `[memory_error] ${message}` };
}

/** Shared fetch wrapper for all five `mem_*` tools: guarantees a
 * `[memory_error] …` `ToolResult` instead of a throw for *any* failure
 * mode — non-2xx responses (via `memoryErrorResult`) as well as
 * network-level failures (ECONNREFUSED, DNS errors, timeouts, etc.) that
 * `fetch` itself rejects with. `onOk` only ever sees a `res.ok` response. */
async function memoryRequest(url: URL, init: RequestInit, onOk: (res: Response) => Promise<ToolResult>): Promise<ToolResult> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `[memory_error] ${message}` };
  }
  if (!res.ok) return memoryErrorResult(res);
  return onOk(res);
}

function formatWarnings(warnings: unknown): string {
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  const lines = warnings.filter((w): w is string => typeof w === "string").map((w) => `⚠ ${w}`);
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

interface WriteResultBody {
  file: { path: string; version?: number };
  warnings?: unknown;
}

/** Runtime-narrows a write-response body instead of a bare `as` cast:
 * only the fields actually read (`file.path`, `file.version`) are
 * checked, per the "validated-pick, not a blind cast" convention. */
function asWriteResultBody(body: unknown): WriteResultBody | null {
  if (!isRecord(body) || !isRecord(body.file) || typeof body.file.path !== "string") return null;
  const version = typeof body.file.version === "number" ? body.file.version : undefined;
  return { file: { path: body.file.path, version }, warnings: body.warnings };
}

async function relayWriteResult(res: Response, verb: string): Promise<ToolResult> {
  const rawBody = await parseJsonBody(res);
  const body = asWriteResultBody(rawBody);
  const path = body?.file.path ?? "";
  const version = body?.file.version;
  const versionNote = version !== undefined ? ` (v${version})` : "";
  return { text: `${verb} ${path}${versionNote}${formatWarnings(body?.warnings)}` };
}

// ─── mem_write ─────────────────────────────────────────────────────────

export const memWriteTool = defineTool({
  name: "mem_write",
  description:
    "Create or update a memory file. Create requires `content`; call again with `content` omitted to update metadata only (type/description/tags/etc.) without touching the body. Search with mem_search before writing to update an existing file about the same thing instead of creating a duplicate.",
  parameters: Type.Object({
    path: Type.String({ description: "Memory path, e.g. 'people/alice.md' or 'projects/valet/overview.md'." }),
    content: Type.Optional(
      Type.String({ description: "Full body content (markdown). Required to create a new file; omit for a metadata-only update." }),
    ),
    type: Type.Optional(
      Type.String({ description: "Concept type, e.g. 'preference', 'person', 'project-note', 'journal-entry'. Defaults from the directory when omitted." }),
    ),
    description: Type.Optional(Type.String({ description: "One-line summary used in search results and directory indexes." })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Free-form tags." })),
    resource: Type.Optional(
      Type.String({
        description:
          "Set when this file is about a specific external resource (a URL, repo, doc link) — enables resource-based dedup so a second mem_write about the same resource updates this file instead of creating a duplicate.",
      }),
    ),
    sensitivity: Type.Optional(
      Type.Union([Type.Literal("private"), Type.Literal("shareable")], {
        description:
          "Defaults to 'private'. Set to 'shareable' for content safe to expose outside your own scope (e.g. team-facing knowledge) — most personal facts should stay 'private'.",
      }),
    ),
    origin: Type.Optional(
      Type.String({
        description:
          "Set to 'user-stated' when the user explicitly told you this fact in conversation — it takes precedence over 'inferred' facts on conflicting updates. Leave unset for things you inferred yourself.",
      }),
    ),
    expires: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], {
        description:
          "Ms-epoch timestamp after which this memory is stale and excluded from search/snapshots (e.g. a temporary preference or a fact with a known end date). Pass null to clear an existing expiry. Omit for facts that don't expire.",
      }),
    ),
    pinned: Type.Optional(
      Type.Boolean({
        description:
          "Pin this file so it's always loaded in full at orchestrator wake (memory snapshot). Use sparingly — only for durable, high-value facts (standing preferences, core identity notes), not routine journal entries.",
      }),
    ),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveMemoryConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const owner = resolveOwner(ctx);
    const url = new URL("/api/memory", cfg.apiBaseUrl);
    return memoryRequest(
      url,
      {
        method: "PUT",
        headers: memoryHeaders(cfg, owner, ctx.userId, true),
        body: JSON.stringify({
          path: args.path,
          content: args.content,
          type: args.type,
          description: args.description,
          tags: args.tags,
          resource: args.resource,
          sensitivity: args.sensitivity,
          origin: args.origin,
          expires: args.expires,
          pinned: args.pinned,
        }),
      },
      (res) => relayWriteResult(res, "wrote"),
    );
  },
});

// ─── mem_patch ─────────────────────────────────────────────────────────

export const memPatchTool = defineTool({
  name: "mem_patch",
  description:
    "Exact-string replace a memory file's body: finds `oldString` and replaces it with `newString`. Fails if `oldString` doesn't match exactly once. Pass `oldString: ''` against a non-existent path to create it with `newString` as the body (useful for appending to today's journal).",
  parameters: Type.Object({
    path: Type.String(),
    oldString: Type.String({ description: "Exact text to find, or '' to create a new file at `path`." }),
    newString: Type.String({ description: "Replacement text (or full body, when creating)." }),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveMemoryConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const owner = resolveOwner(ctx);
    const url = new URL("/api/memory/patch", cfg.apiBaseUrl);
    return memoryRequest(
      url,
      {
        method: "POST",
        headers: memoryHeaders(cfg, owner, ctx.userId, true),
        body: JSON.stringify({ path: args.path, oldString: args.oldString, newString: args.newString }),
      },
      (res) => relayWriteResult(res, "patched"),
    );
  },
});

// ─── mem_read ──────────────────────────────────────────────────────────

interface ReadResultBody {
  kind?: string;
  rendered?: string;
}

function asReadResultBody(body: unknown): ReadResultBody | null {
  if (!isRecord(body)) return null;
  const kind = typeof body.kind === "string" ? body.kind : undefined;
  const rendered = typeof body.rendered === "string" ? body.rendered : undefined;
  return { kind, rendered };
}

export const memReadTool = defineTool({
  name: "mem_read",
  description:
    "Read a memory file (returns its rendered document) or a directory (returns a virtual index of its files and subdirectories). Pass a path ending in '/' or '' for the root to read a directory.",
  parameters: Type.Object({
    path: Type.String({ description: "File path, or a directory path (trailing '/', or '' for the root)." }),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveMemoryConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const owner = resolveOwner(ctx);
    const url = new URL("/api/memory", cfg.apiBaseUrl);
    url.searchParams.set("path", args.path);
    return memoryRequest(url, { method: "GET", headers: memoryHeaders(cfg, owner, ctx.userId, false) }, async (res) => {
      const body = asReadResultBody(await parseJsonBody(res));
      return { text: body?.rendered ?? "" };
    });
  },
});

// ─── mem_search ────────────────────────────────────────────────────────

interface SearchResultRow {
  path: string;
  title: string;
  description: string;
  type: string;
}

interface SearchResultBody {
  results?: SearchResultRow[];
}

function asSearchResultRow(v: unknown): SearchResultRow | null {
  if (!isRecord(v)) return null;
  if (typeof v.path !== "string") return null;
  return {
    path: v.path,
    title: typeof v.title === "string" ? v.title : "",
    description: typeof v.description === "string" ? v.description : "",
    type: typeof v.type === "string" ? v.type : "",
  };
}

function asSearchResultBody(body: unknown): SearchResultBody | null {
  if (!isRecord(body)) return null;
  if (!Array.isArray(body.results)) return { results: undefined };
  const results = body.results.map(asSearchResultRow).filter((r): r is SearchResultRow => r !== null);
  return { results };
}

export const memSearchTool = defineTool({
  name: "mem_search",
  description:
    "Full-text search over memory (path, title, description, tags, content) within your own scope and any teams you belong to. Search before mem_write when the memory might already exist, especially for anything with a `resource`.",
  parameters: Type.Object({
    query: Type.String({ description: "FTS5 query string." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveMemoryConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const owner = resolveOwner(ctx);
    const url = new URL("/api/memory/search", cfg.apiBaseUrl);
    url.searchParams.set("q", args.query);
    if (args.limit !== undefined) url.searchParams.set("limit", String(args.limit));
    return memoryRequest(url, { method: "GET", headers: memoryHeaders(cfg, owner, ctx.userId, false) }, async (res) => {
      const body = asSearchResultBody(await parseJsonBody(res));
      const results = body?.results ?? [];
      if (results.length === 0) return { text: `(no memory results for "${args.query}")` };
      const lines = results.map((r) => {
        const desc = r.description ? ` — ${r.description}` : "";
        return `[${r.type}] ${r.path}${desc}`;
      });
      return { text: lines.join("\n") };
    });
  },
});

// ─── mem_share ─────────────────────────────────────────────────────────

interface ShareResultBody {
  url?: string;
  visibility?: string;
}

function asShareResultBody(body: unknown): ShareResultBody | null {
  if (!isRecord(body)) return null;
  return {
    url: typeof body.url === "string" ? body.url : undefined,
    visibility: typeof body.visibility === "string" ? body.visibility : undefined,
  };
}

export const memShareTool = defineTool({
  name: "mem_share",
  description:
    "Share a memory file as a link, or revoke an existing share. The link serves a snapshot of the file at share time — call mem_share again after editing the file to publish the update (the URL stays the same). Links require a logged-in member of the user's org; only a human can widen one further from the web UI. Share only when the user asks for a link or clearly wants to hand the document to someone — never proactively.",
  parameters: Type.Object({
    path: Type.String({
      description:
        "Memory path of the file to share, e.g. 'artifacts/report.md'. Documents written for sharing belong under 'artifacts/'.",
    }),
    revoke: Type.Optional(Type.Boolean({ description: "Revoke the share for `path` instead of creating/refreshing it." })),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveMemoryConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const owner = resolveOwner(ctx);
    const url = new URL("/api/artifacts/share", cfg.apiBaseUrl);
    const headers = memoryHeaders(cfg, owner, ctx.userId, true);
    // Audit column: which session ran the share.
    headers["x-valet-session-id"] = ctx.sessionId;
    return memoryRequest(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ path: args.path, revoke: args.revoke }),
      },
      async (res) => {
        if (args.revoke === true) return { text: `revoked share for ${args.path}` };
        const body = asShareResultBody(await parseJsonBody(res));
        if (!body?.url) return { text: `[memory_error] share succeeded but returned no URL` };
        // State the audience so the agent relays it accurately (spec, Tool
        // surface): the reader must know a login is required.
        return {
          text:
            `shared ${args.path} → ${body.url}\n` +
            `Audience: logged-in members of the user's org. The user can widen or revoke this link from the memory page.`,
        };
      },
    );
  },
});

// ─── mem_rm ────────────────────────────────────────────────────────────

export const memRmTool = defineTool({
  name: "mem_rm",
  description: "Delete a memory file. This is permanent — prefer mem_write to update a file instead of deleting and recreating it.",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (args, ctx) => {
    const cfg = resolveMemoryConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const owner = resolveOwner(ctx);
    const url = new URL("/api/memory", cfg.apiBaseUrl);
    url.searchParams.set("path", args.path);
    return memoryRequest(url, { method: "DELETE", headers: memoryHeaders(cfg, owner, ctx.userId, false) }, async () => ({
      text: `removed ${args.path}`,
    }));
  },
});

/** All `mem_*` ToolDefs, in the order they should be registered. */
export function buildMemoryTools(): ToolDef[] {
  return [memWriteTool, memPatchTool, memReadTool, memSearchTool, memShareTool, memRmTool];
}
