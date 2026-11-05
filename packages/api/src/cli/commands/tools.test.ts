import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { runTools, type ToolsClient, type ToolsDeps } from "./tools.js";
import type { ActionInvokeRequest, ActionInvokeResponse } from "../../wire/types.js";

let outSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());
const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

function deps(response: ActionInvokeResponse, files: Record<string, string> = {}, stdin = ""): ToolsDeps & { calls: Array<{ toolId: string; body: ActionInvokeRequest }> } {
  const calls: Array<{ toolId: string; body: ActionInvokeRequest }> = [];
  const client: ToolsClient = {
    searchTools: async () => ({
      tools: [{ tool_id: "github.create_issue", service: "github", name: "Create issue", description: "Create a GitHub issue.\nMore detail.", risk_level: "medium" }],
      total: 3,
      unavailable: [{ service: "notion", reason: "Connect Notion in Settings." }],
    }),
    describeTool: async (toolId) => ({ tool_id: toolId, service: "github", name: "Create issue", description: "Create a GitHub issue.", risk_level: "medium", parameters: { type: "object" }, policy: "allow", policy_for: "any params" }),
    callTool: async (toolId, body) => {
      calls.push({ toolId, body });
      return response;
    },
  };
  return { client, calls, readFile: (p) => files[p] ?? "", readStdin: async () => stdin };
}

const run = (d: ToolsDeps, args: string[]) => runTools(d, parseGlobalFlags(args));

describe("valet tools", () => {
  it("search prints a table, the truncation hint, and unavailable services on stderr", async () => {
    const code = await run(deps({ tool_id: "x", status: "completed", result: null }), ["search", "create", "issue"]);
    expect(code).toBe(ExitCode.OK);
    expect(stdout()).toContain("github.create_issue");
    expect(stdout()).toContain("Create a GitHub issue.");
    expect(stdout()).not.toContain("More detail.");
    expect(stdout()).toContain("showing 1 of 3");
    expect(stderr()).toContain("notion: Connect Notion in Settings.");
  });

  it("describe prints the policy and the parameter schema", async () => {
    await run(deps({ tool_id: "x", status: "completed", result: null }), ["describe", "github.create_issue"]);
    expect(stdout()).toContain("policy: allow");
    expect(stdout()).toContain('"type": "object"');
  });

  it("call sends params, workspace, and idempotency key, and exits 0 on completion", async () => {
    const d = deps({ tool_id: "github.create_issue", status: "completed", result: { number: 7 } });
    const code = await run(d, ["call", "github.create_issue", "--params", '{"title":"Bug"}', "--workspace", "team-1", "--idempotency-key", "k1"]);
    expect(code).toBe(ExitCode.OK);
    expect(d.calls).toEqual([{ toolId: "github.create_issue", body: { params: { title: "Bug" }, workspace: "team-1", idempotencyKey: "k1" } }]);
    expect(stdout()).toContain('"number": 7');
  });

  it("call reads params from a file or stdin", async () => {
    const fromFile = deps({ tool_id: "t", status: "completed", result: null }, { "p.json": '{"a":1}' });
    await run(fromFile, ["call", "t", "--params-file", "p.json"]);
    expect(fromFile.calls[0]?.body.params).toEqual({ a: 1 });
    const fromStdin = deps({ tool_id: "t", status: "completed", result: null }, {}, '{"b":2}');
    await run(fromStdin, ["call", "t", "--params-file", "-"]);
    expect(fromStdin.calls[0]?.body.params).toEqual({ b: 2 });
  });

  it("call maps approval_required to exit 3 and failed to exit 4", async () => {
    const pending = await run(deps({ tool_id: "t", status: "approval_required", next_step: "Ask Valet with start_thread." }), ["call", "t"]);
    expect(pending).toBe(ExitCode.GatePending);
    expect(stderr()).toContain("approval required. Ask Valet with start_thread.");
    const failed = await run(deps({ tool_id: "t", status: "failed", error: "boom" }), ["call", "t"]);
    expect(failed).toBe(ExitCode.TurnError);
  });

  it("call --json prints the response and keeps the exit code", async () => {
    const code = await run(deps({ tool_id: "t", status: "approval_required", next_step: "x" }), ["call", "t", "--json"]);
    expect(code).toBe(ExitCode.GatePending);
    expect(JSON.parse(stdout())).toMatchObject({ status: "approval_required" });
  });

  it("rejects bad params before any call", async () => {
    const d = deps({ tool_id: "t", status: "completed", result: null });
    expect(await run(d, ["call", "t", "--params", "not json"])).toBe(ExitCode.Usage);
    expect(await run(d, ["call", "t", "--params", "[1]"])).toBe(ExitCode.Usage);
    expect(d.calls).toEqual([]);
    expect(stderr()).toContain("JSON object");
  });
});
