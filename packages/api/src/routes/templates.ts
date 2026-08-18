/**
 * `/api/templates` — the workflow gallery's read surface and its install
 * action. HTTP plumbing only; every decision lives in
 * `../workflows/templates.ts`, so the agent-facing surface can reuse the
 * same install path without a second implementation.
 *
 * Owner-scoped exactly like `routes/workflows.ts`: the listing stamps each
 * template with the CALLER's own connection state, and an install produces
 * a workflow owned by the caller (or by a team the caller belongs to).
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  installWorkflowTemplate,
  listWorkflowTemplateSummaries,
  type TemplateServiceDeps,
} from "../workflows/templates.js";
import type { WorkflowOwner } from "../workflows/service.js";
import type { Providers } from "../providers/types.js";
import type {
  InstallWorkflowTemplateRequest,
  InstallWorkflowTemplateResponse,
  ListWorkflowTemplatesResponse,
} from "../wire/types.js";

export const templatesRouter = new Hono<AppEnv>();

/** The engine credential store IS the template service's `credentials` —
 * the same read `/api/plugins` uses, so both surfaces agree on what the
 * caller has connected. */
function templateDeps(providers: Providers): TemplateServiceDeps {
  return {
    db: providers.db,
    plugins: providers.plugins,
    actionPluginByService: providers.actionPluginByService,
    credentials: providers.engineCredentials,
  };
}

function callerOwner(user: { id: string; orgId: string }): WorkflowOwner {
  return { userId: user.id, orgId: user.orgId };
}

templatesRouter.get("/", async (c) => {
  const resp: ListWorkflowTemplatesResponse = {
    templates: await listWorkflowTemplateSummaries(templateDeps(c.var.providers), {
      userId: c.var.user.id,
      orgId: c.var.user.orgId,
    }),
  };
  return c.json(resp);
});

templatesRouter.post("/:id/install", async (c) => {
  const deps = templateDeps(c.var.providers);
  const owner = callerOwner(c.var.user);

  // The body is optional — a template with no inputs installs from a POST
  // with no payload, which is what the gallery's one-click path sends.
  let body: InstallWorkflowTemplateRequest = {};
  const raw = await c.req.text();
  if (raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return c.json({ error: "the request body must be a JSON object" }, 400);
    }
    // `InstallWorkflowTemplateRequest` is not runtime-validated (the same
    // convention `routes/workflows.ts` follows), so each field is narrowed
    // where it is read, below.
    body = parsed;
  }

  const inputs = body.inputs;
  if (inputs !== undefined && (typeof inputs !== "object" || inputs === null || Array.isArray(inputs))) {
    return c.json({ error: "inputs must be a JSON object of field names to values" }, 400);
  }

  const result = await installWorkflowTemplate(deps, owner, c.req.param("id"), {
    inputs,
    teamId: typeof body.teamId === "string" ? body.teamId : undefined,
  });

  if (result.ok) {
    const resp: InstallWorkflowTemplateResponse = {
      workflowId: result.workflowId,
      workflowName: result.workflowName,
      ...(result.scheduleId !== undefined ? { scheduleId: result.scheduleId } : {}),
    };
    return c.json(resp, 201);
  }

  switch (result.code) {
    // Same "cross-owner access is not found, never forbidden" convention
    // the rest of the workflow routes follow — a team the caller cannot
    // reach looks identical to a team that does not exist.
    case "not_found":
    case "team_not_found":
      return c.json({ error: result.error }, 404);
    // A shipped template that does not validate is our bug, not the
    // caller's, so it is a server error with the validator's own findings.
    case "broken_template":
      return c.json({ error: result.error, errors: result.errors }, 500);
    case "invalid_input":
      return c.json({ error: result.error, errors: result.errors }, 400);
    default:
      return c.json({ error: result.error }, 400);
  }
});
