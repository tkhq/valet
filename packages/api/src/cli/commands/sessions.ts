/**
 * `valet sessions list|new|show` — inspect and create sessions on an instance.
 *
 * `run` is a thin shell: parse flags, resolve the instance, build an
 * `InstanceClient`, and delegate to the pure `runSessions(client, flags)`.
 * The pure function accepts the narrow `SessionsClient` surface so tests can
 * pass a stub without a live server (no `as unknown as` casts).
 */
import { isAbsolute } from "node:path";
import { InstanceClient } from "../client.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import { resolveInstance } from "../resolve.js";
import type { CliContext } from "../types.js";
import type {
  CreateSessionRequest,
  GetSessionResponse,
  ListSessionsResponse,
  SandboxProfile,
  SessionDetail,
  SessionSummary,
} from "../../wire/types.js";

/** The subset of `InstanceClient` the `sessions` command needs. */
export interface SessionsClient {
  listSessions(): Promise<ListSessionsResponse>;
  createSession(body: CreateSessionRequest): Promise<GetSessionResponse>;
  getSession(id: string): Promise<GetSessionResponse>;
}

const USAGE = "usage: valet sessions <list|new|show>";

/** Format a `SessionSummary[]` as an aligned id/status/title/workspace table. */
export function formatSessionsTable(sessions: SessionSummary[]): string {
  const rows = sessions.map((s) => [s.id, s.status, s.title ?? "", s.workspace]);
  return renderTable(["ID", "STATUS", "TITLE", "WORKSPACE"], rows);
}

/** Format a single session's detail as aligned `key: value` lines. */
export function formatSessionDetail(s: SessionDetail): string {
  const rows: string[][] = [
    ["id", s.id],
    ["status", s.status],
    ["title", s.title ?? ""],
    ["workspace", s.workspace],
    ["profile", s.profile],
    ["messages", String(s.messageCount)],
    ["model", s.model ?? ""],
  ];
  return rows.map(([k, v]) => `${`${k}:`.padEnd(11)}${v}`).join("\n");
}

function isSandboxProfile(v: string): v is SandboxProfile {
  return v === "headless" || v === "full";
}

async function sessionsList(client: SessionsClient, json: boolean): Promise<number> {
  const { sessions } = await client.listSessions();
  if (json) {
    printJson({ sessions });
    return ExitCode.OK;
  }
  if (sessions.length === 0) {
    printLine("no sessions");
    return ExitCode.OK;
  }
  printLine(formatSessionsTable(sessions));
  return ExitCode.OK;
}

async function sessionsNew(client: SessionsClient, flags: ParsedFlags): Promise<number> {
  const workspace = flags.flags.workspace;
  if (typeof workspace !== "string" || workspace === "") {
    printErr("valet sessions new: --workspace <abs path> is required");
    return ExitCode.Usage;
  }
  if (!isAbsolute(workspace)) {
    printErr(`valet sessions new: --workspace must be an absolute path (got "${workspace}")`);
    return ExitCode.Usage;
  }

  const body: CreateSessionRequest = { workspace };
  if (typeof flags.flags.title === "string") body.title = flags.flags.title;

  const profile = flags.flags.profile;
  if (typeof profile === "string") {
    if (!isSandboxProfile(profile)) {
      printErr(`valet sessions new: --profile must be "headless" or "full" (got "${profile}")`);
      return ExitCode.Usage;
    }
    body.profile = profile;
  }

  const detail = await client.createSession(body);
  if (flags.json) printJson(detail);
  else printLine(detail.id);
  return ExitCode.OK;
}

async function sessionsShow(client: SessionsClient, flags: ParsedFlags): Promise<number> {
  const id = flags.rest[1];
  if (id === undefined || id === "") {
    printErr("usage: valet sessions show <id>");
    return ExitCode.Usage;
  }
  const detail = await client.getSession(id);
  if (flags.json) printJson(detail);
  else printLine(formatSessionDetail(detail));
  return ExitCode.OK;
}

/** Pure dispatch over the `sessions` subcommands, testable with a stub client. */
export async function runSessions(client: SessionsClient, flags: ParsedFlags): Promise<number> {
  switch (flags.rest[0]) {
    case "list":
      return sessionsList(client, flags.json);
    case "new":
      return sessionsNew(client, flags);
    case "show":
      return sessionsShow(client, flags);
    default:
      printErr(USAGE);
      return ExitCode.Usage;
  }
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const instance = resolveInstance({
    flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined,
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });
  const client = new InstanceClient({ url: instance.url, apiKey: instance.apiKey });
  return runSessions(client, flags);
}
