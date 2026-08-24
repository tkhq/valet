/**
 * `slides.*` actions (Valet Design spec, §Google Slides Integration) —
 * the third Workspace action group beside drive.* / docs.* / sheets.*.
 * Same credential (`google_workspace`), same fetch transport
 * (slides-transport.ts). No new OAuth scopes: the existing `drive` scope
 * covers every Slides API method used here.
 */
import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import type { PluginAction, PluginActionContext, PluginActionResult } from '@valet/engine';
import {
  batchUpdateChunked,
  createPresentation,
  getPresentation,
  SlidesApiError,
  type BatchUpdateChunk,
} from './slides-transport.js';

function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction['riskLevel'];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

async function getAccessToken(ctx: PluginActionContext): Promise<string> {
  const cred = await ctx.credentials.get();
  const token = cred?.accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Missing Google Workspace access token. Connect Google Workspace in Settings.');
  }
  return token;
}

function handleSlidesError(err: unknown): PluginActionResult {
  if (err instanceof SlidesApiError) return { success: false, error: err.message };
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

const getPresentationAction = action(
  Type.Object({
    presentationId: Type.String({ description: 'Google Slides presentation ID' }),
  }),
)({
  id: 'slides.get_presentation',
  name: 'Get Presentation',
  description: 'Fetch a Google Slides presentation: slides, page elements, text, and revision id.',
  riskLevel: 'low',
  execute: async ({ presentationId }, ctx) => {
    try {
      const token = await getAccessToken(ctx);
      const data = await getPresentation(presentationId, token);
      return { success: true, data };
    } catch (err) {
      return handleSlidesError(err);
    }
  },
});

const createPresentationAction = action(
  Type.Object({
    title: Type.String({ description: 'Title for the new presentation' }),
  }),
)({
  id: 'slides.create_presentation',
  name: 'Create Presentation',
  description: 'Create a new empty Google Slides presentation in the connected Google Drive.',
  riskLevel: 'medium',
  execute: async ({ title }, ctx) => {
    try {
      const token = await getAccessToken(ctx);
      const data = await createPresentation(title, token);
      return {
        success: true,
        data: {
          presentationId: data.presentationId,
          url: `https://docs.google.com/presentation/d/${data.presentationId}/edit`,
          revisionId: data.revisionId,
        },
      };
    } catch (err) {
      return handleSlidesError(err);
    }
  },
});

const batchUpdateAction = action(
  Type.Object({
    presentationId: Type.String({ description: 'Google Slides presentation ID' }),
    chunks: Type.Array(
      Type.Object({
        requests: Type.Array(Type.Unknown(), {
          description: 'Slides API batchUpdate requests for one slide.',
        }),
      }),
      { description: 'Request chunks, applied in order with revision fencing between chunks.' },
    ),
    requiredRevisionId: Type.Optional(
      Type.String({
        description:
          "The presentation revision the first chunk must apply against. A concurrent edit rejects the write instead of interleaving.",
      }),
    ),
    startAt: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: 'Resume index from a previous partial failure (the returned `applied` value).',
      }),
    ),
  }),
)({
  id: 'slides.batch_update',
  name: 'Batch Update Presentation',
  description:
    'Apply mutations to a presentation, chunked with per-chunk revision fencing. On partial failure the result names the resume index.',
  riskLevel: 'high',
  execute: async ({ presentationId, chunks, requiredRevisionId, startAt }, ctx) => {
    try {
      const token = await getAccessToken(ctx);
      const result = await batchUpdateChunked(presentationId, chunks as BatchUpdateChunk[], token, {
        ...(startAt !== undefined ? { startAt } : {}),
        ...(requiredRevisionId ? { initialRevisionId: requiredRevisionId } : {}),
      });
      if (result.error) {
        return {
          success: false,
          error: `${result.error}. Retry with startAt=${result.applied} to resume.`,
          data: result,
        };
      }
      return { success: true, data: result };
    } catch (err) {
      return handleSlidesError(err);
    }
  },
});

export const slidesActions: PluginAction[] = [
  getPresentationAction,
  createPresentationAction,
  batchUpdateAction,
];
