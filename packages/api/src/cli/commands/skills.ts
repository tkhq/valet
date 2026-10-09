/**
 * `valet skills` — list and read the playbooks the organization and teams
 * maintain. Same routes as the MCP `list_skills` / `get_skill` tools.
 *
 *   valet skills list [query] [--limit <n>] [--workspace user|TEAM_ID]
 *   valet skills show <name>
 */
import type { InstanceClient } from "../client.js";
import { intFlag, runWithClient, strFlag, usage } from "../command-kit.js";
import { ExitCode } from "../exit.js";
import { printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";

const USAGE = [
  "usage: valet skills list [query] [--limit <n>] [--workspace user|TEAM_ID]",
  "       valet skills show <name>",
].join("\n");

export type SkillsClient = Pick<InstanceClient, "listSkills" | "getSkill">;

export async function runSkills(client: SkillsClient, flags: ParsedFlags): Promise<number> {
  const [sub, ...args] = flags.rest;
  if (sub === "list") {
    const limit = intFlag(flags, "limit");
    if (typeof limit === "object") return usage(limit.error);
    const res = await client.listSkills({ query: args.join(" ") || undefined, workspace: strFlag(flags, "workspace"), limit });
    if (flags.json) printJson(res);
    else if (res.skills.length === 0) printLine("no matching skills");
    else printLine(renderTable(["SKILL", "DESCRIPTION"], res.skills.map((s) => [s.name, (s.description ?? "").split("\n")[0] ?? ""])));
    if (!flags.json && res.nextCursor) printLine("more skills exist; narrow the query or raise --limit");
    return ExitCode.OK;
  }
  if (sub === "show") {
    const name = args[0];
    if (!name) return usage(USAGE);
    const skill = await client.getSkill(name);
    if (flags.json) printJson(skill);
    else printLine(skill.content);
    return ExitCode.OK;
  }
  return usage(USAGE);
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runWithClient(args, ctx, runSkills);
}
