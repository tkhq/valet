/**
 * `design_*` engine ToolDefs (Valet Design spec, §Tools) — the design
 * session's authoring surface. Attached ONLY to `kind='design'` sessions
 * by `EngineHost.buildSession`.
 *
 * These call the design HTTP routes (`packages/api/src/routes/design.ts`)
 * over `fetch` against `ctx.config.apiBaseUrl`, authenticating with the
 * internal token + `x-valet-actor` — never the service module directly.
 * Same portability contract as the `mem_*` tools
 * (`../orchestrator/memory-tools.ts`): the tools must work identically if
 * the host and API split across a network boundary.
 *
 * Patch application happens tool-side: `design_edit(kind='patch')` reads
 * the current artifact, applies vdid-targeted replacements locally
 * (`applyElementPatches`), and writes the full document back fenced on
 * the revision it read (`parentRevision`) — a concurrent edit rejects
 * rather than silently overwrites.
 */
import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ChildSpawner, SpawnChildRequest, ToolContext, ToolDef, ToolResult } from "@valet/engine";
import {
  applyElementPatches,
  dcHtmlToMarp,
  dcHtmlToSlidesChunks,
  injectDeckRuntime,
  marpToDcHtml,
  parseHeader,
  slidesToDcHtml,
  DESIGN_CRAFT_GUIDE,
  MAX_ARTIFACT_BYTES,
  type MinimalPresentation,
} from "@valet/plugin-design/lib";
import { batchUpdateChunked, createPresentation, getPresentation } from "@valet/plugin-google-workspace/slides";

const UNAVAILABLE_TEXT = "[design_unavailable] design endpoint not configured";

function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

interface DesignToolConfig {
  apiBaseUrl: string;
  internalToken: string;
}

/** `ctx.config` is a verbatim `Record<string, unknown>` passthrough — the
 * shape is known only by convention, hence the typeof narrowing. */
function resolveDesignConfig(ctx: ToolContext): DesignToolConfig | null {
  const apiBaseUrl = ctx.config?.apiBaseUrl;
  const internalToken = ctx.config?.internalToken;
  if (typeof apiBaseUrl !== "string" || apiBaseUrl.length === 0) return null;
  if (typeof internalToken !== "string" || internalToken.length === 0) return null;
  return { apiBaseUrl, internalToken };
}

function designHeaders(cfg: DesignToolConfig, ctx: ToolContext, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "x-valet-internal": cfg.internalToken,
    "x-valet-actor": ctx.userId,
  };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

