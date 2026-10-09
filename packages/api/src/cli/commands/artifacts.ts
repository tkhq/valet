/**
 * `valet artifacts` — list, publish, and unpublish artifact pages. Same
 * routes and rules as the MCP artifact tools. Every member of the Valet
 * organization can open a published page. An agent credential can unpublish
 * only artifacts its user published.
 *
 *   valet artifacts list [query] [--limit <n>] [--workspace user|TEAM_ID]
 *   valet artifacts publish <file|-> [--key <key>] [--title <t>] [--format markdown|html] [--description <d>]
 *   valet artifacts unpublish <artifact_id>
 *
 * publish keys the page by --key, or by the file name without its extension.
 * A team publish needs --key, so a default name cannot replace a teammate's page.
 * Publishing again with the same key adds a version at the same link.
 */
import { basename, extname } from "node:path";
import type { InstanceClient } from "../client.js";
import { intFlag, readSource, runWithClient, strFlag, usage } from "../command-kit.js";
import { ExitCode } from "../exit.js";
import { printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";

const USAGE = [
  "usage: valet artifacts list [query] [--limit <n>] [--workspace user|TEAM_ID]",
  "       valet artifacts publish <file|-> [--key <key>] [--title <t>] [--format markdown|html] [--description <d>]",
  "       valet artifacts unpublish <artifact_id>",
].join("\n");

export type ArtifactsClient = Pick<InstanceClient, "listArtifacts" | "shareArtifact" | "revokeArtifact">;

export interface ArtifactsDeps {
  client: ArtifactsClient;
  readSource(source: string): Promise<string>;
}

function formatFor(file: string, flag: string | undefined): "markdown" | "html" | { error: string } {
  if (flag === "markdown" || flag === "html") return flag;
  if (flag !== undefined) return { error: "Set --format to markdown or html." };
  return /\.html?$/i.test(file) ? "html" : "markdown";
}

export async function runArtifacts(deps: ArtifactsDeps, flags: ParsedFlags): Promise<number> {
  const [sub, ...args] = flags.rest;
  const workspace = strFlag(flags, "workspace");
  const { client } = deps;

  switch (sub) {
    case "list": {
      const limit = intFlag(flags, "limit");
      if (typeof limit === "object") return usage(limit.error);
      const needle = args.join(" ").toLowerCase();
      const res = await client.listArtifacts(workspace);
      const matched = res.artifacts
        .filter((a) => !a.revoked)
        .filter((a) => !needle || a.path.toLowerCase().includes(needle) || a.title.toLowerCase().includes(needle))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const shown = matched.slice(0, limit ?? 25);
      if (flags.json) printJson({ artifacts: shown, total: matched.length });
      else if (shown.length === 0) printLine("no artifacts");
      else printLine(renderTable(["ID", "KEY", "TITLE", "URL"], shown.map((a) => [a.id, a.path, a.title, a.url])));
      if (!flags.json && matched.length > shown.length) printLine(`showing ${shown.length} of ${matched.length}; narrow the query or raise --limit`);
      return ExitCode.OK;
    }
    case "publish": {
      const file = args[0];
      if (!file) return usage(USAGE);
      const format = formatFor(file, strFlag(flags, "format"));
      if (typeof format === "object") return usage(format.error);
      // A team shares one key space, so a default like "README" would replace a
      // teammate's page at its link. Personal keys are the publisher's own.
      if (workspace && workspace !== "user" && strFlag(flags, "key") === undefined) {
        return usage("Set --key when you publish to a team workspace, so you do not replace a teammate's page.");
      }
      const key = strFlag(flags, "key") ?? (file === "-" ? undefined : basename(file, extname(file)));
      if (!key) return usage("Set --key when you publish from stdin.");
      const content = await deps.readSource(file);
      if (content.trim() === "") return usage("The content is empty. Publish a file with content.");
      const title = strFlag(flags, "title");
      const description = strFlag(flags, "description");
      const res = await client.shareArtifact({ key, content, format, ...(title ? { title } : {}), ...(description ? { description } : {}) }, workspace);
      if (flags.json) printJson(res);
      else {
        printLine(res.url);
        printLine(`${res.path} version ${res.version}, visible to ${res.visibility === "public" ? "anyone with the link" : "every member of your Valet organization"}`);
      }
      return ExitCode.OK;
    }
    case "unpublish": {
      const id = args[0];
      if (!id) return usage(USAGE);
      await client.revokeArtifact(id);
      if (flags.json) printJson({ artifact_id: id, unpublished: true });
      else printLine(`unpublished ${id}`);
      return ExitCode.OK;
    }
  }
  return usage(USAGE);
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runWithClient(args, ctx, (client, flags) => runArtifacts({ client, readSource }, flags));
}
