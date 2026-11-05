/**
 * `valet tools <search|describe|call>` — run Valet-brokered actions from a
 * shell or an agent harness that does not speak MCP. Same routes and rules
 * as the MCP `search_tools` / `describe_tool` / `call_tool` tools
 * (`/api/actions`): the workspace's credentials stay on the server, and the
 * policy hierarchy applies.
 *
 *   valet tools search [query] [--service <s>] [--workspace <w>] [--limit <n>]
 *   valet tools describe <tool_id> [--params '<json>'] [--workspace <w>]
 *   valet tools call <tool_id> [--params '<json>' | --params-file <path|->]
 *                    [--workspace <w>] [--idempotency-key <k>]
 *
 * `call` exit codes: 0 completed, 3 approval required or still running (the
 * action did not finish), 4 failed. `--json` prints the server response unchanged.
 */
import { readFileSync } from "node:fs";
import { InstanceClient } from "../client.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import { resolveInstance } from "../resolve.js";
import type { CliContext } from "../types.js";
import type { ActionDescribeResponse, ActionInvokeRequest, ActionInvokeResponse, ActionSearchResponse } from "../../wire/types.js";

const USAGE = [
  "usage: valet tools search [query] [--service <s>] [--workspace <w>] [--limit <n>]",
  "       valet tools describe <tool_id> [--params '<json>'] [--workspace <w>]",
  "       valet tools call <tool_id> [--params '<json>' | --params-file <path|->] [--workspace <w>] [--idempotency-key <k>]",
].join("\n");

/** The subset of `InstanceClient` the `tools` command needs. */
export interface ToolsClient {
  searchTools(opts: { query?: string; service?: string; workspace?: string; limit?: number }): Promise<ActionSearchResponse>;
  describeTool(toolId: string, workspace?: string, params?: Record<string, unknown>): Promise<ActionDescribeResponse>;
  callTool(toolId: string, body: ActionInvokeRequest): Promise<ActionInvokeResponse>;
}

export interface ToolsDeps {
  client: ToolsClient;
  readFile(path: string): string;
  readStdin(): Promise<string>;
}

function str(flags: ParsedFlags, name: string): string | undefined {
  const value = flags.flags[name];
  return typeof value === "string" ? value : undefined;
}

async function readParams(deps: ToolsDeps, flags: ParsedFlags): Promise<Record<string, unknown> | string> {
  const inline = str(flags, "params");
  const file = str(flags, "params-file");
  if (inline !== undefined && file !== undefined) return "Use --params or --params-file, not both.";
  const raw = inline ?? (file === "-" ? await deps.readStdin() : file !== undefined ? deps.readFile(file) : undefined);
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "The params are not valid JSON. Pass a JSON object, e.g. --params '{\"title\":\"Bug\"}'.";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "The params must be a JSON object.";
  return parsed as Record<string, unknown>;
}

export async function runTools(deps: ToolsDeps, flags: ParsedFlags): Promise<number> {
  const [sub, ...args] = flags.rest;
  const workspace = str(flags, "workspace");

  if (sub === "search") {
    const limitRaw = str(flags, "limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      printErr("Set --limit to a positive whole number.");
      return ExitCode.Usage;
    }
    const res = await deps.client.searchTools({ query: args.join(" ") || undefined, service: str(flags, "service"), workspace, limit });
    if (flags.json) {
      printJson(res);
      return ExitCode.OK;
    }
    if (res.tools.length === 0) printLine("no matching tools");
    else printLine(renderTable(["TOOL", "RISK", "DESCRIPTION"], res.tools.map((t) => [t.tool_id, t.risk_level, t.description.split("\n")[0] ?? ""])));
    if (res.total > res.tools.length) printLine(`showing ${res.tools.length} of ${res.total}; narrow the query or raise --limit`);
    for (const u of res.unavailable ?? []) printErr(`${u.service}: ${u.reason}`);
    return ExitCode.OK;
  }

  if (sub === "describe") {
    const toolId = args[0];
    if (!toolId) {
      printErr(USAGE);
      return ExitCode.Usage;
    }
    const params = str(flags, "params") !== undefined || str(flags, "params-file") !== undefined ? await readParams(deps, flags) : undefined;
    if (typeof params === "string") {
      printErr(params);
      return ExitCode.Usage;
    }
    const res = await deps.client.describeTool(toolId, workspace, params);
    if (flags.json) {
      printJson(res);
      return ExitCode.OK;
    }
    printLine(`${res.tool_id}  (${res.risk_level} risk, policy: ${res.policy} for ${res.policy_for})`);
    printLine(res.description);
    printLine("");
    printLine("params (JSON Schema):");
    printLine(JSON.stringify(res.parameters, null, 2));
    return ExitCode.OK;
  }

  if (sub === "call") {
    const toolId = args[0];
    if (!toolId) {
      printErr(USAGE);
      return ExitCode.Usage;
    }
    const params = await readParams(deps, flags);
    if (typeof params === "string") {
      printErr(params);
      return ExitCode.Usage;
    }
    const key = str(flags, "idempotency-key");
    const res = await deps.client.callTool(toolId, { params, ...(workspace ? { workspace } : {}), ...(key ? { idempotencyKey: key } : {}) });
    if (flags.json) printJson(res);
    else if (res.status === "completed") printLine(typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2));
    else if (res.status === "failed") printErr(`${res.tool_id} failed: ${res.error}`);
    else if (res.status === "in_progress") printErr(`${res.tool_id} is still running. ${res.next_step}`);
    else printErr(`${res.tool_id} did not run: approval required. ${res.next_step}`);
    if (res.status === "completed") return ExitCode.OK;
    return res.status === "failed" ? ExitCode.TurnError : ExitCode.GatePending;
  }

  printErr(USAGE);
  return ExitCode.Usage;
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const instance = resolveInstance({
    flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined,
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });
  const client = new InstanceClient({ url: instance.url, apiKey: instance.apiKey });
  return runTools({
    client,
    readFile: (path) => readFileSync(path, "utf8"),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
  }, flags);
}