function designUrl(cfg: DesignToolConfig, ctx: ToolContext, path: string): URL {
  return new URL(`/api/sessions/${encodeURIComponent(ctx.sessionId)}/design/${path}`, cfg.apiBaseUrl);
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

interface ArtifactRead {
  revision: string;
  content: string;
  scratchpad: string;
}

async function readArtifact(cfg: DesignToolConfig, ctx: ToolContext): Promise<ArtifactRead | { error: string }> {
  const res = await fetch(designUrl(cfg, ctx, "artifact"), {
    headers: designHeaders(cfg, ctx, false),
    signal: ctx.signal,
  });
  if (!res.ok) return { error: await readError(res) };
  const body = (await res.json()) as { revision: string; content: string; scratchpad?: string };
  return { revision: body.revision, content: body.content, scratchpad: body.scratchpad ?? "" };
}

// ─── design_edit ───────────────────────────────────────────────────────

export const designEditTool = defineTool({
  name: "design_edit",
  description:
    "Edit this session's design artifact. kind='rewrite' replaces the whole document with `content` (a complete .dc.html). kind='patch' replaces targeted elements: `content` is the outer HTML of the replacement element(s), each carrying the data-vdid of the element it replaces. Every edit writes a new revision the user can revert.",
  parameters: Type.Object({
    kind: Type.Union([Type.Literal("patch"), Type.Literal("rewrite")], {
      description: "patch = replace elements by data-vdid; rewrite = replace the full document.",
    }),
    content: Type.String({
      description:
        "For rewrite: the complete .dc.html document. For patch: the replacement element(s)' outer HTML, each with the target's data-vdid.",
    }),
    summary: Type.Optional(
      Type.String({ description: "One line describing the change. Shown in the revision history." }),
    ),
  }),
  execute: async (args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };

    let content = args.content;
    let parentRevision: string | undefined;
    let patchNote = "";
    if (args.kind === "patch") {
      const current = await readArtifact(cfg, ctx);
      if ("error" in current) return { text: `[design_edit failed] ${current.error}` };
      try {
        const patched = applyElementPatches(current.content, args.content);
        content = patched.html;
        parentRevision = current.revision;
        patchNote = ` (replaced ${patched.replaced.length} element${patched.replaced.length === 1 ? "" : "s"})`;
      } catch (err) {
        return { text: `[design_edit failed] ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // Rewrite-shrink guard: a rewrite built from a truncated design_read
    // (or a stale memory) can silently drop most of the document. The
    // write proceeds — revert exists — but the shrink is named.
    let shrinkNote = "";
    if (args.kind === "rewrite") {
      const before = await readArtifact(cfg, ctx);
      if (!("error" in before) && typeof before.content === "string") {
        // Fence the rewrite on the revision it replaces: a user revert
        // that lands mid-turn rejects this write (with the corrective
        // stale-edit message) instead of being silently clobbered.
        parentRevision = before.revision;
        const prevLen = Buffer.byteLength(before.content);
        const nextLen = Buffer.byteLength(content);
        if (prevLen > 20_000 && nextLen < prevLen * 0.5) {
          shrinkNote = `\nnote: this rewrite is ${Math.round((1 - nextLen / prevLen) * 100)}% smaller than the previous revision — if you rewrote from a truncated design_read, content was lost; check with design_read and revert if unintended`;
        }
      }
    }

    const res = await fetch(designUrl(cfg, ctx, "edit"), {
      method: "POST",
      headers: designHeaders(cfg, ctx, true),
      body: JSON.stringify({
        content,
        summary: args.summary ?? "",
        ...(parentRevision ? { parentRevision } : {}),
        ...(ctx.queueItemId ? { queueItemId: ctx.queueItemId } : {}),
      }),
      signal: ctx.signal,
    });
    if (!res.ok) return { text: `[design_edit failed] ${await readError(res)}` };
    const body = (await res.json()) as { revision: string; sizeBytes: number; notes?: string[] };
    const noteText = body.notes?.length ? `\n${body.notes.map((n) => `note: ${n}`).join("\n")}` : "";
    return { text: `wrote revision ${body.revision} (${body.sizeBytes} bytes)${patchNote}${noteText}${shrinkNote}` };
  },
});

// ─── design_read ───────────────────────────────────────────────────────

/** Embedded base64 payloads are useless to the model and can be ~2 MB;
 * replace them with short markers before the document enters context. */
function elideDataUrls(html: string): string {
  return html.replace(/src="data:[^"]*"/g, 'src="[embedded image]"');
}

const READ_CONTENT_CAP = 100_000;

export const designReadTool = defineTool({
  name: "design_read",
  description:
    "Read the current design artifact: revision, unresolved comments, and the full document. Use it before editing when the user may have changed or reverted the design (they can do both from the canvas), and to find an element's data-vdid for a patch.",
  parameters: Type.Object({}),
  execute: async (_args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const current = await readArtifact(cfg, ctx);
    if ("error" in current) return { text: `[design_read failed] ${current.error}` };

    let commentLines = "no unresolved comments";
    const commentsRes = await fetch(designUrl(cfg, ctx, "comments"), {
      headers: designHeaders(cfg, ctx, false),
      signal: ctx.signal,
    });
    if (commentsRes.ok) {
      const { comments } = (await commentsRes.json()) as {
        comments: Array<{ id: string; vdid: string; body: string; resolvedAt: number | null }>;
      };
      const open = comments.filter((cm) => cm.resolvedAt === null);
      if (open.length > 0) {
        commentLines = `unresolved comments:\n${open
          .map((cm) => `- ${cm.id} on [data-vdid=${cm.vdid}]: ${cm.body}`)
          .join("\n")}`;
      }
    }

    // The canvas render-health report — what ACTUALLY renders for the
    // user, measured by the live canvas. This is the only signal that can
    // contradict plausible-looking markup (hidden sections, stripped
    // scripts); when it names hidden slides, believe it over the document.
    let canvasReport = "no canvas report yet (no canvas has rendered this artifact)";
    const healthRes = await fetch(designUrl(cfg, ctx, "health"), {
      headers: designHeaders(cfg, ctx, false),
      signal: ctx.signal,
    });
    if (healthRes.ok) {
      const { report } = (await healthRes.json()) as {
        report: {
          revision: string;
          totalSlides: number;
          hiddenSlides: number[];
          overflowingSlides?: number[];
          sparseSlides?: number[];
          scriptsStripped: number;
        } | null;
      };
      if (report) {
        const stale = report.revision !== current.revision ? ` (STALE: measured at ${report.revision})` : "";
        const parts: string[] = [];
        if (report.hiddenSlides.length > 0) {
          parts.push(
            `${report.hiddenSlides.length} of ${report.totalSlides} slides render hidden or blank in the user's canvas (slides ${report.hiddenSlides.map((i) => i + 1).join(", ")}) — usually CSS that hides sections by default, relying on scripts that never run`,
          );
        }
        const overflowing = report.overflowingSlides ?? [];
        if (overflowing.length > 0) {
          parts.push(
            `slide${overflowing.length === 1 ? "" : "s"} ${overflowing.map((i) => i + 1).join(", ")} overflow the slide box — the content is taller than the slide and gets CLIPPED; cut content or reduce sizes until it fits`,
          );
        }
        const sparse = report.sparseSlides ?? [];
        if (sparse.length > 0) {
          parts.push(
            `slide${sparse.length === 1 ? "" : "s"} ${sparse.map((i) => i + 1).join(", ")} leave most of the stage empty (content in the top portion, dead space below) — center the content block vertically or scale it up to fill the 1080px stage`,
          );
        }
        if (report.scriptsStripped > 0) {
          parts.push(`${report.scriptsStripped} script tag(s) were stripped before rendering`);
        }
        canvasReport =
          parts.length > 0
            ? `canvas report${stale}: ${parts.join("; ")}`
            : `canvas report${stale}: all ${report.totalSlides} slides render visibly`;
      }
    }

    let doc = elideDataUrls(current.content);
    let truncationNote = "";
    if (doc.length > READ_CONTENT_CAP) {
      doc = doc.slice(0, READ_CONTENT_CAP);
      truncationNote = "\n[document truncated — use design_edit kind='patch' for targeted changes]";
    }
    const scratchpadBlock = current.scratchpad.trim()
      ? `\n---- scratchpad (your project notes) ----\n${current.scratchpad.trim()}`
      : "";
    return {
      text: `revision ${current.revision}\n${canvasReport}\n${commentLines}${scratchpadBlock}\n---- current artifact ----\n${doc}${truncationNote}`,
    };
  },
});

