/**
 * `valet mcp setup [claude-code|codex|cursor] [--print]` — wire a local agent
 * to the instance's `/mcp` endpoint in one command.
 *
 * - `claude-code`: `claude mcp add --scope user`, so Valet is available in
 *   every project and no config file lands in a repository. `--project`
 *   writes `./.mcp.json` instead.
 * - `codex`: `codex mcp add <name> --url <endpoint>`. Sign in with
 *   `codex mcp login <name>`.
 * - `cursor`: merges the server into `~/.cursor/mcp.json`.
 *
 * `/mcp` auth is OAuth, not `x-api-key`. The endpoint is mounted only when
 * the instance runs real auth, and it 401s with a `WWW-Authenticate` header
 * that names the instance's OAuth protected-resource metadata. The instance
 * also supports dynamic client registration. An MCP client that implements
 * the MCP authorization spec (Claude Code does) therefore signs in by
 * itself: it opens the browser login on first connect and stores the token.
 *
 * So without `--token` this command writes the endpoint with no headers.
 * With `--token <bearer>` it embeds `Authorization: Bearer <token>` for a
 * client that cannot run the OAuth flow, and writes the file `0600`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { ConfigError, ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine } from "../output.js";
import { resolveInstance } from "../resolve.js";
import type { CliContext } from "../types.js";

/** A single MCP server entry (streamable-HTTP transport). Cursor reads `url` without `type`. */
export interface McpServerEntry {
  type?: "http";
  url: string;
  headers?: { Authorization: string };
}

/** The Claude Code MCP config document shape (partial — we only own `mcpServers`). */
export interface ClaudeCodeMcpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/** How the client authenticates when no token is embedded. */
const OAUTH_NOTE =
  "note: the client signs in through the instance's OAuth flow the first time it connects. " +
  "In Claude Code, restart it, run /mcp, and choose Authenticate. In Codex, run `codex mcp login valet`. " +
  "Your valet API key does not work here. The /mcp endpoint needs an instance with real auth configured.";

export interface BuildConfigInput {
  /** The instance base URL (any trailing slashes are stripped). */
  url: string;
  /** The MCP server name (map key under `mcpServers`). */
  name: string;
  /** An explicit bearer token. Omit it to let the client run the OAuth flow. */
  token?: string;
}

/**
 * Pure builder for the Claude Code MCP server config. Computes the endpoint as
 * `<instanceUrl>/mcp` (stripping any trailing slashes on the base) and emits a
 * streamable-HTTP server entry. The entry carries an `Authorization` header
 * only for an explicit token.
 */
export function buildMcpServerConfig(input: BuildConfigInput): ClaudeCodeMcpConfig {
  const base = input.url.replace(/\/+$/, "");
  const endpoint = `${base}/mcp`;
  return {
    mcpServers: {
      [input.name]: {
        type: "http",
        url: endpoint,
        ...(input.token !== undefined ? { headers: { Authorization: `Bearer ${input.token}` } } : {}),
      },
    },
  };
}

/** Injectable filesystem seam so tests never touch the user's real config. */
export interface FsSeam {
  /** Return the file contents, or `undefined` if the file does not exist. */
  readFile(path: string): string | undefined;
  /** Write the file contents. `secret` → owner-only perms (0600). */
  writeFile(path: string, content: string, opts?: { secret?: boolean }): void;
}

/** The default fs seam over `node:fs` (returns `undefined` on a missing file). */
export const defaultFsSeam: FsSeam = {
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writeFile: (path, content, opts) => {
    mkdirSync(dirname(path), { recursive: true });
    if (opts?.secret) {
      // `mode` only applies at creation — chmod too, so a pre-existing looser
      // file gets tightened (same treatment as config.ts saveConfig).
      writeFileSync(path, content, { mode: 0o600 });
      chmodSync(path, 0o600);
    } else {
      writeFileSync(path, content);
    }
  },
};

/** Runs an agent's own CLI. Injectable so tests never start a real process. */
export type ExecSeam = (cmd: string, args: string[]) => { status: number | null; output: string };

const defaultExec: ExecSeam = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  // A missing binary sets `error` (ENOENT) and a null status.
  return { status: res.error ? null : res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge a single MCP server entry into a Claude Code config FILE, preserving
 * every other server and top-level key. On a missing file we start fresh; on
 * malformed existing JSON we throw a `ConfigError` rather than clobber the
 * user's file. The fs access is injected via `fs` so tests use a temp path.
 *
 * `opts.secret` → the write is 0600. Only set when the entry embeds a REAL
 * bearer token (`--token`): `.mcp.json` is a project-local file that users
 * legitimately commit/share when it carries only the endpoint URL.
 */
export function writeClaudeCodeConfig(
  path: string,
  serverName: string,
  entry: McpServerEntry,
  fs: FsSeam = defaultFsSeam,
  opts?: { secret?: boolean },
): void {
  const existing = fs.readFile(path);

  let doc: Record<string, unknown>;
  if (existing === undefined || existing.trim() === "") {
    doc = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`mcp: ${path} is not valid JSON (${detail}). Refusing to overwrite it.`);
    }
    if (!isRecord(parsed)) {
      throw new ConfigError(`mcp: ${path} is not a JSON object. Refusing to overwrite it.`);
    }
    doc = parsed;
  }

  const servers: Record<string, unknown> = isRecord(doc.mcpServers) ? doc.mcpServers : {};
  servers[serverName] = entry;
  doc.mcpServers = servers;

  fs.writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { secret: opts?.secret === true });
}

