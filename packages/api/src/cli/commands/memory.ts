/**
 * `valet memory` — search, read, and edit Valet memory from a shell or an
 * agent without MCP. Same routes and rules as the MCP memory tools: a team
 * workspace maps to `ownerType=team&ownerId=<id>`, and a team write needs
 * team admin rights.
 *
 *   valet memory search <query> [--limit <n>]
 *   valet memory read <path>               ("" or "/" reads the root index)
 *   valet memory write <path> --file <path|-> [--description <d>] [--tags a,b]
 *   valet memory patch <path> --old <text> --new <text>   (--new "" deletes; --new=<text> for "--" text)
 *   valet memory mv <from> <to>
 *   valet memory rm <path>
 *
 * Every subcommand takes --workspace user|TEAM_ID and --json.
 */
import type { InstanceClient } from "../client.js";
import { flagProblem, intFlag, readSource, runWithClient, strFlag, usage } from "../command-kit.js";
import { ExitCode } from "../exit.js";
import { printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";

const USAGE = [
  "usage: valet memory search <query> [--limit <n>]",
  "       valet memory read <path>",
  "       valet memory write <path> --file <path|-> [--description <d>] [--tags a,b]",
  "       valet memory patch <path> --old <text> --new <text>",
  "       valet memory mv <from> <to>",
  "       valet memory rm <path>",
  "options: --workspace user|TEAM_ID, --json",
].join("\n");

export type MemoryClient = Pick<InstanceClient, "searchMemory" | "readMemory" | "writeMemory" | "patchMemory" | "moveMemory" | "deleteMemory">;

export interface MemoryDeps {
  client: MemoryClient;
  readSource(source: string): Promise<string>;
}

export async function runMemory(deps: MemoryDeps, flags: ParsedFlags): Promise<number> {
  const problem = flagProblem(flags, ["new"]);
  if (problem) return usage(problem);
  const [sub, ...args] = flags.rest;
  const workspace = strFlag(flags, "workspace");
  const { client } = deps;

  switch (sub) {
    case "search": {
      const query = args.join(" ");
      if (!query) return usage(USAGE);
      const limit = intFlag(flags, "limit");
      if (typeof limit === "object") return usage(limit.error);
      const res = await client.searchMemory(query, workspace, limit);
      if (flags.json) printJson(res);
      else if (res.results.length === 0) printLine("no matching memory");
      else printLine(renderTable(["PATH", "TITLE"], res.results.map((r) => [r.path, r.title ?? r.description ?? ""])));
      return ExitCode.OK;
    }
    case "read": {
      if (args[0] === undefined) return usage(USAGE);
      const memoryPath = args[0] === "/" ? "" : args[0];
      const res = await client.readMemory(memoryPath, workspace);
      if (flags.json) printJson(res);
      else printLine(res.file?.content ?? res.rendered ?? "");
      return ExitCode.OK;
    }
    case "write": {
      const memoryPath = args[0];
      const source = strFlag(flags, "file");
      if (!memoryPath || source === undefined) return usage(USAGE);
      const content = await deps.readSource(source);
      if (content.trim() === "") return usage("The content is empty. Write a file with content, or use `valet memory rm` to delete one.");
      const tags = strFlag(flags, "tags")?.split(",").map((t) => t.trim()).filter(Boolean);
      const description = strFlag(flags, "description");
      const res = await client.writeMemory({ path: memoryPath, content, ...(description ? { description } : {}), ...(tags?.length ? { tags } : {}) }, workspace);
      if (flags.json) printJson(res);
      else printLine(`wrote ${res.file?.path ?? memoryPath}${res.file?.version !== undefined ? ` (version ${res.file.version})` : ""}`);
      return ExitCode.OK;
    }
    case "patch": {
      const memoryPath = args[0];
      // flagProblem already refused a bare --old or --new. Only --new "" (delete) may be empty.
      const oldString = strFlag(flags, "old");
      const newString = strFlag(flags, "new");
      if (!memoryPath || !oldString || newString === undefined) return usage(USAGE);
      const res = await client.patchMemory({ path: memoryPath, oldString, newString }, workspace);
      if (flags.json) printJson(res);
      else printLine(`patched ${res.file?.path ?? memoryPath}`);
      return ExitCode.OK;
    }
    case "mv": {
      const [from, to] = args;
      if (!from || !to) return usage(USAGE);
      await client.moveMemory(from, to, workspace);
      if (flags.json) printJson({ from, to, moved: true });
      else printLine(`moved ${from} to ${to}`);
      return ExitCode.OK;
    }
    case "rm": {
      const memoryPath = args[0];
      if (!memoryPath) return usage(USAGE);
      await client.deleteMemory(memoryPath, workspace);
      if (flags.json) printJson({ path: memoryPath, deleted: true });
      else printLine(`deleted ${memoryPath}`);
      return ExitCode.OK;
    }
  }
  return usage(USAGE);
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runWithClient(args, ctx, (client, flags) => runMemory({ client, readSource }, flags));
}
