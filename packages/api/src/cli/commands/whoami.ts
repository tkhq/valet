/**
 * `valet whoami` and `valet workspaces` — who this CLI is signed in as, and
 * the workspaces it can use with --workspace. Same routes as the MCP
 * `whoami` and `list_workspaces` tools.
 */
import type { InstanceClient } from "../client.js";
import { flagProblem, help, helpRequested, runWithClient, usage } from "../command-kit.js";
import { ExitCode } from "../exit.js";
import { printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";

export type WhoamiClient = Pick<InstanceClient, "me" | "listTeams">;

export async function runWhoami(client: WhoamiClient, flags: ParsedFlags): Promise<number> {
  if (helpRequested(flags)) return help("usage: valet whoami [--json]");
  const problem = flagProblem(flags);
  if (problem) return usage(problem);
  const me = await client.me();
  if (flags.json) printJson(me);
  else if ("email" in me) printLine(`${me.name ?? me.email} <${me.email}>${"role" in me && me.role ? `  (${me.role})` : ""}`);
  else printLine(JSON.stringify(me));
  return ExitCode.OK;
}

export async function runWorkspaces(client: WhoamiClient, flags: ParsedFlags): Promise<number> {
  if (helpRequested(flags)) return help("usage: valet workspaces [--json]");
  const problem = flagProblem(flags);
  if (problem) return usage(problem);
  const [me, teams] = await Promise.all([client.me(), client.listTeams()]);
  const rows = [
    { workspace: "user", name: "Personal", ...("name" in me && me.name ? { owner: me.name } : {}) },
    ...teams.teams.filter((team) => team.callerRole !== null).map((team) => ({ workspace: team.id, name: team.name, kind: "team" })),
  ];
  if (flags.json) printJson({ workspaces: rows });
  else printLine(renderTable(["WORKSPACE", "NAME"], rows.map((w) => [w.workspace, w.name])));
  return ExitCode.OK;
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runWithClient(args, ctx, runWhoami);
}
