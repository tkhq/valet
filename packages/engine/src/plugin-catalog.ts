import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";
import type {
  CredentialProvider,
  DecisionAction,
  DecisionResolution,
  PolicyDecision,
  PolicyInvocationRecord,
  PolicyResolveInput,
  PolicyResolver,
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
 * Opaque catalog handle shared by the call_tool tool path and the
 * slash-command path. Build it once with {@link buildPluginCatalog}, then
 * pass it to {@link pluginCatalogTools} (LLM tool path) and/or hold it for
 * {@link invokeAction} (slash-command path). Its internals — the id index and
 * the dynamic-resolution TTL cache — stay private to this module.
 */
export type PluginCatalog = Catalog;

/**
 * Assemble an in-memory catalog from every ActionPlugin in `plugins`.
 * Both the LLM `call_tool` path and the slash-command path route through
 * the SAME catalog so approval policy and arg validation stay identical.
 */
export function buildPluginCatalog(
  plugins: ActionPlugin[],
  clock?: () => number,
): PluginCatalog {
  return buildCatalog(plugins, clock ?? Date.now);
}

/**
 * Build the [list_tools, call_tool] pair backed by an in-memory catalog
 * assembled from every ActionPlugin in `opts.plugins`.
 */
export function pluginCatalogTools(opts: PluginCatalogOptions): ToolDef[] {
  const now = opts.clock ?? Date.now;
  const catalog = buildCatalog(opts.plugins, now);
  return [makeListTool(catalog), makeCallTool(catalog)];
}

/**
 * Outcome of {@link invokeAction}. The tool path and the slash-command path
 * both consume this and render it into their own transport shape
 * (`ToolResult` text vs. a `command_result` markdown output).
 */
export type InvokeActionResult =
  | { kind: "ok"; result: PluginActionResult }
  | { kind: "unknown"; toolId: string }
  | { kind: "invalid-args"; error: string }
  | { kind: "denied-policy" }
  | { kind: "denied-approval"; reason?: "approval-processing-failed" }
  | { kind: "pending-approval" }
  | { kind: "missing-credential"; service: string }
  | { kind: "error"; message: string }
  | { kind: "resolve-failed"; service: string; message: string };

/**
 * The executable core shared by `call_tool` and the slash-command path:
 * look up the action, apply approval policy (deny / require_approval via
 * `ctx.requestDecision`), validate + default the args, then run the
 * action's `execute`. Never duplicated — the call_tool tool wraps this and
 * renders `InvokeActionResult` into a `ToolResult`, and the command path
 * renders it into a `command_result` entry.
 *
 * `args` are the caller-supplied parameters (already mapped from CLI args on
 * the command path, or the LLM-supplied `params` on the tool path).
 * `summary` is the approval-gate body line.
 */
export async function invokeAction(
  catalog: PluginCatalog,
  actionId: string,
  args: Record<string, unknown> | undefined,
  ctx: ToolContext,
  summary: string,
): Promise<InvokeActionResult> {
  let entry = catalog.byId.get(actionId);
  if (!entry) {
    const dotIdx = actionId.indexOf(".");
    if (dotIdx > 0) {
      const prefix = actionId.slice(0, dotIdx);
      const plugin = catalog.dynamicPlugins.find((p) => p.service === prefix);
      if (plugin) {
        try {
          const resolvedDyn = await resolveDynamic(catalog, plugin, ctx);
          entry = resolvedDyn.byId.get(actionId);
        } catch (err) {
          return {
            kind: "resolve-failed",
            service: prefix,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
  }
  if (!entry) return { kind: "unknown", toolId: actionId };

  const resolver = ctx.policyResolver;
  // Deterministic per-(tool_id, args) key — identical to the resumeKey handed
  // to ctx.requestDecision when a gate opens for this call. Recorded on every
  // audit record (even allow/deny, which never open a gate) so a host sink
  // can correlate all records for one (tool, args) pair.
  const resumeKey = `${qualifiedId(entry)}:${stableJson(args ?? {})}`;

  // ── Decision phase ────────────────────────────────────────────
  // Absent resolver: byte-identical to pre-policy behavior — derive the
  // approval mode from riskLevel and open the engine's default gate. No
  // policy machinery runs and no audit records are emitted.
  if (!resolver) {
    const approvalMode = approvalModeFor(entry);
    if (approvalMode === "deny") return { kind: "denied-policy" };
    if (approvalMode === "require_approval") {
      const resolution = await ctx.requestDecision({
        type: "approval",
        title: `Approve ${entry.action.name}?`,
        body: `${summary}\n\ntool_id=${actionId}\nargs=${stableJson(args ?? {})}`,
        resumeKey,
        context: {
          riskLevel: entry.action.riskLevel,
          service: entry.service,
          tool_id: actionId,
          args,
        },
      });
      // No resolution / an explicit "pending" action means the gate has not
      // yet been decided — distinct from an outright deny.
      if (resolution.actionId === "pending") return { kind: "pending-approval" };
      if (resolution.actionId !== "approve") return { kind: "denied-approval" };
    }
    return executeAction(entry, actionId, args, summary, ctx);
  }

  // Present resolver: consult the host policy port. The policy-facing
  // actionId is ALWAYS the fully-qualified `service.action` id (the same
  // fqid convention list_tools reports and the workflow path resolves) —
  // never the plugin's raw `PluginAction.id`, which may be bare. One
  // canonical form means one actionId an admin can target that matches both
  // the session and workflow paths.
  const policyActionId = qualifiedId(entry);
  const input: PolicyResolveInput = {
    service: entry.service,
    actionId: policyActionId,
    riskLevel: entry.action.riskLevel,
    params: args,
    userId: ctx.userId,
    orgId: ctx.orgId,
    sessionId: ctx.sessionId,
    threadId: ctx.threadId,
    appliesIn: "session",
  };
  const baseRecord: BaseInvocationRecord = {
    service: entry.service,
    actionId: policyActionId,
    toolId: actionId,
    riskLevel: entry.action.riskLevel,
    sessionId: ctx.sessionId,
    threadId: ctx.threadId,
    userId: ctx.userId,
    orgId: ctx.orgId,
    appliesIn: "session",
    summary,
    resumeKey,
    queueItemId: ctx.queueItemId,
    params: args,
  };

  let decision: PolicyDecision;
  try {
    decision = await resolver.resolve(input);
  } catch {
    // Fail closed but keep a human in the loop — degrade to an approval
    // gate rather than hard-deny on a transient resolver/store error.
    decision = {
      mode: "require_approval",
      provenance: { baseMode: "require_approval", source: "resolver_error" },
    };
  }

  if (decision.mode === "deny") {
    emitInvocation(resolver, {
      ...baseRecord,
      status: "denied",
      resolvedMode: "deny",
      provenance: decision.provenance,
    });
    return { kind: "denied-policy" };
  }

  // Populated only when a gate actually opens below (require_approval), so
  // the terminal audit record can carry it — absent for allow/deny.
  let gateOrdinal: number | undefined;

  if (decision.mode === "require_approval") {
    // Reject reserved ids up front: "approve"/"deny" are the engine's own
    // default gate actions (added below), so a host extra reusing one would
    // silently collide with — or shadow — the built-in approve/deny
    // semantics. A host-config bug must NOT crash the tool/command path —
    // return a controlled error outcome (fails closed: the action never
    // runs, no gate opens) instead of throwing through execute().
    for (const extra of decision.extraGateActions ?? []) {
      if (extra.id === "approve" || extra.id === "deny") {
        return {
          kind: "error",
          message:
            `policy misconfiguration: PolicyDecision.extraGateActions id "${extra.id}" is reserved ` +
            `for the engine's built-in approve/deny actions and cannot be reused by a host action`,
        };
      }
    }
    // Strip `approves` before the gate — the gate only understands
    // DecisionActions; the approval semantics stay engine-side.
    const extras: DecisionAction[] = (decision.extraGateActions ?? []).map(
      ({ approves: _approves, ...rest }) => rest,
    );
    const resolution = await ctx.requestDecision({
      type: "approval",
      title: `Approve ${entry.action.name}?`,
      body: `${summary}\n\ntool_id=${actionId}\nargs=${stableJson(args ?? {})}`,
      resumeKey,
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
        ...extras,
      ],
      context: {
        riskLevel: entry.action.riskLevel,
        service: entry.service,
        tool_id: actionId,
        args,
        provenance: decision.provenance,
      },
    });
    // An undecided gate (command path): no resolution happened, so no
    // onResolution side effects run and no audit record is emitted here —
    // the re-driven invocation after the gate resolves emits the terminal
    // record.
    if (resolution.actionId === "pending") return { kind: "pending-approval" };
    gateOrdinal = resolution.gateOrdinal;
    // onResolution is awaited BEFORE the outcome is interpreted; a throw
    // fails the approval closed (treated as not-approved).
    let onResolutionThrew = false;
    if (resolver.onResolution) {
      try {
        await resolver.onResolution(input, decision, resolution);
      } catch {
        onResolutionThrew = true;
      }
    }
    const approved =
      !onResolutionThrew && isApprovedResolution(resolution, decision.extraGateActions);
    if (!approved) {
      emitInvocation(resolver, {
        ...baseRecord,
        status: "rejected",
        resolvedMode: "require_approval",
        provenance: decision.provenance,
        gateOrdinal,
      });
      return onResolutionThrew
        ? { kind: "denied-approval", reason: "approval-processing-failed" }
        : { kind: "denied-approval" };
    }
  }

  // allow, or an approved require_approval → execute with audit.
  return executeAction(entry, actionId, args, summary, ctx, {
    resolver,
    record: {
      ...baseRecord,
      resolvedMode: decision.mode,
      provenance: decision.provenance,
      gateOrdinal,
    },
  });

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
      const outcome = await invokeAction(catalog, a.tool_id, a.params, ctx, a.summary);
      switch (outcome.kind) {
        case "ok":
          return actionResultToToolResult(outcome.result, a.tool_id);
        case "unknown":
          return {
            text: `unknown tool_id: "${a.tool_id}". Use list_tools to find available actions.`,
          };
        case "resolve-failed":
          return { text: `error resolving ${outcome.service} tools: ${outcome.message}` };
        case "denied-policy":
          return { text: `denied: ${a.tool_id} is blocked by org policy` };
        // The LLM tool path has no distinct "pending" state — requestDecision
        // blocks until the gate resolves — so both approval outcomes collapse
        // to the same "did not approve" text.
        case "denied-approval":
          return {
            text:
              outcome.reason === "approval-processing-failed"
                ? `denied: approval processing failed, so ${a.tool_id} did not approve`
                : `denied: user did not approve ${a.tool_id}`,
          };
        case "pending-approval":
          return { text: `denied: user did not approve ${a.tool_id}` };
        case "invalid-args":
          return { text: `invalid params for ${a.tool_id}: ${outcome.error}` };
        case "missing-credential":
          return {
            text: `${a.tool_id} failed: credential ${outcome.service} not connected`,
          };
        case "error":
          return { text: `error: ${outcome.message}` };
      }
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────

/** The invocation-record fields known before an audit status is decided. */
type BaseInvocationRecord = Omit<
  PolicyInvocationRecord,
  "status" | "resolvedMode" | "provenance" | "durationMs" | "error"
>;

/**
 * Validate params, build the action context, run the plugin action, and map
 * the result. When `audit` is supplied (present-resolver path), emit exactly
 * one fire-and-forget `onInvocation` record for the terminal disposition
 * (`error` for a param-validation failure or a thrown execute, `completed`
 * otherwise). Absent-resolver callers pass no `audit` and emit nothing.
 */
async function executeAction(
  entry: CatalogEntry,
  actionId: string,
  args: Record<string, unknown> | undefined,
  summary: string,
  ctx: ToolContext,
  audit?: { resolver: PolicyResolver; record: BaseAuditedRecord },
): Promise<InvokeActionResult> {
  // Validate (and apply schema defaults to) LLM-supplied params before they
  // reach the plugin action's execute body — closes the gap where unvalidated
  // params flowed straight into plugin code.
  const prepared = prepareActionArgs(entry.action.parameters, args);
  if (!prepared.ok) {
    if (audit) {
      emitInvocation(audit.resolver, {
        ...audit.record,
        status: "error",
        error: `invalid params: ${prepared.error}`,
      });
    }
    return { kind: "invalid-args", error: prepared.error };
  }

  // Build the plugin action context. credentialService routing is per-plugin;
  // the action sees the same ToolContext shape plus actionId/service/summary,
  // with credentials defaulting to the plugin's credentialService.
  const credentialService = entry.plugin.credentialService ?? entry.service;
  const actionCtx: PluginActionContext = {
    ...ctx,
    actionId: entry.action.id,
    service: entry.service,
    summary,
    credentials: scopedCredentialProvider(ctx, credentialService),
  };

  const startedAt = Date.now();
  try {
    const result = await entry.action.execute(
      prepared.args as Static<typeof entry.action.parameters>,
      actionCtx,
    );
    if (audit) {
      emitInvocation(audit.resolver, {
        ...audit.record,
        status: "completed",
        durationMs: Date.now() - startedAt,
        result,
      });
    }
    return { kind: "ok", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (audit) {
      emitInvocation(audit.resolver, {
        ...audit.record,
        status: "error",
        durationMs: Date.now() - startedAt,
        error: message,
      });
    }
    // A plugin action that needs a credential calls `credentials.request`,
    // which throws "credential <service> not connected: <reason>" (store
    // present, no cred) or "credential <service> not available (no store)"
    // (no store at all). Both mean the same thing to the user — surface a
    // missing-credential outcome so callers can name the corrective action.
    if (/credential .* not (connected|available)/.test(message)) {
      return { kind: "missing-credential", service: credentialService };
    }
    return { kind: "error", message };
  }
}

/** Base record plus the resolved mode + provenance carried into execution. */
type BaseAuditedRecord = BaseInvocationRecord &
  Pick<PolicyInvocationRecord, "resolvedMode" | "provenance">;

/** Approved iff the human chose `approve` or a host `approves: true` action. */
function isApprovedResolution(
  resolution: DecisionResolution,
  extraGateActions: PolicyDecision["extraGateActions"],
): boolean {
  if (resolution.actionId === "approve") return true;
  return !!extraGateActions?.some((x) => x.approves && x.id === resolution.actionId);
}

/**
 * Emit an audit record fire-and-forget. `onInvocation` must never throw into
 * the tool path — a rejected promise is swallowed here.
 */
function emitInvocation(resolver: PolicyResolver, record: PolicyInvocationRecord): void {
  if (!resolver.onInvocation) return;
  try {
    void Promise.resolve(resolver.onInvocation(record)).catch(() => {});
  } catch {
    // A sink that throws synchronously must not break the tool path either.
  }
}

/**
 * The approval rule, as a pure function of the two inputs that decide it.
 *
 * Exported because the connect UI states — before a user connects — how many
 * of a service's tools stop and ask them first. That claim has to be the same
 * rule the gate below actually applies, so it is resolved through this
 * function rather than re-derived from `riskLevel` at the wire or in the
 * client. A plugin that pins `defaultApprovalMode` overrides risk entirely,
 * and a caller that forgot that would advertise a gate that never fires.
 */
export function approvalModeForAction(
  riskLevel: RiskLevel,
  defaultApprovalMode?: ApprovalMode,
): ApprovalMode {
  if (defaultApprovalMode) return defaultApprovalMode;
  switch (riskLevel) {
    case "low":
    case "medium":
      return "allow";
    case "high":
    case "critical":
      return "require_approval";
  }
}

function approvalModeFor(entry: CatalogEntry): ApprovalMode {
  return approvalModeForAction(entry.action.riskLevel, entry.plugin.defaultApprovalMode);
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
