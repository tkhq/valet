/**
 * `valet inbox` — everything waiting for you in Valet: questions and
 * approvals in threads, and workflow runs waiting for approval. Same routes
 * as the MCP `list_inbox` tool. Answer a question with `valet gates resolve`.
 * An approval needs a person in Valet.
 */
import type { InstanceClient } from "../client.js";
import { runWithClient } from "../command-kit.js";
import { ExitCode } from "../exit.js";
import { printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";

export type InboxClient = Pick<InstanceClient, "listInboxDecisions" | "listWorkflowActionRequired">;

export async function runInbox(client: InboxClient, flags: ParsedFlags): Promise<number> {
  const [decisions, workflows] = await Promise.all([client.listInboxDecisions(), client.listWorkflowActionRequired()]);
  if (flags.json) {
    printJson({ thread_decisions: decisions.items, workflow_approvals: workflows.items });
    return ExitCode.OK;
  }
  if (decisions.items.length === 0 && workflows.items.length === 0) {
    printLine("nothing waiting");
    return ExitCode.OK;
  }
  if (decisions.items.length > 0) {
    printLine(renderTable(["THREAD", "GATE", "TYPE", "TITLE"], decisions.items.map(({ gate }) => [gate.threadId, gate.id, gate.type, gate.title])));
  }
  if (workflows.items.length > 0) {
    if (decisions.items.length > 0) printLine("");
    printLine(renderTable(["RUN", "WORKFLOW", "WAITING FOR"], workflows.items.map((item) => [
      item.runId, item.workflowName,
      item.gate.service && item.gate.action ? `${item.gate.kind} ${item.gate.service}.${item.gate.action}` : item.gate.kind,
    ])));
  }
  if (decisions.nextCursor) printLine("more thread decisions exist; open the Valet inbox to see all of them");
  return ExitCode.OK;
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runWithClient(args, ctx, runInbox);
}
