import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";
import type {
  CredentialProvider,
  RiskLevel,
  ToolAttachment,
  ToolContext,
  ToolDef,
  ToolResult,
} from "./types.js";

/**
 * Plugin catalog: indirection layer that exposes plugin actions to the LLM
 * through two engine-built-in tools — `list_tools` and `call_tool` — rather
 * than registering one Anthropic-visible tool per action.
 *
 * Why the indirection: Anthropic enforces a tool-name regex of
 * ^[a-zA-Z0-9_-]{1,128}$ (so dotted ids like `github.create_issue` are
 * rejected as tool names but fine as string args), and even with name
 * sanitization, dozens of plugins × dozens of actions blows the LLM's
 * tool-catalog budget. The agent uses list_tools to discover and
 * call_tool to invoke; only the actions in active use pay any prompt cost.
 *
 * This module owns the canonical engine-native plugin shape. It does NOT
 * accept the legacy @valet/sdk Zod-based ActionSource — plugins must emit
 * the engine-native shape (TypeBox parameters, ToolContext-derived
 * ActionContext, ToolAttachment-typed result attachments).
 */

// ── Plugin shapes ─────────────────────────────────────────────────

/**
 * One LLM-callable action exposed by a plugin. Parameters are TypeBox
 * schemas — pi-ai/Anthropic both consume JSON Schema directly, so no
 * conversion step is needed at runtime.
 */
export interface PluginAction<TParams extends TSchema = TSchema> {
  /** Fully-qualified id, e.g. "github.create_issue". Stays untouched as a tool_id arg. */
  id: string;
  /** Human-readable label, surfaced in approval gates and catalog listings. */
  name: string;
  description: string;
  riskLevel: RiskLevel;
  parameters: TParams;
  execute: (
    args: Static<TParams>,
    ctx: PluginActionContext,
  ) => Promise<PluginActionResult>;
}

/**
 * Context passed into a plugin action. Inherits everything from
 * `ToolContext` (userId, orgId, sessionId, threadId, sandbox, signal,
 * credentials, requestDecision, etc.) plus plugin-specific fields.
 */
export interface PluginActionContext extends ToolContext {
  /** The fully-qualified action id being invoked (mirrors PluginAction.id). */
  actionId: string;
  /** The plugin service this action belongs to (e.g. "github"). */
  service: string;
  /**
   * Caller-supplied summary string from the call_tool invocation. Used in
   * approval gate bodies and audit logs. Empty when the action is invoked
   * outside the catalog flow.
   */
  summary?: string;
}

export interface PluginActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Attachments to inject into the LLM's vision context or store via BlobStore. */
  attachments?: ToolAttachment[];
}

export type ApprovalMode = "allow" | "require_approval" | "deny";

/**
 * The unit of plugin registration. A plugin emits one ActionPlugin per
 * service it exposes; the engine assembles them into a catalog.
 */
export interface ActionPlugin {
  /** Service id (e.g. "github"). Used as the credential service name and as a routing key. */
  service: string;
  description?: string;
  actions: PluginAction[];
  /** Override credential service name (defaults to `service`). */
  credentialService?: string;
  /**
   * The plugin's actions are unusable without a connected credential.
   * When set and no credential resolves, `list_tools` HIDES this
   * service's tools from unfiltered listings (with a warning naming the
   * fix) — advertising tools that can only fail wastes the agent's turn.
   * An explicit `service:` filter still returns them, so the agent can
   * inspect schemas while asking the user to connect. Leave unset for
   * credential-less plugins (e.g. workflows), which are never probed.
   */
  requiresCredential?: boolean;
  /**
   * Default approval policy. Unset = derived from each action's riskLevel:
   * low/medium → allow; high/critical → require_approval.
   */
  defaultApprovalMode?: ApprovalMode;
  /**
   * Dynamic action discovery seam for MCP-proxy-style plugins whose action
   * list isn't known statically (e.g. depends on what an upstream MCP
   * server advertises for the connected credential). MUST be idempotent —
   * the catalog may call it repeatedly (subject to the TTL cache) — and MAY
   * throw; callers (list_tools/call_tool) turn a throw into a warning or
   * error string rather than propagating it to the LLM turn. Called with a
   * credential provider scoped to this plugin's `credentialService` (or
   * `service` when unset), matching the scoping `call_tool` gives to
   * `execute`.
   */
  resolveActions?: (ctx: { credentials: CredentialProvider }) => Promise<PluginAction[]>;
}

export interface PluginCatalogOptions {
  plugins: ActionPlugin[];
  /** Clock used for the dynamic-action-resolution TTL cache. Default: Date.now. */
  clock?: () => number;
}

/** TTL for the dynamic `resolveActions` cache, keyed per plugin service. */
export const RESOLVE_TTL_MS = 300_000;

