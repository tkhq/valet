/**
 * `/api/actions` — run Valet actions from an external agent harness
 * (`docs/specs/2026-10-07-mcp-agent-tools-design.md`, "Tool broker").
 *
 *   GET  /api/actions?q=&service=&workspace=&limit=   search the catalog
 *   GET  /api/actions/:toolId?workspace=              describe one action
 *   POST /api/actions/:toolId/invoke                  run it
 *
 * The MCP `search_tools` / `describe_tool` / `call_tool` tools and the
 * `valet tools` CLI command call these routes. Every call runs through the
 * headless `ActionInvoker` with `external` set, so it resolves the policy
 * hierarchy exactly as the caller's own Valet agent does, uses the
 * workspace owner's credentials without returning them, and writes an
 * audit row. A `require_approval` action does not run: the response says
 * `approval_required` and names the next step.
 */
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { PluginAction } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import {
  buildActionInvoker,
  discoverServiceActions,
  externalActionMode,
  findAction,
  qualifiedActionId,
  type ActionInvocationContext,
  type ActionInvokerOpts,
} from "../plugins/action-invoker.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";
import type { ActionDescribeResponse, ActionInvokeResponse, ActionSearchResponse, ActionToolSummary } from "../wire/types.js";

export const actionsRouter = new Hono<AppEnv>();

const DISCOVERY_TIMEOUT_MS = 8_000;
const MAX_IDEMPOTENCY_KEY = 200;

function invokerOpts(c: Context<AppEnv>): ActionInvokerOpts {
  const { db, engineCredentials, actionPluginByService, plugins, encryptionKey, onePassword } = c.var.providers;
  return {
    db,
    credentials: engineCredentials,
    actionPluginByService,
    plugins,
    githubTokenDeps: { key: deriveSecretKey(encryptionKey) },
    onePassword,
  };
}

async function callerContext(c: Context<AppEnv>, workspace: string | undefined): Promise<ActionInvocationContext | undefined> {
  const requested = workspace ?? (c.var.principal.type === "team" ? c.var.principal.id : "user");
  const owner = await authorizedWorkspaceOwner(c, requested);
  if (!owner) return undefined;
  return { userId: c.var.user.id, orgId: c.var.user.orgId, owner, external: { client: c.var.authVia } };
}

/** Split `service.action` on the longest registered service prefix. */
function parseToolId(c: Context<AppEnv>, toolId: string): { service: string; action: string } | undefined {
  const services = [...c.var.providers.actionPluginByService.keys()].sort((a, b) => b.length - a.length);
  const service = services.find((s) => toolId.startsWith(`${s}.`));
  return service ? { service, action: toolId.slice(service.length + 1) } : undefined;
}

function toolSummary(service: string, action: PluginAction): ActionToolSummary {
  return { tool_id: qualifiedActionId(service, action), service, name: action.name, description: action.description, risk_level: action.riskLevel };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.())]);
}

actionsRouter.get("/", async (c) => {
  const ctx = await callerContext(c, c.req.query("workspace"));
  if (!ctx) return c.json({ error: "Workspace not found. Use \"user\" or a team id you belong to." }, 404);
  const opts = invokerOpts(c);
  const serviceFilter = c.req.query("service");
  const query = c.req.query("q")?.trim().toLowerCase();
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 100);
  const services = serviceFilter ? [serviceFilter] : [...opts.actionPluginByService.keys()];
  const listed = await Promise.all(services.map((service) =>
    withTimeout(discoverServiceActions(opts, ctx, service), DISCOVERY_TIMEOUT_MS, { service, unavailable: "Tool discovery timed out. Try again, or filter by service." })));

  const matches = (action: PluginAction, service: string) =>
    !query || [qualifiedActionId(service, action), action.name, action.description].some((text) => text.toLowerCase().includes(query));
  const tools = listed.flatMap((entry) => "actions" in entry ? entry.actions.filter((a) => matches(a, entry.service)).map((a) => toolSummary(entry.service, a)) : []);
  const unavailable = listed.flatMap((entry) => "unavailable" in entry ? [{ service: entry.service, reason: entry.unavailable }] : []);
  const body: ActionSearchResponse = { tools: tools.slice(0, limit), total: tools.length, ...(serviceFilter || unavailable.length > 0 ? { unavailable } : {}) };
  return c.json(body);
});