// ─── design_scratchpad ─────────────────────────────────────────────────

export const designScratchpadTool = defineTool({
  name: "design_scratchpad",
  description:
    "Replace your persistent project notes for this design (shown in every design_read): the outline, decisions made, type-scale choices, placeholders to fix before presenting. Notes survive across turns and reverts — keep them current; they are how future-you avoids re-deriving the plan.",
  parameters: Type.Object({
    content: Type.String({
      description: "The full scratchpad text (markdown). Replaces the previous content; empty string clears it.",
    }),
  }),
  execute: async (args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const res = await fetch(designUrl(cfg, ctx, "scratchpad"), {
      method: "POST",
      headers: designHeaders(cfg, ctx, true),
      body: JSON.stringify({ content: args.content }),
      signal: ctx.signal,
    });
    if (!res.ok) return { text: `[design_scratchpad failed] ${await readError(res)}` };
    return { text: `scratchpad updated (${Buffer.byteLength(args.content)} bytes)` };
  },
});

// ─── design_render_token ───────────────────────────────────────────────

export const designRenderTokenTool = defineTool({
  name: "design_render_token",
  description:
    "Look up a design-system token's value (color, font, spacing) before using it in the artifact. Token names come from the team's design-tokens.json.",
  parameters: Type.Object({
    token_name: Type.String({ description: "Token name, with or without the leading '--'." }),
  }),
  execute: async (args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const res = await fetch(designUrl(cfg, ctx, "tokens"), {
      headers: designHeaders(cfg, ctx, false),
      signal: ctx.signal,
    });
    if (!res.ok) return { text: `[design_render_token failed] ${await readError(res)}` };
    const body = (await res.json()) as { tokens: Record<string, string> };
    const name = args.token_name.startsWith("--") ? args.token_name : `--${args.token_name}`;
    const value = body.tokens[name];
    if (value === undefined) {
      const available = Object.keys(body.tokens);
      return {
        text:
          available.length === 0
            ? `no design system is connected for this session (no design-tokens.json in the bound repository); use a sensible fallback value`
            : `token ${name} not found. Available tokens: ${available.join(", ")}`,
      };
    }
    return { text: `${name}: ${value}` };
  },
});

// ─── design_comment_resolve ────────────────────────────────────────────

export const designCommentResolveTool = defineTool({
  name: "design_comment_resolve",
  description:
    "Mark a user's element comment as resolved. Resolve a comment only after making the change it asked for.",
  parameters: Type.Object({
    comment_id: Type.String({ description: "The comment id from the user's message." }),
  }),
  execute: async (args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const res = await fetch(
      designUrl(cfg, ctx, `comments/${encodeURIComponent(args.comment_id)}/resolve`),
      { method: "POST", headers: designHeaders(cfg, ctx, false), signal: ctx.signal },
    );
    if (!res.ok) return { text: `[design_comment_resolve failed] ${await readError(res)}` };
    return { text: `resolved comment ${args.comment_id}` };
  },
});

