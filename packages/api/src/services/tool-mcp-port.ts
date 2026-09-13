import { randomUUID } from "node:crypto";
import {
  buildPluginCatalog,
  fromRequest,
  invokeAction,
  searchCatalog,
  type DecisionResolution,
  type McpToolPort,
  type McpToolResult,
  type PolicyInvocationRecord,
  type SessionEntry,
  type SessionStore,
  type ToolContext,
} from "@valet/engine";
import type { EngineHost } from "../engine/host.js";
import { userPrincipal } from "../lib/request-principal.js";
import type { AppDb } from "../lib/drizzle.js";
import { canViewAssistantOwner, assistantOwner } from "../assistants/access.js";
import { loadAssistant } from "../assistants/service.js";
import { persistInvocationAuditStrict } from "../policies/service.js";
import { isOrgMember } from "./org.js";
import {
  InvocationBindingMismatchError,
  McpInvocationStore,
  invocationEnvelope,
} from "./tool-invocations.js";

const ORCHESTRATOR_UNAVAILABLE =
  "This orchestrator is unavailable. Select an orchestrator you can access and try again.";
const RESERVED_ACTIONS = new Set(["whoami", "list_sessions", "list_tools", "call_tool", "list_skills", "skill"]);

class ExecutionClaimLostError extends Error {}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Provide a non-empty ${key} value and try again.`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Provide a non-empty ${key} value or omit it.`);
  return value.trim();
}

function recordArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Provide ${key} as a JSON object and try again.`);
  return value as Record<string, unknown>;
}

function isReservedAction(actionId: string): boolean {
  const name = actionId.includes(".") ? actionId.slice(actionId.lastIndexOf(".") + 1) : actionId;
  return RESERVED_ACTIONS.has(actionId) || RESERVED_ACTIONS.has(name) || name.startsWith("thread_") || name.startsWith("mem_") || actionId.startsWith("mcp.");
}

function json(result: unknown): McpToolResult {
  return { text: JSON.stringify(result) };
}

export class ToolMcpPort implements McpToolPort {
  private readonly invocations: McpInvocationStore;

  constructor(
    private readonly db: AppDb,
    private readonly engineStore: SessionStore,
    private readonly engineHost: EngineHost,
    private readonly userId: string,
    private readonly sourceIp: string,
  ) {
    this.invocations = new McpInvocationStore(db);
  }

  async call(operation: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (operation === "list_tools") return this.listTools(args);
    if (operation === "call_tool") return this.callTool(args);
    throw new Error("This tool operation is unavailable. Call list_tools or call_tool.");
  }

  private async assistant(args: Record<string, unknown>) {
    const orchestratorId = requiredString(args, "orchestratorId");
    const assistant = orchestratorId.startsWith("asst_") ? await loadAssistant(this.db, orchestratorId) : undefined;
    if (!assistant || assistant.archivedAt !== null || !(await isOrgMember(this.db, assistant.orgId, this.userId)) ||
      !(await canViewAssistantOwner(this.db, assistantOwner(assistant), userPrincipal(this.userId)))) {
      throw new Error(ORCHESTRATOR_UNAVAILABLE);
    }
    const threadId = optionalString(args, "threadId");
    if (threadId) {
      const threads = await this.engineStore.listThreads(assistant.sessionId);
      if (!threads.some((thread) => thread.id === threadId)) throw new Error(ORCHESTRATOR_UNAVAILABLE);
    }
    return { assistant, orchestratorId, threadId };
  }

  private async runtime(args: Record<string, unknown>) {
    const selected = await this.assistant(args);
    try {
      const plugins = await this.engineHost.actionPluginsForAssistant(selected.assistant);
      const catalog = buildPluginCatalog(plugins);
      const session = await this.engineHost.assistantSessionFor(
        selected.assistant.id,
        { actorUserId: this.userId, orgId: selected.assistant.orgId },
        { sessionId: selected.assistant.sessionId },
      );
      const threads = await this.engineStore.listThreads(selected.assistant.sessionId);
      const oldestThread = threads.slice().sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
      const effectiveThreadId = selected.threadId ?? oldestThread?.id;
      return { ...selected, catalog, session, effectiveThreadId };
    } catch {
      throw new Error("This orchestrator's governed tool catalog is temporarily unavailable. Retry later.");
    }
  }

  private context(runtime: Awaited<ReturnType<ToolMcpPort["runtime"]>>, requestDecision?: ToolContext["requestDecision"], policyResolver?: ToolContext["policyResolver"]): ToolContext {
    const { session, assistant, effectiveThreadId } = runtime;
    return {
      userId: this.userId,
      orgId: assistant.orgId,
      sessionId: assistant.sessionId,
      threadId: effectiveThreadId ?? `mcp:${assistant.id}`,
      sessionPurpose: "orchestrator",
      cwd: session.options.workspace,
      credentials: session.credentialProvider(),
      sandbox: session.sandbox,
      config: session.options.toolConfig,
      owner: session.owner,
      policyResolver: policyResolver ?? session.options.policyResolver,
      pluginStoreFactory: session.options.pluginStoreFactory,
      resolveOutboundSender: session.options.resolveOutboundSender,
      signal: new AbortController().signal,
      requestDecision: requestDecision ?? (async () => ({ actionId: "pending", resolvedBy: "system", resolvedAt: Date.now() })),
      threadRead: (key, options) => session.readEntries(key, options),
      listThreads: async () => (await session.providers.store.listThreads(session.id)).map((thread) => ({
        id: thread.id, key: thread.key, status: thread.status, model: thread.model,
        summary: thread.summary, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      })),
      setModel: async () => { throw new Error("Model changes are unavailable through call_tool. Change the orchestrator settings instead."); },
    };
  }

  private async listTools(args: Record<string, unknown>): Promise<McpToolResult> {
    const runtime = await this.runtime(args);
    const limit = args.limit;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit))) throw new Error("Provide limit as an integer and try again.");
    return json(await searchCatalog(runtime.catalog, {
      service: optionalString(args, "service"),
      query: optionalString(args, "query"),
      actionId: optionalString(args, "actionId"),
      limit: typeof limit === "number" ? limit : undefined,
    }, this.context(runtime)));
  }

  private async callTool(args: Record<string, unknown>): Promise<McpToolResult> {
    const selected = await this.assistant(args);
    const clientInvocationId = requiredString(args, "invocationId");
    const actionId = requiredString(args, "actionId");
    const actionArgs = recordArg(args, "params");
    const summary = requiredString(args, "summary");
    let opened;
    try {
      opened = await this.invocations.open({
        userId: this.userId, orgId: selected.assistant.orgId, clientInvocationId,
        orchestratorId: selected.orchestratorId, sessionId: selected.assistant.sessionId,
        threadId: selected.threadId, actionId, args: actionArgs, sourceIp: this.sourceIp,
      });
    } catch (error) {
      if (!(error instanceof InvocationBindingMismatchError)) throw error;
      await persistInvocationAuditStrict(this.db, {
        invocationId: `mcp:reject:${randomUUID()}`, service: "mcp", actionId: "call_tool",
        status: "rejected", userId: this.userId, orgId: selected.assistant.orgId, sourceIp: this.sourceIp,
        params: { invocationId: clientInvocationId, orchestratorId: selected.orchestratorId, actionId },
        error: error.message,
      });
      throw error;
    }
    if (["executing", "completed", "denied", "failed", "indeterminate"].includes(opened.status ?? "")) {
      return json(invocationEnvelope(opened));
    }

    if (isReservedAction(actionId)) {
      const failed = await this.invocations.markTerminal(opened.invocationId, ["created", "pending_approval"], {
        state: "failed",
        error: "This action is reserved and cannot be invoked through call_tool.",
      });
      return json(invocationEnvelope(failed));
    }

    let executionClaimed = false;
    let audit: PolicyInvocationRecord | undefined;
    try {
      const runtime = await this.runtime(args);
      const realResolver = runtime.session.options.policyResolver;
      const resolver = realResolver ? {
        resolve: realResolver.resolve.bind(realResolver),
        ...(realResolver.onResolution ? { onResolution: realResolver.onResolution.bind(realResolver) } : {}),
        onInvocation: (record: PolicyInvocationRecord): Promise<void> => {
          audit = record;
          return Promise.resolve();
        },
      } : undefined;
      const requestDecision = async (request: Parameters<ToolContext["requestDecision"]>[0]): Promise<DecisionResolution> => {
        if (!runtime.effectiveThreadId) throw new Error("This orchestrator has no thread for approval. Create a thread and retry with the same invocation ID.");
        const gate = fromRequest(request, {
          sessionId: runtime.assistant.sessionId,
          threadId: runtime.effectiveThreadId,
          queueItemId: opened.invocationId,
          resumeKey: opened.invocationId,
          ordinal: 0,
        });
        const stored = await this.engineStore.getDecisionGate(runtime.assistant.sessionId, gate.id);
        if (stored?.status === "resolved" && stored.resolution) return stored.resolution;
        if (stored?.status === "expired" || stored?.status === "withdrawn") {
          return { actionId: "deny", resolvedBy: "system", resolvedAt: stored.updatedAt, gateOrdinal: stored.ordinal };
        }
        if (!stored) {
          await this.engineStore.saveDecisionGate(runtime.assistant.sessionId, gate.threadId, gate);
          const entry: SessionEntry = {
            id: `${gate.id}:entry`, sessionId: runtime.assistant.sessionId, threadId: gate.threadId,
            parentId: null, type: "decision_gate", gate, createdAt: gate.createdAt,
          };
          try {
            await this.engineStore.appendEntries(runtime.assistant.sessionId, gate.threadId, [entry]);
          } catch (error) {
            const persisted = await this.engineStore.getDecisionGate(runtime.assistant.sessionId, gate.id);
            if (!persisted) throw error;
          }
        }
        await this.invocations.markPending(opened.invocationId);
        return { actionId: "pending", resolvedBy: "system", resolvedAt: stored?.updatedAt ?? gate.createdAt, gateOrdinal: gate.ordinal };
      };
      const outcome = await invokeAction(
        runtime.catalog,
        actionId,
        actionArgs,
        this.context(runtime, requestDecision, resolver),
        summary,
        { claimExecution: async () => {
          if (!(await this.invocations.claimExecution(opened.invocationId))) throw new ExecutionClaimLostError();
          executionClaimed = true;
        } },
      );
      if (outcome.kind === "pending-approval") return json(invocationEnvelope(await this.invocations.get(opened.invocationId) ?? opened));
      if (outcome.kind === "ok" && outcome.result.success) {
        await this.invocations.markTerminal(opened.invocationId, "executing", { state: "completed", result: outcome.result }, audit);
      } else if (outcome.kind === "denied-policy" || outcome.kind === "denied-approval" || outcome.kind === "expired-approval") {
        await this.invocations.markTerminal(opened.invocationId, ["created", "pending_approval"], { state: "denied", error: "The action was denied before execution." }, audit);
      } else if (executionClaimed) {
        await this.invocations.markTerminal(opened.invocationId, "executing", { state: "indeterminate", error: "The provider may have started the action, but no completed result is available." }, audit);
      } else {
        const error = outcome.kind === "invalid-args" ? outcome.error
          : outcome.kind === "unknown" ? `Unknown action: ${outcome.toolId}`
          : outcome.kind === "missing-credential" ? `Missing ${outcome.service} credential. Connect the integration in Settings.`
          : "The action could not be prepared safely. Check the request and orchestrator configuration, then retry with a new invocation ID.";
        await this.invocations.markTerminal(opened.invocationId, ["created", "pending_approval"], { state: "failed", error }, audit);
      }
    } catch (error) {
      if (error instanceof ExecutionClaimLostError) {
        const current = await this.invocations.get(opened.invocationId);
        if (!current) throw error;
        return json(invocationEnvelope(current));
      }
      const message = executionClaimed
        ? "The provider may have started the action, but no completed result is available."
        : "The action could not be prepared safely. Check the request and orchestrator configuration, then retry with a new invocation ID.";
      await this.invocations.markTerminal(opened.invocationId, executionClaimed ? "executing" : ["created", "pending_approval"], {
        state: executionClaimed ? "indeterminate" : "failed", error: message,
      }, audit);
    }
    const terminal = await this.invocations.get(opened.invocationId);
    if (!terminal) throw new Error("The invocation record is unavailable. Ask an operator to inspect it.");
    return json(invocationEnvelope(terminal));
  }
}
