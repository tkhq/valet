import { Type, type Static, type TSchema } from 'typebox';
import type { PluginAction, PluginActionContext, PluginActionResult } from '@valet/engine';

const API = 'https://slides.googleapis.com/v1/presentations';
const id = Type.String({ minLength: 1, pattern: '^[a-zA-Z0-9_-]+$', description: 'Presentation ID from its /presentation/d/ URL; supply the ID, not the URL.' });
const pageId = Type.String({ minLength: 1, description: 'Slide objectId returned by slides.get_presentation.' });

function action<T extends TSchema>(parameters: T, rest: {
  id: string; name: string; description: string; riskLevel: PluginAction['riskLevel'];
  execute: (args: Static<T>, ctx: PluginActionContext) => Promise<PluginActionResult>;
}): PluginAction<T> { return { parameters, ...rest }; }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request(ctx: PluginActionContext, path: string, body?: unknown): Promise<PluginActionResult> {
  const token = (await ctx.credentials.get())?.accessToken;
  if (!token) return { success: false, error: 'Connect Google Workspace in Settings before editing presentations.' };
  try {
    const res = await fetch(`${API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctx.signal,
    });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = undefined; }
    if (res.ok) {
      if (data === undefined) return { success: false, error: 'Slides returned an unreadable response. Read the presentation to check its state before retrying edits.' };
      return { success: true, data };
    }
    const error = object(data) && object(data.error) ? data.error : undefined;
    const detail = typeof error?.message === 'string' ? error.message.slice(0, 1500) : text.slice(0, 200);
    const disabled = Array.isArray(error?.details) && error.details.some((item: unknown) => object(item) && item.reason === 'SERVICE_DISABLED');
    let remedy = 'Check the request and try again.';
    if (res.status === 403 && (disabled || /API has not been used.*disabled/i.test(detail))) {
      remedy = 'Ask the Google Cloud project administrator to enable the Slides API: https://console.cloud.google.com/apis/library/slides.googleapis.com. Retry after enabling it; a browser tunnel will not fix this configuration.';
    } else if (res.status === 401) remedy = 'Reconnect Google Workspace in Settings.';
    else if (res.status === 403 || res.status === 404) remedy = 'Check the presentation ID and give the connected Google account access to the presentation.';
    else if (res.status === 400) remedy = 'Read the presentation again, use its latest revisionId, and correct the update requests before retrying.';
    else if (res.status === 429 || res.status >= 500) remedy = 'Wait before retrying. Read the presentation to check whether an edit was applied before sending it again.';
    return { success: false, error: `Slides API ${res.status}: ${detail}. ${remedy}` };
  } catch {
    // Never retry writes automatically: a lost response can follow a committed edit.
    return { success: false, error: 'The Slides request was interrupted or could not connect. Read the presentation to check its state before retrying edits.' };
  }
}

export const slidesActions: PluginAction[] = [
  action(Type.Object({ presentationId: id }), {
    id: 'slides.get_presentation', name: 'Get presentation', riskLevel: 'low',
    description: 'Read a Google Slides deck summary: title, revisionId, slide and element IDs. Then use slides.get_page for the slides you need. Does not load all slide text.',
    execute: ({ presentationId }, ctx) => request(ctx, `/${encodeURIComponent(presentationId)}?${new URLSearchParams({ fields: 'presentationId,title,revisionId,pageSize,slides(objectId,pageElements(objectId,title,description))' })}`),
  }),
  action(Type.Object({ presentationId: id, pageObjectId: pageId }), {
    id: 'slides.get_page', name: 'Read slide', riskLevel: 'low',
    description: 'Read one slide, including text, shapes, images, tables, styles and element IDs. Read only the pages needed for the requested edit.',
    execute: ({ presentationId, pageObjectId }, ctx) => request(ctx, `/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}`),
  }),
  action(Type.Object({ presentationId: id, pageObjectId: pageId }), {
    id: 'slides.get_thumbnail', name: 'Preview slide', riskLevel: 'low',
    description: 'Get a temporary image URL to visually verify a slide after editing. Treat the URL as private to this conversation.',
    execute: ({ presentationId, pageObjectId }, ctx) => request(ctx, `/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}/thumbnail`),
  }),
  action(Type.Object({ title: Type.String({ minLength: 1 }) }), {
    id: 'slides.create_presentation', name: 'Create presentation', riskLevel: 'medium',
    description: 'Create an empty Google Slides presentation. Use slides.batch_update to add slides and content.',
    execute: ({ title }, ctx) => request(ctx, '', { title }),
  }),
  action(Type.Object({ presentationId: id,
    requiredRevisionId: Type.String({ minLength: 1, description: 'revisionId from a fresh slides.get_presentation read. Rejects edits if another user changed the deck.' }),
    requests: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1, maxItems: 100, description: 'Google Slides API Request objects, each with one operation, such as replaceAllText, insertText, updateTextStyle, createSlide, createShape, updateSlidesPosition or deleteObject. Load google-slides skill for examples.' }),
  }), {
    id: 'slides.batch_update', name: 'Edit presentation', riskLevel: 'high',
    description: 'Apply up to 100 Google Slides API updates atomically, protected by the required revision. Supports text, formatting, images, shapes, tables, slide creation and deletion. Read current slide IDs first.',
    execute: ({ presentationId, requiredRevisionId, requests }, ctx) => request(ctx, `/${encodeURIComponent(presentationId)}:batchUpdate`, { requests, writeControl: { requiredRevisionId } }),
  }),
];