async function loadTool(c: Context<AppEnv>, ctx: ActionInvocationContext, toolId: string) {
  const parsed = parseToolId(c, toolId);
  if (!parsed) return { error: `Unknown tool "${toolId}". Use search_tools to find a tool_id.` };
  const opts = invokerOpts(c);
  const listed = await discoverServiceActions(opts, ctx, parsed.service);
  if ("unavailable" in listed) return { error: listed.unavailable };
  const action = findAction(listed.actions, parsed.service, parsed.action);
  if (!action) return { error: `Unknown tool "${toolId}". Use search_tools to find a tool_id.` };
  return { opts, service: parsed.service, action };
}

actionsRouter.get("/:toolId", async (c) => {
  const ctx = await callerContext(c, c.req.query("workspace"));
  if (!ctx) return c.json({ error: "Workspace not found. Use \"user\" or a team id you belong to." }, 404);
  const tool = await loadTool(c, ctx, c.req.param("toolId"));
  if ("error" in tool) return c.json({ error: tool.error }, 404);
  const policy = await externalActionMode(tool.opts, ctx, tool.service, tool.action);
  const body: ActionDescribeResponse = { ...toolSummary(tool.service, tool.action), parameters: tool.action.parameters, policy };
  return c.json(body);
});

actionsRouter.post("/:toolId/invoke", async (c) => {
  const body = await readOptionalJsonObject(c);
  if (!body) return c.json({ error: "Send a JSON object with params." }, 400);
  const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
  const params = body.params ?? {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) return c.json({ error: "Set params to a JSON object." }, 400);
  const key = body.idempotencyKey;
  if (key !== undefined && (typeof key !== "string" || key === "" || key.length > MAX_IDEMPOTENCY_KEY)) {
    return c.json({ error: `Set idempotencyKey to a string of 1-${MAX_IDEMPOTENCY_KEY} characters, or omit it.` }, 400);
  }
  const ctx = await callerContext(c, workspace);
  if (!ctx) return c.json({ error: "Workspace not found. Use \"user\" or a team id you belong to." }, 404);
  const tool = await loadTool(c, ctx, c.req.param("toolId"));
  if ("error" in tool) return c.json({ error: tool.error }, 404);

  // The dedup table is global, so the key is namespaced by caller and owner:
  // one person's key can never return another's stored result.
  const invocationId = `ext:${ctx.userId}:${ctx.owner.type}:${ctx.owner.id}:${typeof key === "string" ? key : randomUUID()}`;
  const invoke = buildActionInvoker(tool.opts);
  const result = await invoke({ service: tool.service, action: tool.action.id, params: params as Record<string, unknown>, invocationId }, ctx);
  const toolId = qualifiedActionId(tool.service, tool.action);
  if (result.ok) return c.json({ tool_id: toolId, status: "completed", result: result.result } satisfies ActionInvokeResponse);
  if ("requiresApproval" in result) {
    return c.json({
      tool_id: toolId,
      status: "approval_required",
      ...(result.riskLevel ? { risk_level: result.riskLevel } : {}),
      ...(result.approver ? { approver: result.approver } : {}),
      next_step: result.provenance === "shared_account"
        ? "This call would use another member's account, and that member must approve it. Ask Valet to do it with start_thread so the request reaches them."
        : "Policy requires a person to approve this action. Ask Valet to do it with start_thread, which raises an approval in Valet, or ask an admin to change the policy.",
    } satisfies ActionInvokeResponse);
  }
  return c.json({ tool_id: toolId, status: "failed", error: result.error } satisfies ActionInvokeResponse);
});
