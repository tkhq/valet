import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { figmaGet, figmaErrorMessage } from './api.js';

const MAX_NODES = 4;
const MAX_IMAGE_BYTES = 1024 * 1024;
// The runner gives up on a tool call after 30 s; leave headroom for the worker.
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
    throw new Error(`Not a Figma URL or file key: "${trimmed}"`);
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

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ─── Action Definitions ──────────────────────────────────────────────────────

const fileParam = z.string().describe('Figma file URL (figma.com/design/... or figma.com/file/...) or file key');

const renderFramesParams = z.object({
  file: fileParam,
  node_ids: z.array(z.string()).optional().describe('Node ids to render, e.g. ["1:2", "3:4"]. Defaults to the node-id in the URL.'),
  scale: z.number().min(0.01).max(4).optional().describe('Render scale, 0.01 to 4. Default 1.'),
});

const listFramesParams = z.object({
  file: fileParam,
  page_id: z.string().optional().describe('Only list this page, e.g. "0:1"'),
});

const renderFrames: ActionDefinition = {
  id: 'figma.render_frames',
  name: 'Render Frames',
  description: `Render Figma nodes (frames, components, sections) to PNG images you can see. Pass a Figma URL that contains node-id, or a file plus node_ids from figma.list_frames. At most ${MAX_NODES} nodes per call, and each PNG must be under 1 MiB; lower scale for large frames.`,
  riskLevel: 'low',
  params: renderFramesParams,
  outputSchema: {
    type: 'object',
    description: 'Metadata only; the PNGs are delivered to vision.',
    properties: {
      file_key: { type: 'string' },
      scale: { type: 'number' },
      rendered: {
        type: 'array',
        items: { type: 'object', properties: { node_id: { type: 'string' }, bytes: { type: 'number' } } },
      },
      failed: {
        type: 'array',
        items: { type: 'object', properties: { node_id: { type: 'string' }, error: { type: 'string' } } },
      },
    },
  },
};

const listFrames: ActionDefinition = {
  id: 'figma.list_frames',
  name: 'List Frames',
  description: 'List the pages of a Figma file and the top-level frames, components and sections on each page. Use this to find node ids for figma.render_frames when the URL has no node-id.',
  riskLevel: 'low',
  params: listFramesParams,
  outputSchema: {
    type: 'object',
    properties: {
      file_key: { type: 'string' },
      name: { type: 'string' },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            frames: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
};

const allActions: ActionDefinition[] = [renderFrames, listFrames];

// ─── Handlers ────────────────────────────────────────────────────────────────

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

async function executeRenderFrames(params: unknown, token: string, signal: AbortSignal): Promise<ActionResult> {
  const p = renderFramesParams.parse(params);
  const { fileKey, nodeId } = parseFigmaFile(p.file);
  const requested = p.node_ids?.length ? p.node_ids : nodeId ? [nodeId] : [];
  const ids = [...new Set(requested.map(normalizeNodeId))];

  if (ids.length === 0) {
    return { success: false, error: 'No node ids given. Call figma.list_frames to find frame ids, then pass a few as node_ids. Whole files are not rendered.' };
  }
  if (ids.length > MAX_NODES) {
    return { success: false, error: `At most ${MAX_NODES} nodes per call (got ${ids.length}). Pick the most relevant frames or split into several calls.` };
  }
  const invalid = ids.filter((id) => !NODE_ID_RE.test(id));
  if (invalid.length > 0) {
    return { success: false, error: `Invalid node ids: ${invalid.join(', ')}. Expected ids like "1:2".` };
  }

  const scale = p.scale ?? 1;
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

  return {
    success: true,
    data: {
      file_key: fileKey,
      scale,
      rendered: rendered.map((r) => ({ node_id: r.nodeId, bytes: r.bytes.byteLength })),
      failed,
    },
    images: rendered.map((r) => ({
      data: toBase64(r.bytes),
      mimeType: 'image/png',
      description: `Figma node ${r.nodeId} in file ${fileKey} (scale ${scale})`,
    })),
  };
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
}

async function executeListFrames(params: unknown, token: string, signal: AbortSignal): Promise<ActionResult> {
  const p = listFramesParams.parse(params);
  const { fileKey } = parseFigmaFile(p.file);

  const res = await figmaGet(`/files/${fileKey}?depth=2`, token, signal);
  if (!res.ok) return { success: false, error: await figmaErrorMessage(res) };

  const body = (await res.json()) as { name?: string; document?: { children?: FigmaNode[] } };
  let pages = (body.document?.children ?? []).filter((n) => n.type === 'CANVAS');
  if (p.page_id) {
    const pageId = normalizeNodeId(p.page_id);
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
}

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = ctx.credentials.access_token || '';
  if (!token) return { success: false, error: 'Missing access_token' };

  const signal = AbortSignal.timeout(REQUEST_BUDGET_MS);
  try {
    switch (actionId) {
      case 'figma.render_frames':
        return await executeRenderFrames(params, token, signal);
      case 'figma.list_frames':
        return await executeListFrames(params, token, signal);
      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    if (signal.aborted) {
      return { success: false, error: `Figma did not respond within ${REQUEST_BUDGET_MS / 1000} s. Try fewer nodes or a lower scale.` };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const figmaActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
