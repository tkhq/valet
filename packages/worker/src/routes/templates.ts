import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import type {
  WorkflowTemplateListResponse,
  WorkflowTemplateSummary,
  InstallTemplateResponse,
} from '@valet/shared';
import { listWorkflowTemplates, installWorkflowTemplate } from '../services/workflow-templates.js';
import { getDisabledPluginServices } from '../lib/db/plugins.js';
import { integrationRegistry } from '../integrations/registry.js';

export const templatesRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/templates — the template gallery catalog.
// Templates are contributed by plugins and aggregated by the registry; a plugin
// disabled org-wide (org_plugins) drops its templates from the gallery.
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
      inputs: t.inputs,
      hasWebhook: Boolean(t.trigger),
    }));
  const body: WorkflowTemplateListResponse = { templates };
  return c.json(body);
});

// POST /api/templates/:id/install — install a template as a published workflow
// (plus its webhook trigger, if any). The webhook token is returned exactly once.
templatesRouter.post('/:id/install', async (c) => {
  const user = c.get('user');
  const { id } = c.req.param();
  const result = await installWorkflowTemplate(c.get('db'), c.env, user.id, id);

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
