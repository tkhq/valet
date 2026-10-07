/**
 * `valet mcp setup [claude-code] [--print]` — wire a local agent (Claude Code
 * today) to the instance's `/mcp` endpoint in one command.
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
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine } from "../output.js";
import { resolveInstance } from "../resolve.js";
import type { CliContext } from "../types.js";

/** A single Claude Code MCP server entry (streamable-HTTP transport). */
export interface McpServerEntry {
  type: "http";
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
  "In Claude Code, run /mcp and choose Authenticate if the browser does not open. " +
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

const USAGE = `usage: valet mcp setup [claude-code] [options]

Wire a local agent to this instance's /mcp endpoint.

Arguments:
  setup                Provision MCP config for a local agent
  [claude-code]        Target agent (default: claude-code)

Options:
  --print              Emit the config JSON to stdout (any agent); write nothing
  --token <bearer>     Explicit MCP OAuth bearer token to embed
  --name <serverName>  MCP server name (default: valet)
  --instance <profile> Instance profile to target`;

/** The one supported target agent today. */
const KNOWN_AGENTS = new Set<string>(["claude-code"]);

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const sub = flags.rest[0];

  if (sub !== "setup") {
    printErr(USAGE);
    return ExitCode.Usage;
  }

  const agent = flags.rest[1] ?? "claude-code";
  if (!KNOWN_AGENTS.has(agent)) {
    printErr(`mcp: unknown agent "${agent}" (supported: claude-code)`);
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

  // `--print`: universal path — emit config to stdout for any agent, write
  // nothing. Keep stdout pure JSON; the sign-in note goes to stderr.
  if (flags.flags.print === true) {
    printJson(config);
    if (token === undefined) printErr(OAUTH_NOTE);
    return ExitCode.OK;
  }

  // `setup claude-code`: merge into a project-local `.mcp.json` in cwd. Claude
  // Code reads a project-scoped `.mcp.json`, so this is safer than mutating the
  // global `~/.claude.json` — it's scoped to the repo and easy to inspect/undo.
  const target = resolve(process.cwd(), ".mcp.json");
  const entry = config.mcpServers[name];
  // A real --token in the file → owner-only perms; a URL-only entry stays default.
  writeClaudeCodeConfig(target, name, entry, defaultFsSeam, { secret: token !== undefined });

  printLine(`wrote MCP server "${name}" → ${target}`);
  printLine(`endpoint: ${entry.url}`);
  if (token === undefined) {
    printLine("");
    printLine(OAUTH_NOTE);
  }
  return ExitCode.OK;
}
