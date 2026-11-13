import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
  ToolAttachment,
} from '@valet/engine';
import { figmaGet, figmaErrorMessage } from './api.js';

const MAX_NODES = 4;
const MAX_IMAGE_BYTES = 1024 * 1024;
// A tool call has a 30 s limit; leave room for the rest of the call.
const REQUEST_BUDGET_MS = 20_000;

const FILE_KEY_RE = /^[A-Za-z0-9]+$/;
const NODE_ID_RE = /^I?\d+:\d+(;\d+:\d+)*$/;
const FRAME_TYPES = new Set(['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET']);

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** URLs write node ids as `123-456`; the API expects `123:456`. */
export function normalizeNodeId(id: string): string {
  return id.trim().replace(/-/g, ':');
}

/** Extract the file key and optional node id from a Figma URL or a bare file key. */
export function parseFigmaFile(input: string): { fileKey: string; nodeId?: string } {
  const trimmed = input.trim();
  if (FILE_KEY_RE.test(trimmed)) return { fileKey: trimmed };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Not a Figma URL or file key: "${trimmed}". Pass a figma.com/design/... link or a file key.`);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const isFigmaHost = url.hostname === 'figma.com' || url.hostname.endsWith('.figma.com');
  if (!isFigmaHost || (parts[0] !== 'file' && parts[0] !== 'design') || !parts[1]) {
    throw new Error(`Expected a figma.com/file/... or figma.com/design/... URL, got "${trimmed}"`);
  }
  const fileKey = parts[2] === 'branch' && parts[3] ? parts[3] : parts[1];
  if (!FILE_KEY_RE.test(fileKey)) {
    throw new Error(`Invalid Figma file key in URL: "${fileKey}"`);
  }
  const nodeParam = url.searchParams.get('node-id');
  return nodeParam ? { fileKey, nodeId: normalizeNodeId(nodeParam) } : { fileKey };
}

// ─── Action builder ──────────────────────────────────────────────────────────

/** Curried builder: the first call binds the schema, the second types `execute`. */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction['riskLevel'];
    label?: PluginAction<TParams>['label'];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

const fileParam = Type.String({
  description: 'Figma file URL (figma.com/design/... or figma.com/file/...) or file key',
});

/**
 * Run `fn` with the caller's token under one time budget. A missing token,
 * a bad URL, and the timeout all come back as errors the model can act on.
 */
async function withFigma(
  ctx: PluginActionContext,
  fn: (token: string, signal: AbortSignal) => Promise<PluginActionResult>,
): Promise<PluginActionResult> {
  const cred = await ctx.credentials.get();
  const token = cred?.accessToken ?? '';
  if (!token) {
    return {
      success: false,
      error: 'Figma is not connected. Ask the user to connect Figma on the Integrations page.',
    };
  }
  const budget = AbortSignal.timeout(REQUEST_BUDGET_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, budget]) : budget;
  try {
    return await fn(token, signal);
  } catch (error) {
    if (budget.aborted) {
      return { success: false, error: `Figma did not respond within ${REQUEST_BUDGET_MS / 1000} s. Try fewer nodes or a lower scale.` };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── render_frames ───────────────────────────────────────────────────────────

type Download =
  | { ok: true; nodeId: string; bytes: Uint8Array }
  | { ok: false; nodeId: string; error: string };

function tooLarge(size: number, scale: number): string {
  const suggested = Math.max(0.01, Math.floor(scale * Math.sqrt(MAX_IMAGE_BYTES / size) * 0.9 * 100) / 100);
  return `Rendered PNG is ${(size / MAX_IMAGE_BYTES).toFixed(1)} MiB, over the 1 MiB limit. Retry with a lower scale (try ${suggested}).`;
}

async function downloadRender(
  nodeId: string,
  url: string | null | undefined,
  scale: number,
  signal: AbortSignal,
): Promise<Download> {
  if (!url) {
    return { ok: false, nodeId, error: 'Figma could not render this node. It may not exist, or it may be invisible or empty.' };
  }
  // Render URLs are pre-signed CDN links; the Figma token must not go to them.
  const res = await fetch(url, { signal });
  if (!res.ok) {
    return { ok: false, nodeId, error: `Image download failed: HTTP ${res.status}` };
  }
  const declared = Number(res.headers.get('Content-Length'));
  if (declared > MAX_IMAGE_BYTES) {
    await res.body?.cancel();
    return { ok: false, nodeId, error: tooLarge(declared, scale) };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, nodeId, error: tooLarge(bytes.byteLength, scale) };
  }
  return { ok: true, nodeId, bytes };
}

const renderFrames = action(
  Type.Object({
    file: fileParam,
    node_ids: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Node ids to render, e.g. ["1:2", "3:4"]. Defaults to the node-id in the URL.',
      }),
    ),
    scale: Type.Optional(Type.Number({ minimum: 0.01, maximum: 4, description: 'Render scale, 0.01 to 4. Default 1.' })),
  }),
)({
  id: 'figma.render_frames',
  name: 'Render Frames',
  description: `Render Figma nodes (frames, components, sections) to PNG images you can see. Pass a Figma URL that contains node-id, or a file plus node_ids from figma.list_frames. At most ${MAX_NODES} nodes per call, and each PNG must be under 1 MiB; lower the scale for large frames.`,
  riskLevel: 'low',
  label: (args) => `Rendered ${args.node_ids?.length ?? 1} Figma frame${(args.node_ids?.length ?? 1) === 1 ? '' : 's'}`,
  execute: (args, ctx) =>
    withFigma(ctx, async (token, signal) => {
      const { fileKey, nodeId } = parseFigmaFile(args.file);
      const requested = args.node_ids?.length ? args.node_ids : nodeId ? [nodeId] : [];
      const ids = [...new Set(requested.map(normalizeNodeId))];

      if (ids.length === 0) {
        return { success: false, error: 'No node ids given. Call figma.list_frames to find frame ids, then pass a few as node_ids. Whole files are not rendered.' };
      }
      if (ids.length > MAX_NODES) {
        return { success: false, error: `At most ${MAX_NODES} nodes per call (got ${ids.length}). Pick the most relevant frames or split them into several calls.` };
      }
      const invalid = ids.filter((id) => !NODE_ID_RE.test(id));
      if (invalid.length > 0) {
        return { success: false, error: `Invalid node ids: ${invalid.join(', ')}. Expected ids like "1:2".` };
      }

      const scale = args.scale ?? 1;
      if (!(scale >= 0.01 && scale <= 4)) {
        return { success: false, error: `Scale ${scale} is out of range. Use a scale from 0.01 to 4.` };
      }
      const query = new URLSearchParams({ ids: ids.join(','), format: 'png', scale: String(scale) });
      const res = await figmaGet(`/images/${fileKey}?${query}`, token, signal);
      if (!res.ok) return { success: false, error: await figmaErrorMessage(res) };

      const body = (await res.json()) as { err?: string | null; images?: Record<string, string | null> };
      if (body.err) return { success: false, error: `Figma render failed: ${body.err}` };
      const urls = body.images ?? {};

      const downloads = await Promise.all(ids.map((id) => downloadRender(id, urls[id], scale, signal)));
      const rendered = downloads.filter((d): d is Extract<Download, { ok: true }> => d.ok);
      const failed = downloads
        .filter((d): d is Extract<Download, { ok: false }> => !d.ok)
        .map((d) => ({ node_id: d.nodeId, error: d.error }));

      if (rendered.length === 0) {
        return { success: false, error: failed.map((f) => `${f.node_id}: ${f.error}`).join(' ') };
      }

      const attachments: ToolAttachment[] = rendered.map((r) => ({
        type: 'image',
        data: r.bytes,
        mimeType: 'image/png',
        name: `figma-${fileKey}-${r.nodeId.replace(/[:;]/g, '-')}.png`,
      }));
      return {
        success: true,
        data: {
          file_key: fileKey,
          scale,
          rendered: rendered.map((r) => ({ node_id: r.nodeId, bytes: r.bytes.byteLength })),
          failed,
        },
        attachments,
      };
    }),
});

// ─── list_frames ─────────────────────────────────────────────────────────────

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
}

const listFrames = action(
  Type.Object({
    file: fileParam,
    page_id: Type.Optional(Type.String({ description: 'Only list this page, e.g. "0:1"' })),
  }),
)({
  id: 'figma.list_frames',
  name: 'List Frames',
  description: 'List the pages of a Figma file and the top-level frames, components and sections on each page. Use this to find node ids for figma.render_frames when the URL has no node-id.',
  riskLevel: 'low',
  label: () => 'Listed Figma frames',
  execute: (args, ctx) =>
    withFigma(ctx, async (token, signal) => {
      const { fileKey } = parseFigmaFile(args.file);
      const res = await figmaGet(`/files/${fileKey}?depth=2`, token, signal);
      if (!res.ok) return { success: false, error: await figmaErrorMessage(res) };

      const body = (await res.json()) as { name?: string; document?: { children?: FigmaNode[] } };
      let pages = (body.document?.children ?? []).filter((n) => n.type === 'CANVAS');
      if (args.page_id) {
        const pageId = normalizeNodeId(args.page_id);
        const match = pages.filter((pg) => pg.id === pageId);
        if (match.length === 0) {
          return { success: false, error: `Page ${pageId} not found. Pages: ${pages.map((pg) => `${pg.id} (${pg.name})`).join(', ')}` };
        }
        pages = match;
      }

      return {
        success: true,
        data: {
          file_key: fileKey,
          name: body.name ?? '',
          pages: pages.map((pg) => ({
            id: pg.id,
            name: pg.name,
            frames: (pg.children ?? [])
              .filter((n) => FRAME_TYPES.has(n.type))
              .map((n) => ({ id: n.id, name: n.name, type: n.type })),
          })),
        },
      };
    }),
});

export const figmaPlugin: ActionPlugin = {
  service: 'figma',
  displayName: 'Figma',
  description: 'Figma: render frames to images and list a file\'s frames.',
  requiresCredential: true,
  actions: [renderFrames, listFrames],
};