// ─── design_import_marp ────────────────────────────────────────────────

export const designImportMarpTool = defineTool({
  name: "design_import_marp",
  description:
    "Import a Marp Markdown deck from the workspace as this session's artifact. Replaces the current document with the converted deck (a new revision — the previous state stays revertible). Opens an approval gate naming the file.",
  parameters: Type.Object({
    file_path: Type.String({ description: "Workspace path of the .md file, e.g. /workspace/deck.md" }),
  }),
  execute: async (args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };

    // First-use gate (spec §design_import_marp): the user confirms the
    // source file before its content becomes the artifact.
    const resolution = await ctx.requestDecision({
      type: "approval",
      title: "Import Marp deck?",
      body: `Replace the current design with the converted contents of ${args.file_path}. The previous revision stays revertible.`,
      actions: [
        { id: "approve", label: "Import", style: "primary" },
        { id: "deny", label: "Cancel", style: "danger" },
      ],
      resumeKey: `design-import-marp:${args.file_path}`,
    });
    if (resolution.actionId !== "approve") {
      return { text: `import of ${args.file_path} declined by ${resolution.resolvedBy}` };
    }

    let markdown: string;
    try {
      markdown = await ctx.sandbox.readFile(args.file_path);
    } catch (err) {
      return {
        text: `[design_import_marp failed] cannot read ${args.file_path}: ${err instanceof Error ? err.message : String(err)}. Check the path with the read tool.`,
      };
    }
    // Guard: an HTML file fed to the Markdown importer silently produced an
    // empty deck (observed live). Marp input is Markdown.
    if (/^\s*(?:<!DOCTYPE|<html|<x-dc)/i.test(markdown)) {
      return {
        text: `[design_import_marp failed] ${args.file_path} is an HTML document, not Marp Markdown. To use an HTML deck as the artifact, pass its full contents to design_edit kind='rewrite' instead.`,
      };
    }

    const { output, report } = marpToDcHtml(markdown, { createdBy: `user:${ctx.userId}` });
    const beforeImport = await readArtifact(cfg, ctx);
    const res = await fetch(designUrl(cfg, ctx, "edit"), {
      method: "POST",
      headers: designHeaders(cfg, ctx, true),
      body: JSON.stringify({
        content: output,
        summary: `Imported Marp deck from ${args.file_path}`,
        // Fence on the revision current at import time — a user revert
        // during the approval gate rejects instead of being clobbered.
        ...("error" in beforeImport ? {} : { parentRevision: beforeImport.revision }),
        ...(ctx.queueItemId ? { queueItemId: ctx.queueItemId } : {}),
      }),
      signal: ctx.signal,
    });
    if (!res.ok) return { text: `[design_import_marp failed] ${await readError(res)}` };
    const body = (await res.json()) as { revision: string };
    const reportText = report.length > 0 ? `\nimport report:\n- ${report.join("\n- ")}` : "\nimport report: clean import";
    return { text: `imported ${args.file_path} as revision ${body.revision}${reportText}` };
  },
});

