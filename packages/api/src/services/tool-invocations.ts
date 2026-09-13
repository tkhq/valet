import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { PolicyInvocationRecord } from "@valet/engine";
import { canonicalJson } from "../lib/canonical-json.js";
import type { AppDb } from "../lib/drizzle.js";
import { capAuditField, POLICY_AUDIT_FIELD_CAP } from "../policies/service.js";
import { actionInvocations, type ActionInvocationRow } from "../schema/index.js";

export type McpInvocationState = "created" | "pending_approval" | "executing" | "completed" | "denied" | "failed" | "indeterminate";

export interface McpInvocationBinding {
  userId: string;
  orgId: string;
  clientInvocationId: string;
  orchestratorId: string;
  sessionId: string;
  threadId?: string;
  actionId: string;
  args: Record<string, unknown>;
  sourceIp: string;
}

export interface McpInvocationEnvelope {
  invocationId: string;
  status: "pending" | "in_progress_or_interrupted" | "completed" | "denied" | "failed" | "indeterminate";
  result?: unknown;
  error?: string;
  correctiveAction: string;
}

export class InvocationBindingMismatchError extends Error {
  constructor() {
    super("This invocation ID is already bound to a different request. Use a new invocation ID and try again.");
    this.name = "InvocationBindingMismatchError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function rowId(userId: string, clientInvocationId: string): string {
  return `mcp:call:${digest(canonicalJson({ clientInvocationId, userId }))}`;
}

function bindingHash(binding: McpInvocationBinding): string {
  return digest(canonicalJson({
    orchestratorId: binding.orchestratorId,
    threadId: binding.threadId ?? "",
    fqToolId: binding.actionId,
    params: binding.args,
  }));
}

function state(row: ActionInvocationRow): McpInvocationState {
  switch (row.status) {
    case "created": case "pending_approval": case "executing": case "completed":
    case "denied": case "failed": case "indeterminate": return row.status;
    default: throw new Error("The invocation record is invalid. Ask an operator to inspect the action invocation.");
  }
}

export function invocationEnvelope(row: ActionInvocationRow): McpInvocationEnvelope {
  const invocationId = row.clientInvocationId ?? "";
  switch (state(row)) {
    case "completed":
      return { invocationId, status: "completed", result: row.result, correctiveAction: "No action is required." };
    case "denied":
      return { invocationId, status: "denied", error: row.error ?? undefined, correctiveAction: "Change the request or ask an administrator to update the action policy." };
    case "failed":
      return { invocationId, status: "failed", error: row.error ?? undefined, correctiveAction: "Fix the request and retry with a new invocation ID." };
    case "indeterminate":
      return { invocationId, status: "indeterminate", error: row.error ?? "The provider may have completed the action, but Valet could not persist the result.", correctiveAction: "Inspect the provider before you retry. Ask an operator to reconcile this invocation if its outcome is unclear." };
    case "pending_approval":
      return { invocationId, status: "pending", correctiveAction: "Approve or deny the pending request, then retry with the same invocation ID." };
    case "created":
      return { invocationId, status: "in_progress_or_interrupted", correctiveAction: "Retry with the same invocation ID. Valet can safely re-drive pre-execution work." };
    case "executing":
      return { invocationId, status: "in_progress_or_interrupted", error: "The action may still be running, or the prior driver may have stopped after the execution claim.", correctiveAction: "Do not use a new invocation ID. Inspect the provider or ask an operator to reconcile this invocation." };
  }
}

export class McpInvocationStore {
  constructor(private readonly db: AppDb, private readonly clock: () => number = Date.now) {}

  async open(binding: McpInvocationBinding): Promise<ActionInvocationRow> {
    const invocationId = rowId(binding.userId, binding.clientInvocationId);
    const hash = bindingHash(binding);
    const now = this.clock();
    const params = capAuditField(binding.args);
    const inserted = await this.db.insert(actionInvocations).values({
      invocationId, createdAt: now, updatedAt: now, source: "mcp_call_tool",
      clientInvocationId: binding.clientInvocationId, orchestratorId: binding.orchestratorId,
      sessionId: binding.sessionId, threadId: binding.threadId ?? null, bindingHash: hash,
      actionId: binding.actionId, userId: binding.userId, orgId: binding.orgId,
      sourceIp: binding.sourceIp, params: params.value, paramsTruncated: params.truncated, status: "created",
    }).onConflictDoNothing().returning();
    const row = inserted[0] ?? await this.get(invocationId);
    if (!row || row.source !== "mcp_call_tool" || row.bindingHash !== hash || row.userId !== binding.userId) {
      throw new InvocationBindingMismatchError();
    }
    return row;
  }

  async markPending(invocationId: string): Promise<ActionInvocationRow> {
    const rows = await this.db.update(actionInvocations).set({ status: "pending_approval", updatedAt: this.clock() })
      .where(and(eq(actionInvocations.invocationId, invocationId), inArray(actionInvocations.status, ["created", "pending_approval"]))).returning();
    const row = rows[0] ?? await this.get(invocationId);
    if (!row || row.status !== "pending_approval") throw new Error("This invocation changed state before approval was stored. Retry with the same invocation ID.");
    return row;
  }

  async claimExecution(invocationId: string): Promise<boolean> {
    const now = this.clock();
    const rows = await this.db.update(actionInvocations).set({ status: "executing", startedAt: now, updatedAt: now })
      .where(and(eq(actionInvocations.invocationId, invocationId), inArray(actionInvocations.status, ["created", "pending_approval"])))
      .returning({ invocationId: actionInvocations.invocationId });
    return rows.length === 1;
  }

  async markTerminal(
    invocationId: string,
    expected: "created" | "pending_approval" | "executing" | Array<"created" | "pending_approval" | "executing">,
    terminal: { state: "completed" | "denied" | "failed" | "indeterminate"; result?: unknown; error?: string },
    audit?: PolicyInvocationRecord,
  ): Promise<ActionInvocationRow> {
    const result = capAuditField(terminal.result);
    const error = terminal.error && terminal.error.length > POLICY_AUDIT_FIELD_CAP
      ? terminal.error.slice(0, POLICY_AUDIT_FIELD_CAP)
      : terminal.error ?? null;
    const rows = await this.db.update(actionInvocations).set({
      status: terminal.state, result: result.value, resultTruncated: result.truncated, error, updatedAt: this.clock(),
      ...(audit ? { service: audit.service, actionId: audit.actionId, riskLevel: audit.riskLevel,
        resolvedMode: audit.resolvedMode, baseMode: audit.provenance.baseMode,
        matchedPolicyId: audit.provenance.matchedPolicyId ?? null,
        matchedGrantId: audit.provenance.matchedGrantId ?? null,
        matchedOverrideId: audit.provenance.matchedOverrideId ?? null,
        durationMs: audit.durationMs ?? null } : {}),
    }).where(and(eq(actionInvocations.invocationId, invocationId), Array.isArray(expected)
      ? inArray(actionInvocations.status, expected)
      : eq(actionInvocations.status, expected))).returning();
    const row = rows[0] ?? await this.get(invocationId);
    if (!row || row.status !== terminal.state) throw new Error("This invocation lost its terminal state claim. Retry with the same invocation ID.");
    return row;
  }

  async get(invocationId: string): Promise<ActionInvocationRow | undefined> {
    return (await this.db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, invocationId)).limit(1))[0];
  }
}
