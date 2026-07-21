import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Env, Variables } from '../env.js';
import type {
  WorkflowTemplateListResponse,
  WorkflowTemplateSummary,
  InstallTemplateResponse,
} from '@valet/shared';
import {
  listWorkflowTemplates,
  installWorkflowTemplate,
  templateRunInputs,
  enableTemplateGithubApp,
} from '../services/workflow-templates.js';
import { WorkflowVersionError } from '../services/workflow-versions.js';
import { getDisabledPluginServices } from '../lib/db/plugins.js';
import { integrationRegistry } from '../integrations/registry.js';

const installSchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
});

const enableAppSchema = z.object({
  workflowId: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export const templatesRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/templates
 * The template gallery catalog. Templates are contributed by plugins and
 * aggregated by the registry; a plugin disabled org-wide (org_plugins)
 * drops its templates from the gallery.
 */
templatesRouter.get('/', async (c) => {
  const disabled = await getDisabledPluginServices(c.env.DB);
  // A template belongs to a plugin via the services in its `apps` chain; hide it
  // when any of those services is disabled. `apps` also carries non-service tokens
  // like 'claude', so only compare against actually-registered services.
  const isHidden = (apps: string[]) =>
    apps.some((a) => integrationRegistry.isBuiltinService(a) && disabled.has(a));

  const templates: WorkflowTemplateSummary[] = listWorkflowTemplates()
    .filter((t) => !isHidden(t.apps))
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      icon: t.icon,
      apps: t.apps,
      steps: t.steps,
      inputs: templateRunInputs(t),
      hasWebhook: Boolean(t.trigger),
      repoScoped: Boolean(t.trigger?.repoScoped),
      ...(t.runForm ? { runForm: t.runForm } : {}),
    }));
  const body: WorkflowTemplateListResponse = { templates };
  return c.json(body);
});

/**
 * POST /api/templates/:id/install
 * Install a template as a published workflow (plus its webhook trigger, if
 * any). The webhook token is returned exactly once. A repo-scoped template
 * requires { owner, repo } in the body: its trigger is pinned to that
 * repository and only an installer with write access to it may install.
 */
templatesRouter.post('/:id/install', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  // The body is optional overall (templates without a repo-scoped trigger take
  // none), so parse leniently and let the service reject a missing pin.
  const raw = await c.req.json().catch(() => ({}));
  const parsed = installSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid install request', code: 'validation_error' }, 400);
  }
  const pin = parsed.data.owner && parsed.data.repo
    ? { owner: parsed.data.owner, repo: parsed.data.repo }
    : undefined;
  let result;
  try {
    result = await installWorkflowTemplate(c.get('db'), c.env, user.id, id, pin);
  } catch (err) {
    // publishDraft's env/model gate rejects a template whose model/provider
    // isn't configured here — a caller-fixable condition, not a server bug.
    // Mirrors the /api/workflows publish route's translation.
    if (err instanceof WorkflowVersionError) {
      if (err.code === 'publish_contention') {
        return c.json({ error: err.message, code: err.code }, 503, { 'Retry-After': '1' });
      }
      return c.json({ error: err.message, code: err.code, errors: err.errors }, 400);
    }
    throw err;
  }

  let trigger: InstallTemplateResponse['trigger'] = null;
  if (result.trigger) {
    const host = c.req.header('host') || 'localhost:8787';
    const protocol = c.req.url.startsWith('https') ? 'https' : 'http';
    trigger = {
      id: result.trigger.id,
      name: result.trigger.name,
      webhookUrl: `${protocol}://${host}/api/triggers/${result.trigger.id}/webhook`,
      webhookToken: result.trigger.webhookToken,
    };
  }

  const body: InstallTemplateResponse = {
    workflowId: result.workflowId,
    workflowName: result.workflowName,
    trigger,
  };
  return c.json(body, 201);
});

/**
 * POST /api/templates/:id/enable-app
 * Arm an installed template workflow for a repo via the org GitHub App — the
 * no-webhook-setup path. Creates a github-app trigger scoped to owner/repo.
 */
templatesRouter.post('/:id/enable-app', zValidator('json', enableAppSchema), async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const { workflowId, owner, repo } = c.req.valid('json');
  const result = await enableTemplateGithubApp(c.get('db'), c.env, user.id, id, workflowId, owner, repo);
  return c.json(result, 201);
});