// ─── design_import_image ───────────────────────────────────────────────

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export const designImportImageTool = defineTool({
  name: "design_import_image",
  description:
    "Embed an image from the workspace into the artifact. SVG is inlined; PNG/JPG/GIF/WebP are embedded as data: URLs. Appends an <img> (or the SVG) at the end of the document body unless replace_vdid targets an element.",
  parameters: Type.Object({
    file_path: Type.String({ description: "Workspace path of the image file." }),
    replace_vdid: Type.Optional(
      Type.String({ description: "data-vdid of an element to replace with the image. Omit to append." }),
    ),
    alt: Type.Optional(Type.String({ description: "Alt text for the image." })),
  }),
  execute: async (args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };

    const ext = args.file_path.split(".").pop()?.toLowerCase() ?? "";
    let element: string;
    try {
      if (ext === "svg") {
        // Strip the XML prolog, comments, and DOCTYPE that most SVG
        // exporters (Inkscape, Illustrator) prepend — the vdid stamp below
        // and the element patcher both need <svg> as the first element.
        element = (await ctx.sandbox.readFile(args.file_path)).replace(
          /^\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/i,
          "",
        );
      } else {
        const mime = IMAGE_MIME[ext];
        if (!mime) {
          return {
            text: `[design_import_image failed] unsupported image type ".${ext}". Use svg, png, jpg, gif, or webp.`,
          };
        }
        const bytes = await ctx.sandbox.readBinary(args.file_path);
        element = `<img src="data:${mime};base64,${Buffer.from(bytes).toString("base64")}" alt="${(args.alt ?? "").replace(/"/g, "&quot;")}">`;
      }
    } catch (err) {
      return {
        text: `[design_import_image failed] cannot read ${args.file_path}: ${err instanceof Error ? err.message : String(err)}. Check the path with the read tool.`,
      };
    }

    const current = await readArtifact(cfg, ctx);
    if ("error" in current) return { text: `[design_import_image failed] ${current.error}` };

    let content: string;
    if (args.replace_vdid) {
      // Reuse the vdid patch path: stamp the target's vdid on the new element.
      const withVdid = element.replace(/^<(\w+)/, `<$1 data-vdid="${args.replace_vdid}"`);
      try {
        content = applyElementPatches(current.content, withVdid).html;
      } catch (err) {
        return { text: `[design_import_image failed] ${err instanceof Error ? err.message : String(err)}` };
      }
    } else {
      const close = current.content.lastIndexOf("</body>");
      content =
        close >= 0
          ? `${current.content.slice(0, close)}${element}\n${current.content.slice(close)}`
          : `${current.content}\n${element}`;
    }
    if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) {
      return {
        text: `[design_import_image failed] embedding this image would exceed the ${MAX_ARTIFACT_BYTES}-byte artifact cap. Use a smaller image or SVG.`,
      };
    }

    const res = await fetch(designUrl(cfg, ctx, "edit"), {
      method: "POST",
      headers: designHeaders(cfg, ctx, true),
      body: JSON.stringify({
        content,
        summary: `Embedded image ${args.file_path}`,
        parentRevision: current.revision,
        ...(ctx.queueItemId ? { queueItemId: ctx.queueItemId } : {}),
      }),
      signal: ctx.signal,
    });
    if (!res.ok) return { text: `[design_import_image failed] ${await readError(res)}` };
    const body = (await res.json()) as { revision: string; sizeBytes: number };
    return { text: `embedded ${args.file_path}; wrote revision ${body.revision} (${body.sizeBytes} bytes)` };
  },
});

// ─── design_export ─────────────────────────────────────────────────────

