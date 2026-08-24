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
import { applyElementPatches, marpToDcHtml, parseHeader, MAX_ARTIFACT_BYTES } from "@valet/plugin-design/lib";

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
}

async function readArtifact(cfg: DesignToolConfig, ctx: ToolContext): Promise<ArtifactRead | { error: string }> {
  const res = await fetch(designUrl(cfg, ctx, "artifact"), {
    headers: designHeaders(cfg, ctx, false),
    signal: ctx.signal,
  });
  if (!res.ok) return { error: await readError(res) };
  const body = (await res.json()) as { revision: string; content: string };
  return { revision: body.revision, content: body.content };
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

    const res = await fetch(designUrl(cfg, ctx, "edit"), {
      method: "POST",
      headers: designHeaders(cfg, ctx, true),
      body: JSON.stringify({
        content,
        summary: args.summary ?? "",
        ...(parentRevision ? { parentRevision } : {}),
      }),
      signal: ctx.signal,
    });
    if (!res.ok) return { text: `[design_edit failed] ${await readError(res)}` };
    const body = (await res.json()) as { revision: string; sizeBytes: number };
    return { text: `wrote revision ${body.revision} (${body.sizeBytes} bytes)${patchNote}` };
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

    const { output, report } = marpToDcHtml(markdown, { createdBy: `user:${ctx.userId}` });
    const res = await fetch(designUrl(cfg, ctx, "edit"), {
      method: "POST",
      headers: designHeaders(cfg, ctx, true),
      body: JSON.stringify({ content: output, summary: `Imported Marp deck from ${args.file_path}` }),
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
        element = await ctx.sandbox.readFile(args.file_path);
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
      }),
      signal: ctx.signal,
    });
    if (!res.ok) return { text: `[design_import_image failed] ${await readError(res)}` };
    const body = (await res.json()) as { revision: string; sizeBytes: number };
    return { text: `embedded ${args.file_path}; wrote revision ${body.revision} (${body.sizeBytes} bytes)` };
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

    const prompt = [
      "You are implementing a design produced in a Valet Design session.",
      args.implementation_task
        ? `Implementation task: ${args.implementation_task}`
        : "Implement this design faithfully in the codebase.",
      `The design is a ${template} artifact (self-contained HTML, revision ${current.revision}).`,
      "Treat the artifact below as the source of truth for layout, copy, and styling intent; adapt it to the project's stack and design system.",
      "",
      "---- design artifact (.dc.html) ----",
      current.content,
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
    designEditTool,
    designRenderTokenTool,
    designCommentResolveTool,
    designImportMarpTool,
    designImportImageTool,
    designHandoffTool,
  ];
}
