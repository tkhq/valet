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
 * Originally right-sized per decision 12 to mem_write / mem_patch /
 * mem_read / mem_search / mem_rm; mem_move and mem_links joined later,
 * built on the derived link graph (`../lib/memory-graph.ts` — still no
 * stored links table), and mem_share after that (2026-08-22 artifacts
 * design — snapshots a file into a share link via
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
import { ARTIFACT_MAX_CONTENT_BYTES, artifactSizeError } from "@valet/shared";

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

/** Shared fetch wrapper for all `mem_*` tools: guarantees a
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

// ─── mem_move ──────────────────────────────────────────────────────────

interface MoveResultBody {
  file: { path: string; version?: number };
  referencersUpdated: string[];
  warnings?: unknown;
}

function asMoveResultBody(body: unknown): MoveResultBody | null {
  if (!isRecord(body) || !isRecord(body.file) || typeof body.file.path !== "string") return null;
  const version = typeof body.file.version === "number" ? body.file.version : undefined;
  const referencersUpdated = Array.isArray(body.referencersUpdated)
    ? body.referencersUpdated.filter((p): p is string => typeof p === "string")
    : [];
  return { file: { path: body.file.path, version }, referencersUpdated, warnings: body.warnings };
}

export const memMoveTool = defineTool({
  name: "mem_move",
  description:
    "Rename or move a memory file. Rewrites markdown links in other memory files that pointed at the old path, and reports which files were updated. Metadata carries over unchanged — a cross-directory move keeps the old `type`, so follow it with a metadata-only mem_write to reclassify when the new location implies a different type.",
  parameters: Type.Object({
    from: Type.String({ description: "Current path of the file to move." }),
    to: Type.String({ description: "New path. Must not already exist — merge into an existing file instead." }),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveMemoryConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const owner = resolveOwner(ctx);
    const url = new URL("/api/memory/move", cfg.apiBaseUrl);
    return memoryRequest(
      url,
      {
        method: "POST",
        headers: memoryHeaders(cfg, owner, ctx.userId, true),
        body: JSON.stringify({ from: args.from, to: args.to }),
      },
      async (res) => {
        const body = asMoveResultBody(await parseJsonBody(res));
        if (!body) return { text: `moved ${args.from} → ${args.to}` };
        const versionNote = body.file.version !== undefined ? ` (v${body.file.version})` : "";
        const refNote =
          body.referencersUpdated.length > 0
            ? `\n${body.referencersUpdated.length} referencing file(s) updated: ${body.referencersUpdated.join(", ")}`
            : "\nno referencing files needed updates";
        return { text: `moved ${args.from} → ${body.file.path}${versionNote}${refNote}${formatWarnings(body.warnings)}` };
      },
    );
  },
});

// ─── mem_links ─────────────────────────────────────────────────────────

interface LinkEdgeRow {
  path: string;
  title: string;
  type: string;
  phantom?: boolean;
}

interface LinksResultBody {
  path: string;
  outbound: LinkEdgeRow[];
  inbound: LinkEdgeRow[];
}

function asLinkEdgeRow(v: unknown): LinkEdgeRow | null {
  if (!isRecord(v) || typeof v.path !== "string") return null;
  return {
    path: v.path,
    title: typeof v.title === "string" ? v.title : "",
    type: typeof v.type === "string" ? v.type : "",
    phantom: v.phantom === true,
  };
}

function asLinksResultBody(body: unknown): LinksResultBody | null {
  if (!isRecord(body) || typeof body.path !== "string") return null;
  const edges = (v: unknown): LinkEdgeRow[] =>
    Array.isArray(v) ? v.map(asLinkEdgeRow).filter((e): e is LinkEdgeRow => e !== null) : [];
  return { path: body.path, outbound: edges(body.outbound), inbound: edges(body.inbound) };
}

function formatEdges(label: string, edges: LinkEdgeRow[]): string {
  if (edges.length === 0) return `${label} (0)`;
  const lines = edges.map((e) => {
    if (e.phantom) return `  - ${e.path} (phantom — no file at this path)`;
    const title = e.title ? ` — ${e.title}` : "";
    const type = e.type ? ` [${e.type}]` : "";
    return `  - ${e.path}${title}${type}`;
  });
  return `${label} (${edges.length}):\n${lines.join("\n")}`;
}

export const memLinksTool = defineTool({
  name: "mem_links",
  description:
    "List one memory file's link edges: inbound (files whose markdown links point at it) and outbound (files its links point at, phantom targets included). Check inbound before mem_move or mem_rm, and use it to orient on a topic's cluster.",
  parameters: Type.Object({
    path: Type.String({ description: "Memory file path to inspect." }),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveMemoryConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const owner = resolveOwner(ctx);
    const url = new URL("/api/memory/links", cfg.apiBaseUrl);
    url.searchParams.set("path", args.path);
    return memoryRequest(url, { method: "GET", headers: memoryHeaders(cfg, owner, ctx.userId, false) }, async (res) => {
      const body = asLinksResultBody(await parseJsonBody(res));
      if (!body) return { text: `links for ${args.path}\ninbound (0)\noutbound (0)` };
      return {
        text: `links for ${body.path}\n${formatEdges("inbound", body.inbound)}\n${formatEdges("outbound", body.outbound)}`,
      };
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
        // surface) — from the response's ACTUAL visibility, not an
        // assumption: refreshing a document a human already widened keeps
        // it public, and telling the user "login required" for an
        // anonymous link is exactly the misreport this line must prevent.
        const audience =
          body.visibility === "public"
            ? "Anyone with the link — no login required (a human widened this link earlier)."
            : "Logged-in members of the user's org. The user can widen or revoke this link from the memory page.";
        return { text: `shared ${args.path} → ${body.url}\nAudience: ${audience}` };
      },
    );
  },
});

// ─── artifact_publish ──────────────────────────────────────────────────

interface PublishResultBody extends ShareResultBody {
  version?: number;
}

function asPublishResultBody(body: unknown): PublishResultBody | null {
  const base = asShareResultBody(body);
  if (!base || !isRecord(body)) return base;
  return { ...base, version: typeof body.version === "number" ? body.version : undefined };
}

/** A sandbox path as a publish key: strip leading slashes, keep the rest. */
function normalizePublishKey(path: string): string {
  return path.replace(/^\/+/, "");
}

export const artifactPublishTool = defineTool({
  name: "artifact_publish",
  description:
    "Publish content as a page at a stable link, or revoke it. Pass `content` inline, or `path` to publish a file already written in the sandbox. Use markdown for prose a person will read; use html when the output is easier to look at than to read — a chart, a diagram, an annotated diff, options side by side, an interactive control. An html page must be self-contained: inline every stylesheet and script, embed images as data URIs, draw diagrams as inline SVG. Scripts run sandboxed with no network access; only two script CDNs load (cdn.jsdelivr.net, cdnjs.cloudflare.com) and no other external host does. Re-publishing the same key updates the page and keeps the URL. Links require a logged-in member of the user's org; only a human can widen one further from the web UI. Publish only when the user asks for a link or clearly wants a page — never proactively.",
  parameters: Type.Object({
    key: Type.Optional(
      Type.String({
        description:
          "Stable publish key, e.g. 'pages/deploy-dashboard'. Re-publishing the same key updates the same page at the same URL. Defaults to `path` when publishing from a file.",
      }),
    ),
    content: Type.Optional(
      Type.String({
        description:
          "The source: GFM markdown, or a self-contained HTML document. Pass exactly one of `path` or `content`. Capped at 2 MiB.",
      }),
    ),
    path: Type.Optional(
      Type.String({
        description:
          "Path of a file in the sandbox to publish, e.g. '/workspace/report.html'. Pass exactly one of `path` or `content`. Format defaults from the extension: .html/.htm is html, anything else is markdown.",
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: "Page title. Defaults to the html <title>, the first markdown heading, or the key's basename.",
      }),
    ),
    format: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("html")], {
        description: "How to render `content`. Default markdown.",
      }),
    ),
    description: Type.Optional(Type.String({ description: "One sentence saying what the page shows." })),
    icon: Type.Optional(Type.String({ description: "One or two emoji for the browser tab, e.g. '📊'. Keep it stable across republishes." })),
    revoke: Type.Optional(Type.Boolean({ description: "Revoke the page at `key` instead of publishing." })),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveMemoryConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };

    const hasContent = typeof args.content === "string" && args.content.length > 0;
    const hasPath = typeof args.path === "string" && args.path.length > 0;

    let key = args.key;
    let content = args.content;
    let format = args.format;

    if (args.revoke === true) {
      if (!key && hasPath) key = normalizePublishKey(args.path!);
      if (!key) return { text: "[artifact_error] pass `key` (or `path`) to name the page to revoke." };
    } else {
      if (hasContent === hasPath) {
        return { text: "[artifact_error] pass exactly one of `content` (inline source) or `path` (a file in the sandbox)." };
      }
      if (hasPath) {
        const stat = await ctx.sandbox.stat(args.path!).catch(() => null);
        if (!stat?.isFile) {
          return { text: `[artifact_error] ${args.path} is not a file in the sandbox. Write the page to a file first, then publish it.` };
        }
        if (stat.size > ARTIFACT_MAX_CONTENT_BYTES) {
          const mib = (stat.size / (1024 * 1024)).toFixed(1);
          return {
            text: `[artifact_error] ${args.path} is ${mib} MiB, over the ${ARTIFACT_MAX_CONTENT_BYTES / (1024 * 1024)} MiB limit. Embed fewer raster images, or draw diagrams as inline SVG instead.`,
          };
        }
        content = await ctx.sandbox.readFile(args.path!);
        const sizeError = artifactSizeError(content);
        if (sizeError) return { text: `[artifact_error] ${sizeError}` };
        if (!format) format = /\.html?$/i.test(args.path!) ? "html" : "markdown";
        if (!key) key = normalizePublishKey(args.path!);
      }
      if (!key) {
        return { text: "[artifact_error] `key` is required when publishing inline content. Pick a stable name like 'pages/deploy-dashboard'." };
      }
    }

    const owner = resolveOwner(ctx);
    const url = new URL("/api/artifacts/share", cfg.apiBaseUrl);
    const headers = memoryHeaders(cfg, owner, ctx.userId, true);
    // Audit column — and the target for reader comments sent to the agent.
    headers["x-valet-session-id"] = ctx.sessionId;
    return memoryRequest(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          key,
          content,
          title: args.title,
          format,
          description: args.description,
          icon: args.icon,
          revoke: args.revoke,
        }),
      },
      async (res) => {
        if (args.revoke === true) return { text: `revoked page ${key}` };
        const body = asPublishResultBody(await parseJsonBody(res));
        if (!body?.url) return { text: `[artifact_error] publish succeeded but returned no URL` };
        // State the audience so the agent relays it accurately — from the
        // response's ACTUAL visibility (a human may have widened an earlier
        // publish of this key).
        const audience =
          body.visibility === "public"
            ? "Anyone with the link — no login required (a human widened this link earlier)."
            : "Logged-in members of the user's org. The user can widen or revoke this link from the page.";
        const version = body.version !== undefined ? ` (version ${body.version})` : "";
        return { text: `published ${key} → ${body.url}${version}\nAudience: ${audience}` };
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

/** The eight `mem_*` ToolDefs plus `artifact_publish` (same transport, same
 * publish chokepoint — see the artifact-pages design), in registration
 * order. */
export function buildMemoryTools(): ToolDef[] {
  return [
    memWriteTool,
    memPatchTool,
    memReadTool,
    memSearchTool,
    memMoveTool,
    memLinksTool,
    memShareTool,
    artifactPublishTool,
    memRmTool,
  ];
}
