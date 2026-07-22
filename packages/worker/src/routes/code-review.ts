import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Env, Variables } from '../env.js';
import { WorkflowVersionError } from '../services/workflow-versions.js';
import { enableCodeReview } from '../services/code-review.js';

const enableSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export const codeReviewRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /api/code-review/enable
 * Enable Claude PR reviews on a repository via the org GitHub App. Installs the
 * review workflow and a github-app trigger scoped to owner/repo. Idempotent per
 * (user, repo). Requires the caller to have write access to the repo.
 */
codeReviewRouter.post('/enable', zValidator('json', enableSchema), async (c) => {
  const user = c.get('user');
  const { owner, repo } = c.req.valid('json');
  try {
    const result = await enableCodeReview(c.get('db'), c.env, user.id, owner, repo);
    return c.json(result, 201);
  } catch (err) {
    // publishDraft's env/model gate rejects when the review model/provider isn't
    // configured here — a caller-fixable condition, not a server bug. Mirrors the
    // /api/workflows publish route's translation.
    if (err instanceof WorkflowVersionError) {
      if (err.code === 'publish_contention') {
        return c.json({ error: err.message, code: err.code }, 503, { 'Retry-After': '1' });
      }
      return c.json({ error: err.message, code: err.code, errors: err.errors }, 400);
    }
    throw err;
  }
});
