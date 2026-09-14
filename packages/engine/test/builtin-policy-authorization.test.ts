import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { adaptInteractiveBuiltin, BuiltinAuthorizationError, builtinAuthorization, builtinTools, projectBuiltinArguments, type BuiltinPolicyResolver, type ToolContext, type ToolDef } from "../src/index.js";
import { toAgentTool } from "../src/tool-bridge.js";

function context(resolver: BuiltinPolicyResolver): ToolContext {
  return { userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", owner: { type: "user", id: "user-1" }, queueItemId: "queue-1", builtinPolicyResolver: resolver, signal: new AbortController().signal, sandbox: {} as ToolContext["sandbox"], credentials: {} as ToolContext["credentials"], requestDecision: vi.fn(), threadRead: vi.fn(), listThreads: vi.fn(), setModel: vi.fn() };
}
function resolver(mode: "allow" | "deny"): BuiltinPolicyResolver { return { resolve: vi.fn(async () => ({ mode, provenance: { baseMode: mode, source: "canonical_service" } })) }; }

describe("canonical built-in authorization", () => {
  it("keeps the built-in registry exhaustive", () => {
    expect(builtinTools.map((tool) => tool.name).sort()).toEqual(["ask_approval", "bash", "child_read", "child_send", "child_status", "edit", "list_threads", "read", "switch_model", "task", "thread_read", "write"]);
    expect(builtinTools.every((tool) => tool.authorization?.actionId === `builtin.${tool.name}`)).toBe(true);
  });
  it("omits content-bearing arguments from projections and identity input", () => {
    expect(projectBuiltinArguments({ path: "a", content: "SECRET", command: "SECRET", prompt: "SECRET", message: "SECRET", body: "SECRET", params: { secret: "SECRET" } }, ["/path"])).toEqual({ path: "a" });
    expect(projectBuiltinArguments({ tool_id: "github.read", summary: "safe", params: { secret: "SECRET" } }, builtinAuthorization("call_tool").projection.pointers)).toEqual({ tool_id: "github.read", summary: "safe" });
  });
  it("keeps content bytes out of requests, identities, and projections", () => {
    const descriptor = builtinAuthorization("bash");
    const make = (secret: string) => adaptInteractiveBuiltin({ schemaVersion: 1, organizationId: "org-1", actor: { type: "user", id: "user-1" }, owner: { type: "user", id: "user-1" }, requestId: "q", sessionId: "s", threadId: "t", queueItemId: "q", toolCallId: "c", gateOrdinal: 0, descriptor, arguments: { timeout: 2, command: secret, content: secret, prompt: secret, message: secret, body: secret, params: { value: secret } }, evaluationTimeMs: 1 });
    const left = make("CANARY_A"), right = make("CANARY_B");
    expect(left).toEqual(right);
    expect(JSON.stringify(left)).not.toMatch(/CANARY_[AB]/);
  });
  it("fails recursive ask_approval policy closed before opening a gate", async () => {
    const decision = { mode: "require_approval" as const, provenance: { baseMode: "require_approval" as const, source: "canonical_service" as const }, canonical: { reasonCode: "organization_policy", obligations: [], redactions: [], approvalRequirement: { tier: "human" as const, approverType: "org" as const, replay: "once" as const } } };
    const ctx = context({ resolve: vi.fn(async () => decision) });
    const def: ToolDef = { name: "ask_approval", description: "ask", parameters: Type.Object({}), authorization: builtinAuthorization("ask_approval"), execute: vi.fn() };
    const tool = toAgentTool(def, () => ctx);
    await expect(tool.execute("call", {}, new AbortController().signal, vi.fn())).rejects.toEqual(new BuiltinAuthorizationError("recursive_approval"));
    await expect(tool.execute("call", {}, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "recursive_approval" });
    expect(ctx.requestDecision).not.toHaveBeenCalled();
    expect(def.execute).not.toHaveBeenCalled();
  });
  it("re-evaluates approval and reserves before the implementation", async () => {
    const execute = vi.fn(async () => ({ text: "ran" }));
    const resolve = vi.fn().mockResolvedValueOnce({ mode: "require_approval", provenance: { baseMode: "require_approval", source: "canonical_service" }, canonical: { reasonCode: "approval", obligations: [], redactions: [], approvalRequirement: { tier: "human", approverType: "org", replay: "once" }, requestSubjectDigest: "a", decisionDigest: "b" } }).mockResolvedValueOnce({ mode: "allow", provenance: { baseMode: "allow", source: "canonical_service" }, canonical: { reasonCode: "approved", obligations: [], redactions: [] } });
    const onResolution = vi.fn(), reserveExecution = vi.fn(async () => ({ kind: "execute" as const, attemptId: "attempt" })), completeExecution = vi.fn(async (_i, _d, _a, settlement) => settlement);
    const ctx = context({ resolve, onResolution, reserveExecution, completeExecution });
    ctx.requestDecision = vi.fn(async () => ({ actionId: "approve", resolvedBy: "approver", resolvedAt: 2, gateOrdinal: 1 }));
    const def: ToolDef = { name: "probe", description: "probe", parameters: Type.Object({}), authorization: { ...builtinAuthorization("read"), actionId: "builtin.probe" }, execute };
    await toAgentTool(def, () => ctx).execute("call", {}, new AbortController().signal, vi.fn());
    expect(resolve).toHaveBeenCalledTimes(2); expect(onResolution).toHaveBeenCalledBefore(reserveExecution); expect(reserveExecution).toHaveBeenCalledBefore(execute); expect(completeExecution).toHaveBeenCalledAfter(execute);
  });
  it("replays terminal and indeterminate reservations without dispatch", async () => {
    for (const reservation of [{ kind: "completed" as const, result: { text: "stored" } }, { kind: "indeterminate" as const, error: "indeterminate_execution: stop" }]) {
      const execute = vi.fn(async () => ({ text: "ran" }));
      const allow = { mode: "allow" as const, provenance: { baseMode: "allow" as const, source: "canonical_service" as const }, canonical: { reasonCode: "allow", obligations: [], redactions: [] } };
      const def: ToolDef = { name: "probe", description: "probe", parameters: Type.Object({}), authorization: { ...builtinAuthorization("read"), actionId: "builtin.probe" }, execute };
      await toAgentTool(def, () => context({ resolve: vi.fn(async () => allow), reserveExecution: vi.fn(async () => reservation) })).execute("call", {}, new AbortController().signal, vi.fn());
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it("applies every ordered redaction and fails unsupported paths before output", async () => {
    const execute = vi.fn(async () => ({ text: "secret", attachments: [{ type: "text" as const, content: "secret" }] }));
    const decision = { mode: "allow" as const, provenance: { baseMode: "allow" as const, source: "canonical_service" as const }, canonical: { reasonCode: "allow", obligations: [], redactions: [{ target: "user_output" as const, jsonPaths: ["$.text"] }, { target: "user_output" as const, jsonPaths: ["$.attachments"] }] } };
    const def: ToolDef = { name: "probe", description: "probe", parameters: Type.Object({}), authorization: { ...builtinAuthorization("read"), actionId: "builtin.probe" }, execute };
    const result = await toAgentTool(def, () => context({ resolve: vi.fn(async () => decision) })).execute("call", {}, new AbortController().signal, vi.fn());
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("does not call a denied implementation", async () => {
    const execute = vi.fn(async () => ({ text: "ran" }));
    const def: ToolDef = { name: "probe", description: "probe", parameters: Type.Object({}), authorization: { ...builtinAuthorization("read"), actionId: "builtin.probe" }, execute };
    const tool = toAgentTool(def, () => context(resolver("deny")));
    const result = await tool.execute("call-1", {}, new AbortController().signal, vi.fn());
    expect(execute).not.toHaveBeenCalled(); expect(JSON.stringify(result)).toContain("denied by canonical");
  });
});
