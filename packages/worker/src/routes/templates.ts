import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import type {
  WorkflowTemplateListResponse,
  WorkflowTemplateSummary,
  InstallTemplateResponse,
} from '@valet/shared';
import { listWorkflowTemplates, installWorkflowTemplate } from '../services/workflow-templates.js';

export const templatesRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/templates — the template gallery catalog.
templatesRouter.get('/', (c) => {
  const templates: WorkflowTemplateSummary[] = listWorkflowTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    icon: t.icon,
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