const USAGE = `usage: valet mcp setup [claude-code|codex|cursor] [options]

Wire a local agent to this instance's /mcp endpoint.

Arguments:
  setup                Provision MCP config for a local agent
  [agent]              claude-code (default), codex, or cursor

Options:
  --project            claude-code: write ./.mcp.json instead of user scope
  --print              Emit the config JSON to stdout (any agent); write nothing
  --token <bearer>     Explicit MCP OAuth bearer token to embed (writes ./.mcp.json)
  --name <serverName>  MCP server name (default: valet)
  --instance <profile> Instance profile to target`;

const KNOWN_AGENTS = new Set<string>(["claude-code", "codex", "cursor"]);

export interface McpDeps {
  exec: ExecSeam;
  fs: FsSeam;
  cwd: string;
  home: string;
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runMcp({ exec: defaultExec, fs: defaultFsSeam, cwd: process.cwd(), home: homedir() }, args, ctx);
}

export async function runMcp(deps: McpDeps, args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const sub = flags.rest[0];

  if (sub !== "setup") {
    printErr(USAGE);
    return ExitCode.Usage;
  }

  const agent = flags.rest[1] ?? "claude-code";
  if (!KNOWN_AGENTS.has(agent)) {
    printErr(`mcp: unknown agent "${agent}" (supported: claude-code, codex, cursor)`);
    printErr(USAGE);
    return ExitCode.Usage;
  }

  const instance = resolveInstance({
    flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined,
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });

  const name = typeof flags.flags.name === "string" ? flags.flags.name : "valet";
  const token = typeof flags.flags.token === "string" ? flags.flags.token : undefined;
  const config = buildMcpServerConfig({ url: instance.url, name, token });
  const entry = config.mcpServers[name];

  // `--print`: universal path — emit config to stdout for any agent, write
  // nothing. Keep stdout pure JSON; the sign-in note goes to stderr.
  if (flags.flags.print === true) {
    printJson(config);
    if (token === undefined) printErr(OAUTH_NOTE);
    return ExitCode.OK;
  }

  if (agent === "codex") {
    // Replace an older entry under the same name; a missing one is fine.
    deps.exec("codex", ["mcp", "remove", name]);
    const added = deps.exec("codex", ["mcp", "add", name, "--url", entry.url]);
    if (added.status !== 0) {
      printErr(added.status === null
        ? "mcp: the codex command was not found. Install Codex, or add this server to ~/.codex/config.toml yourself:"
        : `mcp: codex mcp add failed: ${added.output}`);
      printErr(`  [mcp_servers.${name}]\n  url = "${entry.url}"`);
      return ExitCode.Failure;
    }
    printLine(`added MCP server "${name}" to Codex → ${entry.url}`);
    printLine(`Sign in: run \`codex mcp login ${name}\`, then choose Allow in the browser.`);
    return ExitCode.OK;
  }

  if (agent === "cursor") {
    const target = resolve(deps.home, ".cursor", "mcp.json");
    writeClaudeCodeConfig(target, name, { url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) }, deps.fs, { secret: token !== undefined });
    printLine(`wrote MCP server "${name}" → ${target}`);
    printLine("Cursor signs in to Valet the first time it connects. If it does not, open Cursor Settings > MCP and sign in to valet.");
    return ExitCode.OK;
  }

  // claude-code. A token, or --project, writes ./.mcp.json in the project.
  if (token !== undefined || flags.flags.project === true) {
    const target = resolve(deps.cwd, ".mcp.json");
    // A real --token in the file → owner-only perms; a URL-only entry stays default.
    writeClaudeCodeConfig(target, name, entry, deps.fs, { secret: token !== undefined });
    printLine(`wrote MCP server "${name}" → ${target}`);
    printLine(`endpoint: ${entry.url}`);
    if (token === undefined) {
      printLine("");
      printLine(OAUTH_NOTE);
    }
    return ExitCode.OK;
  }
  // User scope: every project sees it, and no file lands in a repository.
  deps.exec("claude", ["mcp", "remove", "--scope", "user", name]);
  const added = deps.exec("claude", ["mcp", "add", "--transport", "http", "--scope", "user", name, entry.url]);
  if (added.status !== 0) {
    printErr(added.status === null
      ? "mcp: the claude command was not found. Run this in a terminal where Claude Code is installed:"
      : `mcp: claude mcp add failed: ${added.output}`);
    printErr(`  claude mcp add --transport http --scope user ${name} ${entry.url}`);
    printErr("Or run `valet mcp setup claude-code --project` to write ./.mcp.json.");
    return ExitCode.Failure;
  }
  printLine(`added MCP server "${name}" to Claude Code (user scope) → ${entry.url}`);
  printLine("Sign in: restart Claude Code, run /mcp, choose valet, and choose Authenticate.");
  return ExitCode.OK;
}