/** The ExportManifest gate body (spec §design_export): name what leaves. */
function exportManifest(content: string): string {
  const dataImages = (content.match(/src="data:/g) ?? []).length;
  const externalRefs = [...content.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const styleBlocks = (content.match(/<style/g) ?? []).length;
  const lines = [
    `- artifact document (${Buffer.byteLength(content)} bytes, ${styleBlocks} style block${styleBlocks === 1 ? "" : "s"})`,
    `- ${dataImages} embedded image${dataImages === 1 ? "" : "s"}`,
  ];
  if (externalRefs.length > 0) {
    lines.push(`- external references: ${[...new Set(externalRefs)].join(", ")}`);
  }
  return lines.join("\n");
}

async function getGoogleToken(ctx: ToolContext): Promise<string | null> {
  const cred = await ctx.credentials.get("google_workspace");
  const token = cred?.accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

export const designExportTool = defineTool({
  name: "design_export",
  description:
    "Export the artifact to html, pdf, pptx, or gslides. html/pdf/pptx land in /workspace/exports/; gslides creates a Google Slides presentation and returns its URL. Exports never mutate the artifact. Opens an export-manifest approval gate naming everything that leaves.",
  parameters: Type.Object({
    format: Type.Union(
      [
        Type.Literal("html"),
        Type.Literal("project"),
        Type.Literal("pdf"),
        Type.Literal("pptx"),
        Type.Literal("gslides"),
      ],
      {
        description:
          "Target format. 'project' exports a directory: the deck (with the standalone viewer), scratchpad.md, and the design system (tokens.css + README).",
      },
    ),
    filename: Type.Optional(
      Type.String({ description: "Output file name (html/pdf/pptx) or presentation title (gslides)." }),
    ),
  }),
  execute: async (args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const current = await readArtifact(cfg, ctx);
    if ("error" in current) return { text: `[design_export failed] ${current.error}` };

    // The filename reaches a `sh -c` command line and a workspace path.
    // Reduce it to a safe charset — no separators, no shell metacharacters —
    // so it can neither escape /workspace/exports nor inject into the
    // marp-cli invocation below. Computed BEFORE the gate so the user
    // approves the actual output destination.
    let baseName =
      (args.filename ?? `design-${current.revision}`)
        .replace(/\.(html|pdf|pptx)$/, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^[.-]+/, "")
        .slice(0, 100) || `design-${current.revision}`;
    // Never overwrite a previous export: probe for a free name (a prior
    // approved deliverable disappearing silently is worse than a suffix).
    if (args.format !== "gslides") {
      const probe = async (candidate: string): Promise<boolean> => {
        try {
          await ctx.sandbox.stat(
            args.format === "project"
              ? `/workspace/exports/${candidate}`
              : `/workspace/exports/${candidate}.${args.format}`,
          );
          return true; // exists
        } catch {
          return false;
        }
      };
      if (await probe(baseName)) {
        for (let n = 2; n <= 20; n++) {
          if (!(await probe(`${baseName}-${n}`))) {
            baseName = `${baseName}-${n}`;
            break;
          }
        }
      }
    }

    const destination =
      args.format === "gslides"
        ? `a new Google Slides presentation titled "${args.filename ?? "from the deck's own title"}" in the connected Google Drive`
        : args.format === "project"
          ? `/workspace/exports/${baseName}/ (deck + scratchpad + design system)`
          : `/workspace/exports/${baseName}.${args.format}`;

    // ExportManifest gate (spec §design_export + threat 8): the user
    // approves the scope of what leaves — every referenced file named,
    // plus the output destination.
    const resolution = await ctx.requestDecision({
      type: "approval",
      title: `Export design as ${args.format}?`,
      body: `This export includes:\n${exportManifest(current.content)}\n- output: ${destination}`,
      actions: [
        { id: "approve", label: "Export", style: "primary" },
        { id: "deny", label: "Cancel", style: "danger" },
      ],
      resumeKey: `design-export:${args.format}:${current.revision}`,
    });
    if (resolution.actionId !== "approve") {
      return { text: `${args.format} export declined by ${resolution.resolvedBy}` };
    }

    if (args.format === "project") {
      // Project-directory export (the Claude Design layout): the artifact,
      // the scratchpad, and the design system as a folder a person (or
      // another agent) can pick up whole.
      const dir = `/workspace/exports/${baseName}`;
      const isDeck = (parseHeader(current.content)?.template ?? "") === "slides";
      for (const d of ["/workspace/exports", dir, `${dir}/design-system`]) {
        try {
          await ctx.sandbox.mkdir(d);
        } catch {
          // Already exists — fine.
        }
      }
      const written: string[] = [];
      const deck = isDeck ? injectDeckRuntime(current.content) : current.content;
      await ctx.sandbox.writeFile(`${dir}/${baseName}.dc.html`, deck);
      written.push(`${baseName}.dc.html`);
      if (current.scratchpad.trim()) {
        await ctx.sandbox.writeFile(`${dir}/scratchpad.md`, current.scratchpad);
        written.push("scratchpad.md");
      }
      const tokensRes = await fetch(designUrl(cfg, ctx, "tokens"), {
        headers: designHeaders(cfg, ctx, false),
        signal: ctx.signal,
      });
      if (tokensRes.ok) {
        const { tokens } = (await tokensRes.json()) as { tokens: Record<string, string> };
        const css = `:root {\n${Object.entries(tokens)
          .map(([name, value]) => `  ${name}: ${value};`)
          .join("\n")}\n}\n`;
        await ctx.sandbox.writeFile(`${dir}/design-system/tokens.css`, css);
        await ctx.sandbox.writeFile(
          `${dir}/design-system/_ds_manifest.json`,
          JSON.stringify(
            { namespace: "valet", tokens: Object.entries(tokens).map(([name, value]) => ({ name, value })) },
            null,
            2,
          ),
        );
        written.push("design-system/tokens.css", "design-system/_ds_manifest.json");
      }
      await ctx.sandbox.writeFile(`${dir}/design-system/README.md`, DESIGN_CRAFT_GUIDE);
      written.push("design-system/README.md");
      return { text: `exported revision ${current.revision} to ${dir}/ (${written.join(", ")})` };
    }

    if (args.format === "html") {
      const path = `/workspace/exports/${baseName}.html`;
      try {
        await ctx.sandbox.mkdir("/workspace/exports");
      } catch {
        // Already exists — fine.
      }
      // Slides exports get a small standalone viewer runtime (keyboard
      // navigation + speaker notes), the way Claude Design exports do.
      // Export-only: this copy runs in a real browser; the canvas
      // sanitizer never sees it.
      const isDeck = (parseHeader(current.content)?.template ?? "") === "slides";
      const exported = isDeck ? injectDeckRuntime(current.content) : current.content;
      await ctx.sandbox.writeFile(path, exported);
      return {
        text: `exported revision ${current.revision} to ${path}. The user can download it from the canvas Export menu under "Exported files".`,
      };
    }

    if (args.format === "pdf" || args.format === "pptx") {
      const { output: markdown, report } = dcHtmlToMarp(current.content);
      // The intermediate markdown must live under /workspace: on the docker
      // provider, writeFile lands on the HOST filesystem and only the
      // workspace bind mount is visible to exec() inside the container. A
      // /tmp path writes to the host and marp then can't find its input.
      const mdPath = `/workspace/exports/.valet-design-export.md`;
      const outPath = `/workspace/exports/${baseName}.${args.format}`;
      try {
        await ctx.sandbox.mkdir("/workspace/exports");
      } catch {
        // Already exists — fine.
      }
      await ctx.sandbox.writeFile(mdPath, markdown);
      const flag = args.format === "pdf" ? "--pdf" : "--pptx";
      // Prefer the globally installed `marp` binary (the stock image,
      // docker/Dockerfile.sandbox-k8s, bakes marp-cli@4 exactly so exports
      // work with registry egress denied).
      // The npx fallback pins @4 to match the baked major — an unpinned
      // `@latest` always consults the registry, defeating the offline install.
      const result = await ctx.sandbox.exec(
        `if command -v marp >/dev/null 2>&1; then marp ${mdPath} ${flag} --allow-local-files -o ${outPath}; else npx -y @marp-team/marp-cli@4 ${mdPath} ${flag} --allow-local-files -o ${outPath}; fi`,
        { timeout: 180_000 },
      );
      if (result.exitCode !== 0) {
        return {
          text: `[design_export failed] marp-cli exited ${result.exitCode}: ${(result.stderr || result.stdout).slice(-800)}. PDF/PPTX rendering needs marp-cli + Chromium, which the stock sandbox image ships (docker/Dockerfile.sandbox-k8s) — this sandbox is running an older or minimal image. For PDF, tell the user to use the canvas Export menu -> PDF instead: it opens a print view in their browser and Save as PDF is instant and full-fidelity. As a fallback, design_export html produces a standalone deck the user can download from the Export menu under "Exported files".`,
        };
      }
      await ctx.sandbox.exec(`rm -f ${mdPath}`, { timeout: 10_000 }).catch(() => {
        // Leftover intermediate file is harmless (dotfile in exports/).
      });
      const reportText = report.length > 0 ? `\nexport report:\n- ${report.join("\n- ")}` : "";
      return {
        text: `exported revision ${current.revision} to ${outPath}. The user can download it from the canvas Export menu under "Exported files".${reportText}`,
      };
    }

    // gslides
    const token = await getGoogleToken(ctx);
    if (!token) {
      return {
        text: "[design_export failed] Missing Google Workspace credential. Connect Google Workspace in Settings, then retry the export.",
      };
    }
    const { title, chunks, report } = dcHtmlToSlidesChunks(current.content, args.filename ?? "Valet Design export");
    try {
      const presentation = await createPresentation(args.filename ?? title, token);
      const result = await batchUpdateChunked(presentation.presentationId, chunks, token, {
        ...(presentation.revisionId ? { initialRevisionId: presentation.revisionId } : {}),
      });
      const url = `https://docs.google.com/presentation/d/${presentation.presentationId}/edit`;
      const reportText = report.length > 0 ? `\nexport report:\n- ${report.join("\n- ")}` : "\nexport report: clean export";
      if (result.error) {
        return {
          text: `[design_export partial] ${result.error}. ${result.applied}/${chunks.length} slides applied to ${url}. Retry the export to recreate cleanly, or fix the named slide.${reportText}`,
        };
      }
      return {
        text: `exported revision ${current.revision} to Google Slides: ${url} (presentation id ${presentation.presentationId})${reportText}`,
      };
    } catch (err) {
      return { text: `[design_export failed] ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});


// ─── design_import_gslides ─────────────────────────────────────────────

export const designImportGslidesTool = defineTool({
  name: "design_import_gslides",
  description:
    "Import a Google Slides presentation as this session's artifact (a new revision — the previous state stays revertible). Elements exported by design_export keep their ids, so comment anchors survive the round trip.",
  parameters: Type.Object({
    presentation_id: Type.String({ description: "Google Slides presentation ID (from the URL or a prior export)." }),
  }),
  execute: async (args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };

    const resolution = await ctx.requestDecision({
      type: "approval",
      title: "Import Google Slides presentation?",
      body: `Replace the current design with the converted contents of presentation ${args.presentation_id}. The previous revision stays revertible.`,
      actions: [
        { id: "approve", label: "Import", style: "primary" },
        { id: "deny", label: "Cancel", style: "danger" },
      ],
      resumeKey: `design-import-gslides:${args.presentation_id}`,
    });
    if (resolution.actionId !== "approve") {
      return { text: `import of presentation ${args.presentation_id} declined by ${resolution.resolvedBy}` };
    }

    const token = await getGoogleToken(ctx);
    if (!token) {
      return {
        text: "[design_import_gslides failed] Missing Google Workspace credential. Connect Google Workspace in Settings, then retry the import.",
      };
    }
    try {
      const presentation: MinimalPresentation = await getPresentation(args.presentation_id, token);
      const { output, report } = slidesToDcHtml(presentation);
      const beforeImport = await readArtifact(cfg, ctx);
      const res = await fetch(designUrl(cfg, ctx, "edit"), {
        method: "POST",
        headers: designHeaders(cfg, ctx, true),
        body: JSON.stringify({
          content: output,
          summary: `Imported Google Slides presentation ${args.presentation_id}`,
          ...("error" in beforeImport ? {} : { parentRevision: beforeImport.revision }),
          ...(ctx.queueItemId ? { queueItemId: ctx.queueItemId } : {}),
        }),
        signal: ctx.signal,
      });
      if (!res.ok) return { text: `[design_import_gslides failed] ${await readError(res)}` };
      const body = (await res.json()) as { revision: string };
      const reportText =
        report.length > 0 ? `\nimport report:\n- ${report.join("\n- ")}` : "\nimport report: clean import";
      return { text: `imported presentation ${args.presentation_id} as revision ${body.revision}${reportText}` };
    } catch (err) {
      return { text: `[design_import_gslides failed] ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

// ─── design_handoff ────────────────────────────────────────────────────

export const designHandoffTool = defineTool({
  name: "design_handoff",
  description:
    "Spawn a coding child session that starts from this design. The child receives the artifact and your implementation direction; if this session has a repository bound, the child clones the same repository. Use when the user asks to implement, ship, or build the design.",
  parameters: Type.Object({
    implementation_task: Type.Optional(
      Type.String({ description: "Direction for the coding child (what to build, where, constraints)." }),
    ),
  }),
  execute: async (args, ctx): Promise<ToolResult> => {
    const cfg = resolveDesignConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const rawSpawner = ctx.config?.childSpawner;
    if (typeof rawSpawner !== "function") {
      return { text: "[design_handoff unavailable] this session cannot spawn child sessions" };
    }
    const spawner = rawSpawner as ChildSpawner; // narrowed by the typeof check above

    const current = await readArtifact(cfg, ctx);
    if ("error" in current) return { text: `[design_handoff failed] ${current.error}` };
    const template = parseHeader(current.content)?.template ?? "document";

    // The artifact rides in the child's prompt, so its size is prompt
    // tokens. Embedded base64 images are useless to the model and can be
    // ~2 MB alone — replace them with a marker. If the document is still
    // huge after that, truncate with a notice rather than blowing the
    // child's context window.
    const HANDOFF_CONTENT_CAP = 150_000;
    let embedded = current.content.replace(
      /src="data:[^"]*"/g,
      'src="[embedded image omitted from handoff brief]"',
    );
    let truncationNote = "";
    if (embedded.length > HANDOFF_CONTENT_CAP) {
      embedded = embedded.slice(0, HANDOFF_CONTENT_CAP);
      truncationNote =
        "\n[artifact truncated for the handoff brief — ask the user for the full document if the tail matters]";
    }

    const prompt = [
      "You are implementing a design produced in a Valet Design session.",
      args.implementation_task
        ? `Implementation task: ${args.implementation_task}`
        : "Implement this design faithfully in the codebase.",
      `The design is a ${template} artifact (self-contained HTML, revision ${current.revision}).`,
      "Treat the artifact below as the source of truth for layout, copy, and styling intent; adapt it to the project's stack and design system.",
      "",
      "---- design artifact (.dc.html) ----",
      embedded + truncationNote,
      "---- end artifact ----",
    ].join("\n");

    const req: SpawnChildRequest = {
      prompt,
      title: "Implement design → code",
      ...(ctx.repo?.url ? { repo: ctx.repo.url, ...(ctx.repo.branch ? { branch: ctx.repo.branch } : {}) } : {}),
    };
    const owner = ctx.owner ?? { type: "user", id: ctx.userId };
    const result = await spawner(req, {
      parentSessionId: ctx.sessionId,
      parentThreadId: ctx.threadId,
      actorUserId: ctx.userId,
      owner,
    });
    return {
      text: `spawned coding child ${result.childSessionId} from revision ${current.revision}. Its result will arrive in this thread as a child.settled signal.`,
    };
  },
});

/** The design ToolDefs a `kind='design'` session gets, in registration order. */
export function buildDesignTools(): ToolDef[] {
  return [
    designReadTool,
    designEditTool,
    designScratchpadTool,
    designRenderTokenTool,
    designCommentResolveTool,
    designImportMarpTool,
    designImportImageTool,
    designImportGslidesTool,
    designExportTool,
    designHandoffTool,
  ];
}
