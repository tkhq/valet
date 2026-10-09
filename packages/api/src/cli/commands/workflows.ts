/**
 * `valet workflows` — list, run, and control saved workflow runs. Same routes
 * and rules as the MCP workflow tools. An agent credential can start, cancel,
 * and retry a run, but never approve one: a person approves it in Valet.
 *
 *   valet workflows list [--workspace user|TEAM_ID]
 *   valet workflows run <workflow_id> [--input '<json>' | --input-file <path|->] [--wait <s>]
 *   valet workflows status <run_id> [--wait <s>]
 *   valet workflows cancel <run_id>
 *   valet workflows retry <run_id> [--wait <s>]
 *
 * --wait polls until the run settles or stops for approval. Exit codes:
 * 0 completed (or cancelled, for cancel), 3 still running or waiting for
 * approval, 4 failed or cancelled.
 */
import type { InstanceClient } from "../client.js";
import { intFlag, parseJsonObject, readSource, runWithClient, strFlag, usage } from "../command-kit.js";
import { ExitCode } from "../exit.js";
import { printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";
import type { GetWorkflowRunResponse } from "../../wire/types.js";

const USAGE = [
  "usage: valet workflows list [--workspace user|TEAM_ID]",
  "       valet workflows run <workflow_id> [--input '<json>' | --input-file <path|->] [--wait <s>]",
  "       valet workflows status <run_id> [--wait <s>]",
  "       valet workflows cancel <run_id>",
  "       valet workflows retry <run_id> [--wait <s>]",
].join("\n");

/** A cancelled run settles in about a second. A slower one reports its current status. */
const CANCEL_WAIT_SECONDS = 10;
const POLL_MS = 1_000;

export type WorkflowsClient = Pick<InstanceClient, "listWorkflows" | "startWorkflowRun" | "getWorkflowRun" | "cancelWorkflowRun" | "retryWorkflowRun">;

export interface WorkflowsDeps {
  client: WorkflowsClient;
  readSource(source: string): Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Polls until the run settles, stops on a gate (unless `stopOnGate` is false), or the wait ends. */
async function waitForRun(deps: WorkflowsDeps, runId: string, waitSeconds: number, stopOnGate = true): Promise<GetWorkflowRunResponse> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + waitSeconds * 1000;
  for (;;) {
    const detail = await deps.client.getWorkflowRun(runId);
    if (detail.run.status === "settled" || (stopOnGate && detail.pendingGates.length > 0) || now() >= deadline) return detail;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
}

function report(detail: GetWorkflowRunResponse, json: boolean, cancelling = false): number {
  const { run } = detail;
  if (json) printJson(detail);
  else {
    printLine(`${run.runId}  ${run.status}${run.outcome ? ` (${run.outcome})` : ""}`);
    for (const gate of detail.pendingGates) {
      const action = gate.service && gate.action ? ` ${gate.service}.${gate.action}` : "";
      printLine(`  waiting for approval: ${gate.kind}${action}. A person approves it in Valet.`);
    }
  }
  if (run.status !== "settled") return ExitCode.GatePending;
  if (run.outcome === "completed" || (cancelling && run.outcome === "cancelled")) return ExitCode.OK;
  return ExitCode.TurnError;
}

export async function runWorkflows(deps: WorkflowsDeps, flags: ParsedFlags): Promise<number> {
  const [sub, id] = flags.rest;
  const { client } = deps;
  const wait = intFlag(flags, "wait");
  if (typeof wait === "object") return usage(wait.error);

  switch (sub) {
    case "list": {
      const res = await client.listWorkflows(strFlag(flags, "workspace"));
      if (flags.json) printJson(res);
      else if (res.workflows.length === 0) printLine("no workflows");
      else printLine(renderTable(["WORKFLOW", "NAME", "LATEST RUN"], res.workflows.map((w) => [
        w.id, w.name, w.latestRun ? `${w.latestRun.status}${w.latestRun.outcome ? ` (${w.latestRun.outcome})` : ""}` : "",
      ])));
      return ExitCode.OK;
    }
    case "run": {
      if (!id) return usage(USAGE);
      const inline = strFlag(flags, "input");
      const file = strFlag(flags, "input-file");
      if (inline !== undefined && file !== undefined) return usage("Use --input or --input-file, not both.");
      const raw = inline ?? (file !== undefined ? await deps.readSource(file) : undefined);
      const parsed = raw === undefined || raw.trim() === "" ? undefined : parseJsonObject(raw, inline !== undefined ? "input" : "input-file");
      if (parsed && !parsed.ok) return usage(parsed.error);
      const started = await client.startWorkflowRun(id, parsed?.value);
      return report(await waitForRun(deps, started.runId, wait ?? 0), flags.json);
    }
    case "status": {
      if (!id) return usage(USAGE);
      return report(await waitForRun(deps, id, wait ?? 0), flags.json);
    }
    case "cancel": {
      if (!id) return usage(USAGE);
      await client.cancelWorkflowRun(id);
      // Cancel is asynchronous, and the gate it cancels stays pending until the run settles.
      return report(await waitForRun(deps, id, CANCEL_WAIT_SECONDS, false), flags.json, true);
    }
    case "retry": {
      if (!id) return usage(USAGE);
      const retried = await client.retryWorkflowRun(id);
      return report(await waitForRun(deps, retried.runId, wait ?? 0), flags.json);
    }
  }
  return usage(USAGE);
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runWithClient(args, ctx, (client, flags) => runWorkflows({ client, readSource }, flags));
}
