import { InstanceClient } from "../client.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import { resolveInstance } from "../resolve.js";
import { flagProblem } from "../command-kit.js";
import type { CliContext } from "../types.js";

type ThreadsClient = Pick<InstanceClient, "getThread" | "listWorkspaceThreads" | "createWorkspaceThread" | "abortThread">;
export async function runThreads(client: ThreadsClient, flags: ParsedFlags): Promise<number> {
  // A bare or empty --workspace would create the thread in the personal workspace.
  const problem = flagProblem(flags);
  if (problem) {
    printErr(problem);
    return ExitCode.Usage;
  }
  const workspace = typeof flags.flags.workspace === "string" ? flags.flags.workspace : undefined;
  switch (flags.rest[0]) {
    case "list": {
      const result = await client.listWorkspaceThreads(workspace);
      if (flags.json) printJson(result);
      else printLine(result.threads.length ? renderTable(["THREAD", "TITLE"], result.threads.map(t => [t.id, t.title ?? ""])) : "no threads");
      return ExitCode.OK;
    }
    case "new": {
      const thread = await client.createWorkspaceThread({ title: typeof flags.flags.title === "string" ? flags.flags.title : undefined }, workspace);
      if (flags.json) printJson(thread); else printLine(thread.id);
      return ExitCode.OK;
    }
    case "show": {
      const id = flags.rest[1];
      if (!id) break;
      const thread = await client.getThread(id);
      if (flags.json) printJson(thread); else printLine(`${thread.id}  ${thread.title ?? "Untitled thread"}${thread.activeItemId ? "  (working)" : ""}`);
      return ExitCode.OK;
    }
    case "stop": {
      const id = flags.rest[1];
      if (!id) break;
      // Stop the turn the server reports as active, by its id, as the web
      // Stop button does. A follow-up queued behind it keeps its place.
      const thread = await client.getThread(id);
      if (!thread.activeItemId) {
        if (flags.json) printJson({ thread_id: id, stopped: false }); else printLine("nothing to stop: the thread has no running turn");
        return ExitCode.OK;
      }
      const { stopped } = await client.abortThread(id, thread.activeItemId);
      if (flags.json) printJson({ thread_id: id, stopped, message_id: thread.activeItemId });
      else printLine(stopped
        ? `stop requested for ${thread.activeItemId}. If it was already finishing, it can still end as completed.`
        : `nothing stopped: ${thread.activeItemId} finished first. Run \`valet threads stop ${id}\` again to stop a newer turn.`);
      return ExitCode.OK;
    }
  }
  printErr("usage: valet threads <list|new|show ID|stop ID> [--workspace user|TEAM_ID] [--title TITLE]");
  return ExitCode.Usage;
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const instance = resolveInstance({ flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined, env: process.env.VALET_INSTANCE, config: ctx.config });
  return runThreads(new InstanceClient({ url: instance.url, apiKey: instance.apiKey }), flags);
}