/**
 * Applies TypeBox `Value.Default` to a cloned copy of `params`, then
 * validates the result against `schema`. Returns the defaulted+validated
 * args on success, or a compact error string (first 3 Value.Errors paths)
 * on failure. Used by `call_tool` to validate LLM-supplied params before
 * they reach a plugin action's `execute` body, and reused by Task 6's
 * ActionInvoker for the same purpose outside the catalog flow.
 */
export function prepareActionArgs(
  schema: TSchema,
  params: Record<string, unknown> | undefined,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  // Value.Default's return type is `unknown` by design (see typebox docs) —
  // callers are expected to Check before use, which we do immediately below.
  const withDefaults = Value.Default(schema, structuredClone(params ?? {})) as Record<
    string,
    unknown
  >;
  if (Value.Check(schema, withDefaults)) {
    return { ok: true, args: withDefaults };
  }
  const errors = [...Value.Errors(schema, withDefaults)].slice(0, 3);
  const detail = errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
  return { ok: false, error: detail || "params did not match the schema" };
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Build the [list_tools, call_tool] pair backed by an in-memory catalog
 * assembled from every ActionPlugin in `opts.plugins`.
 */
export function pluginCatalogTools(opts: PluginCatalogOptions): ToolDef[] {
  const now = opts.clock ?? Date.now;
  const catalog = buildCatalog(opts.plugins, now);
  return [makeListTool(catalog), makeCallTool(catalog)];
}

// ── Catalog ───────────────────────────────────────────────────────

interface CatalogEntry {
  service: string;
  plugin: ActionPlugin;
  action: PluginAction;
}

interface ResolvedDynamic {
  entries: CatalogEntry[];
  byId: Map<string, CatalogEntry>;
  fetchedAt: number;
}

interface Catalog {
  entries: CatalogEntry[];
  byId: Map<string, CatalogEntry>;
  /** Plugins with a `resolveActions` seam, resolved on demand (not eagerly at catalog build). */
  dynamicPlugins: ActionPlugin[];
  /** TTL cache of resolved dynamic actions, keyed by plugin service. */
  resolved: Map<string, ResolvedDynamic>;
  now: () => number;
}

function buildEntries(
  service: string,
  plugin: ActionPlugin,
  actions: PluginAction[],
): { entries: CatalogEntry[]; byId: Map<string, CatalogEntry> } {
  const entries: CatalogEntry[] = [];
  const byId = new Map<string, CatalogEntry>();
  for (const action of actions) {
    const entry: CatalogEntry = { service, plugin, action };
    entries.push(entry);
    const fqid = action.id.includes(".") ? action.id : `${service}.${action.id}`;
    byId.set(fqid, entry);
    // Allow a bare id lookup when unambiguous.
    if (action.id !== fqid && !byId.has(action.id)) byId.set(action.id, entry);
  }
  return { entries, byId };
}

function buildCatalog(plugins: ActionPlugin[], now: () => number): Catalog {
  const entries: CatalogEntry[] = [];
  const byId = new Map<string, CatalogEntry>();
  const dynamicPlugins: ActionPlugin[] = [];
  for (const plugin of plugins) {
    for (const action of plugin.actions) {
      const entry: CatalogEntry = { service: plugin.service, plugin, action };
      entries.push(entry);
      const fqid = action.id.includes(".") ? action.id : `${plugin.service}.${action.id}`;
      byId.set(fqid, entry);
      // Allow a bare id lookup when unambiguous.
      if (action.id !== fqid && !byId.has(action.id)) byId.set(action.id, entry);
    }
    if (plugin.resolveActions) dynamicPlugins.push(plugin);
  }
  return { entries, byId, dynamicPlugins, resolved: new Map(), now };
}

/**
 * Resolve (with TTL caching) the dynamic action set for one plugin.
 * Throws propagate to the caller — list_tools turns them into a warning,
 * call_tool turns them into an error-text tool result.
 */
async function resolveDynamic(
  catalog: Catalog,
  plugin: ActionPlugin,
  ctx: ToolContext,
): Promise<ResolvedDynamic> {
  const now = catalog.now();
  const cached = catalog.resolved.get(plugin.service);
  if (cached && now - cached.fetchedAt < RESOLVE_TTL_MS) {
    return cached;
  }
  // resolveActions is guaranteed present on every entry of dynamicPlugins.
  const resolveActions = plugin.resolveActions;
  if (!resolveActions) throw new Error(`plugin ${plugin.service} has no resolveActions`);
  const credentialService = plugin.credentialService ?? plugin.service;
  const actions = await resolveActions({
    credentials: scopedCredentialProvider(ctx, credentialService),
  });
  const built = buildEntries(plugin.service, plugin, actions);
  const result: ResolvedDynamic = { ...built, fetchedAt: now };
  catalog.resolved.set(plugin.service, result);
  return result;
}

// ── list_tools ───────────────────────────────────────────────────

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

function makeListTool(catalog: Catalog): ToolDef {
  return {
    name: "list_tools",
    description:
      "List available plugin tools. Filter by service or search by name/description. Returns tool_ids plus their parameter schemas; use call_tool to invoke one.",
    parameters: Type.Object({
      service: Type.Optional(
        Type.String({
          description:
            "Filter by service name (e.g. 'github', 'gmail'). Omit to list across all services.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: "Case-insensitive substring match against name, id, and description.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: LIST_LIMIT_MAX,
          description: `Cap results (default ${LIST_LIMIT_DEFAULT}, max ${LIST_LIMIT_MAX}).`,
        }),
      ),
    }),
    execute: async (args, ctx): Promise<ToolResult> => {
      const a = args as { service?: string; query?: string; limit?: number };
      const limit = clamp(a.limit ?? LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
      const q = a.query?.toLowerCase();

      const matchesQuery = (action: PluginAction): boolean =>
        !q ||
        action.id.toLowerCase().includes(q) ||
        action.name.toLowerCase().includes(q) ||
        action.description.toLowerCase().includes(q);

      let entries = catalog.entries;
      if (a.service) entries = entries.filter((e) => e.service === a.service);
      if (q) entries = entries.filter((e) => matchesQuery(e.action));

      const warnings: Array<{ service: string; reason: string }> = [];

      // Merge in dynamic (resolveActions-backed) plugins whose service
      // passes the filter. Discovery failures become warnings, not throws.
      const dynamicServicesConsidered = new Set<string>();
      for (const plugin of catalog.dynamicPlugins) {
        if (a.service && plugin.service !== a.service) continue;
        dynamicServicesConsidered.add(plugin.service);
        try {
          const resolvedDyn = await resolveDynamic(catalog, plugin, ctx);
          const dynEntries = q
            ? resolvedDyn.entries.filter((e) => matchesQuery(e.action))
            : resolvedDyn.entries;
          entries = entries.concat(dynEntries);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push({ service: plugin.service, reason: `action discovery failed: ${message}` });
        }
      }

      // Per-service auth handling — only services whose plugin declares
      // `requiresCredential` are probed (credential-less plugins like
      // workflows would otherwise produce "no credential connected"
      // noise). Unconnected services' tools are HIDDEN from unfiltered
      // listings: advertising tools that can only fail wastes the agent's
      // turn. An explicit `service:` filter still returns them alongside
      // the warning, so schemas stay inspectable.
      const services = new Set(entries.map((e) => e.service));
      for (const service of dynamicServicesConsidered) services.add(service);
      for (const service of services) {
        const plugin =
          catalog.entries.find((e) => e.service === service)?.plugin ??
          catalog.dynamicPlugins.find((p) => p.service === service);
        if (!plugin?.requiresCredential) continue;
        const credService = plugin.credentialService ?? service;
        let cred: Awaited<ReturnType<typeof ctx.credentials.get>>;
        let probeReason: string | undefined;
        try {
          cred = await ctx.credentials.get(credService);
        } catch (err) {
          // A resolver may throw instead of returning null (e.g. a
          // GitHubAuthError when the org has no installation). Treat that
          // the same as "no credential connected" so one throwing probe
          // can't abort discovery for every other service — but surface
          // the resolver's own message: it names the actual fix (e.g.
          // "App created but not installed — Install on GitHub").
          cred = null;
          probeReason = err instanceof Error ? err.message : String(err);
        }
        if (!cred) {
          if (a.service === service) {
            warnings.push({ service, reason: probeReason ?? "no credential connected" });
          } else {
            entries = entries.filter((e) => e.service !== service);
            warnings.push({
              service,
              reason: `not connected — tools hidden. ${
                probeReason ?? "Connect the integration in Settings, or list with service filter to inspect schemas."
              }`,
            });
          }
        }
      }

      const tools = entries.slice(0, limit).map((e) => ({
        service: e.service,
        tool_id: qualifiedId(e),
        name: e.action.name,
        description: e.action.description,
        riskLevel: e.action.riskLevel,
        params: e.action.parameters,
      }));

      const total = entries.length;
      return {
        text: JSON.stringify(
          {
            tools,
            total,
            truncated: total > limit ? total - limit : undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
          null,
          2,
        ),
      };
    },
  };
}

// ── call_tool ────────────────────────────────────────────────────

function makeCallTool(catalog: Catalog): ToolDef {
  return {
    name: "call_tool",
    description:
      "Invoke a plugin action by tool_id (discovered via list_tools). Approval gates may suspend execution for high/critical risk actions.",
    parameters: Type.Object({
      tool_id: Type.String({
        description: "Fully-qualified action id from list_tools (e.g. 'github.create_issue').",
      }),
      params: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description:
            "Action parameters, matching the schema reported by list_tools for this tool_id.",
        }),
      ),
      summary: Type.String({
        description:
          "One-line human-readable summary of what this call does. Shown in approval gates and audit logs.",
      }),
    }),
    execute: async (args, ctx): Promise<ToolResult> => {
      const a = args as {
        tool_id: string;
        params?: Record<string, unknown>;
        summary: string;
      };
      let entry = catalog.byId.get(a.tool_id);
      if (!entry) {
        const dotIdx = a.tool_id.indexOf(".");
        if (dotIdx > 0) {
          const prefix = a.tool_id.slice(0, dotIdx);
          const plugin = catalog.dynamicPlugins.find((p) => p.service === prefix);
          if (plugin) {
            try {
              const resolvedDyn = await resolveDynamic(catalog, plugin, ctx);
              entry = resolvedDyn.byId.get(a.tool_id);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return { text: `error resolving ${prefix} tools: ${message}` };
            }
          }
        }
      }
      if (!entry) {
        return {
          text: `unknown tool_id: "${a.tool_id}". Use list_tools to find available actions.`,
        };
      }

      const approvalMode = approvalModeFor(entry);
      if (approvalMode === "deny") {
        return { text: `denied: ${a.tool_id} is blocked by org policy` };
      }
      if (approvalMode === "require_approval") {
        const resolution = await ctx.requestDecision({
          type: "approval",
          title: `Approve ${entry.action.name}?`,
          body: `${a.summary}\n\ntool_id=${a.tool_id}\nargs=${stableJson(a.params ?? {})}`,
          resumeKey: `${qualifiedId(entry)}:${stableJson(a.params ?? {})}`,
          context: {
            riskLevel: entry.action.riskLevel,
            service: entry.service,
            tool_id: a.tool_id,
            args: a.params,
          },
        });
        if (resolution.actionId !== "approve") {
          return { text: `denied: user did not approve ${a.tool_id}` };
        }
      }

      // Validate (and apply schema defaults to) LLM-supplied params before
      // they reach the plugin action's execute body — closes the gap where
      // unvalidated params flowed straight into plugin code.
      const prepared = prepareActionArgs(entry.action.parameters, a.params);
      if (!prepared.ok) {
        return { text: `invalid params for ${a.tool_id}: ${prepared.error}` };
      }

      // Build the plugin action context. credentialService routing is
      // per-plugin; the action sees the same ToolContext shape plus
      // actionId/service/summary, with credentials defaulting to the
      // plugin's credentialService.
      const credentialService = entry.plugin.credentialService ?? entry.service;
      const actionCtx: PluginActionContext = {
        ...ctx,
        actionId: entry.action.id,
        service: entry.service,
        summary: a.summary,
        credentials: scopedCredentialProvider(ctx, credentialService),
      };

      let result: PluginActionResult;
      try {
        result = await entry.action.execute(
          prepared.args as Static<typeof entry.action.parameters>,
          actionCtx,
        );
      } catch (err) {
        return {
          text: `error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return actionResultToToolResult(result, a.tool_id);
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────

function approvalModeFor(entry: CatalogEntry): ApprovalMode {
  if (entry.plugin.defaultApprovalMode) return entry.plugin.defaultApprovalMode;
  switch (entry.action.riskLevel) {
    case "low":
    case "medium":
      return "allow";
    case "high":
    case "critical":
      return "require_approval";
  }
}

function qualifiedId(entry: CatalogEntry): string {
  return entry.action.id.includes(".") ? entry.action.id : `${entry.service}.${entry.action.id}`;
}

/**
 * Wrap the engine's CredentialProvider to default lookups to the
 * plugin's credential service. The plugin still gets a CredentialProvider
 * (so it can call .get() and .request() the same way), but a bare
 * `.get()` (or `.get(service)` for the same service) routes to the
 * plugin's `credentialService` setting rather than the bare
 * action.service.
 */
function scopedCredentialProvider(
  ctx: ToolContext,
  defaultService: string,
): ToolContext["credentials"] {
  return {
    get: (service?: string) => ctx.credentials.get(service ?? defaultService),
    request: (service: string, reason: string) => ctx.credentials.request(service, reason),
  };
}

function actionResultToToolResult(
  result: PluginActionResult,
  toolId: string,
): ToolResult {
  const attachments = result.attachments;
  if (!result.success) {
    return {
      text: `${toolId} failed: ${result.error ?? "unknown error"}`,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };
  }
  if (result.data === undefined) {
    return {
      text: `${toolId} ok`,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };
  }
  return {
    text: stableJson(result.data),
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
