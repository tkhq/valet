/**
 * Google Slides transport helpers (Valet Design spec, §Google Slides
 * Integration). Shared by the `slides.*` plugin actions below AND the
 * design_export/design_import_gslides ToolDefs in packages/api — spec
 * Decision 6 keeps every Slides call on this one module (one credential,
 * one client) instead of a second integration reaching
 * slides.googleapis.com on its own.
 *
 * `batchUpdateChunked` is the write path's safety contract: requests are
 * split per slide, and every chunk carries
 * `writeControl.requiredRevisionId` pinned to the revision the previous
 * chunk returned — a concurrent human edit rejects the chunk instead of
 * interleaving half an export into their changes. A failed chunk returns
 * the index it stopped at, so a retry resumes rather than replays.
 */

const SLIDES_API = "https://slides.googleapis.com/v1";

export interface SlidesPage {
  objectId: string;
  pageElements?: SlidesPageElement[];
  slideProperties?: { notesPage?: { pageElements?: SlidesPageElement[] } };
}

export interface SlidesPageElement {
  objectId: string;
  shape?: {
    shapeType?: string;
    placeholder?: { type?: string };
    text?: { textElements?: Array<{ textRun?: { content?: string; style?: Record<string, unknown> }; paragraphMarker?: { bullet?: unknown } }> };
  };
  image?: { contentUrl?: string; sourceUrl?: string };
}

export interface SlidesPresentation {
  presentationId: string;
  title?: string;
  revisionId?: string;
  slides?: SlidesPage[];
}

export class SlidesApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Google Slides API error (HTTP ${status}): ${detail}`);
  }
}

async function slidesFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SLIDES_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

async function raiseError(res: Response): Promise<never> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    detail = res.statusText;
  }
  throw new SlidesApiError(res.status, detail || "no detail");
}

export async function getPresentation(presentationId: string, token: string): Promise<SlidesPresentation> {
  const res = await slidesFetch(`/presentations/${encodeURIComponent(presentationId)}`, token);
  if (!res.ok) await raiseError(res);
  return (await res.json()) as SlidesPresentation;
}

export async function createPresentation(title: string, token: string): Promise<SlidesPresentation> {
  const res = await slidesFetch("/presentations", token, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  if (!res.ok) await raiseError(res);
  return (await res.json()) as SlidesPresentation;
}

export interface BatchUpdateChunk {
  /** Requests for one slide (or one logical unit). */
  requests: unknown[];
}

export interface BatchUpdateResult {
  /** Chunks applied before stopping. Equal to chunks.length on success. */
  applied: number;
  /** The presentation's revision id after the last applied chunk. */
  revisionId?: string;
  /** Set when a chunk failed; `applied` names the resume point. */
  error?: string;
}

/**
 * Apply chunks in order, each fenced on the revision the previous write
 * returned. `startAt` resumes a previously failed run at its `applied`
 * index.
 */
export async function batchUpdateChunked(
  presentationId: string,
  chunks: BatchUpdateChunk[],
  token: string,
  opts: { startAt?: number; initialRevisionId?: string } = {},
): Promise<BatchUpdateResult> {
  let revisionId = opts.initialRevisionId;
  let applied = opts.startAt ?? 0;

  for (let i = applied; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.requests.length === 0) {
      applied = i + 1;
      continue;
    }
    const res = await slidesFetch(`/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, token, {
      method: "POST",
      body: JSON.stringify({
        requests: chunk.requests,
        ...(revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {}),
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body.error?.message ?? res.statusText;
      } catch {
        detail = res.statusText;
      }
      return {
        applied,
        revisionId,
        error: `chunk ${i + 1}/${chunks.length} rejected (HTTP ${res.status}): ${detail}`,
      };
    }
    const body = (await res.json()) as { writeControl?: { requiredRevisionId?: string } };
    revisionId = body.writeControl?.requiredRevisionId ?? revisionId;
    applied = i + 1;
  }
  return { applied, revisionId };
}
