/**
 * `valet mcp setup [claude-code] [--print]` — wire a local agent (Claude Code
 * today) to the instance's `/mcp` endpoint in one command.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEVIATION / KNOWN LIMITATION — `/mcp` auth is Bearer OAuth, not `x-api-key`
 * ─────────────────────────────────────────────────────────────────────────
 * VERIFIED against `packages/api/src/app.ts`:
 *   - `/mcp` is mounted with `mcpHandler` guarded by better-auth's MCP OAuth
 *     (`withMcpAuth`): it expects `Authorization: Bearer <token>`, NOT the
 *     `x-api-key` header the other REST commands (sessions/send/gates/status)
 *     use.
 *   - `/mcp` is ONLY mounted when real auth is configured (the `auth` object
 *     is present). Under the local stub (`VALET_LOCAL_AUTH=1`) it is not
 *     mounted at all.
 *
 * The CLI / auth-v2 cannot mint an MCP bearer token yet — that requires the
 * instance's MCP OAuth handshake, which is a later task. So this command
 * PROVISIONS the correct config *shape* (streamable-HTTP transport, bearer
 * header) and documents the token requirement; it does NOT perform the OAuth
 * handshake. When the caller has a token out-of-band they can pass `--token`;
 * otherwise the header carries a clear `<MCP_OAUTH_TOKEN>` placeholder and the
 * command prints the caveat.
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
  headers: { Authorization: string };
}

/** The Claude Code MCP config document shape (partial — we only own `mcpServers`). */
export interface ClaudeCodeMcpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/** Placeholder used when no explicit bearer token is supplied. */
const TOKEN_PLACEHOLDER = "<MCP_OAUTH_TOKEN>";

/** The caveat explaining the Bearer-OAuth-vs-x-api-key deviation. */
const BEARER_CAVEAT =
  "note: the instance's /mcp endpoint requires an OAuth bearer token obtained via the " +
  "instance's MCP OAuth flow (auth-v2) — NOT the x-api-key used by other valet commands. " +
  "Replace the Authorization header's placeholder with a real token (or re-run with --token <bearer>). " +
  "The /mcp endpoint is also only available when the instance runs with real auth configured.";

export interface BuildConfigInput {
  /** The instance base URL (any trailing slashes are stripped). */
  url: string;
  /** The MCP server name (map key under `mcpServers`). */
  name: string;
  /** An explicit bearer token; a placeholder is used when omitted. */
  token?: string;
}

/**
 * Pure builder for the Claude Code MCP server config. Computes the endpoint as
 * `<instanceUrl>/mcp` (stripping any trailing slashes on the base) and emits a
 * streamable-HTTP server entry carrying an `Authorization: Bearer …` header.
 */
export function buildMcpServerConfig(input: BuildConfigInput): ClaudeCodeMcpConfig {
  const base = input.url.replace(/\/+$/, "");
  const endpoint = `${base}/mcp`;
  const bearer = input.token ?? TOKEN_PLACEHOLDER;
  return {
    mcpServers: {
      [input.name]: {
        type: "http",
        url: endpoint,
        headers: { Authorization: `Bearer ${bearer}` },
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
 * legitimately commit/share when it only carries the placeholder.
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
  // nothing. Keep stdout pure JSON; the token caveat goes to stderr.
  if (flags.flags.print === true) {
    printJson(config);
    if (token === undefined) printErr(BEARER_CAVEAT);
    return ExitCode.OK;
  }

  // `setup claude-code`: merge into a project-local `.mcp.json` in cwd. Claude
  // Code reads a project-scoped `.mcp.json`, so this is safer than mutating the
  // global `~/.claude.json` — it's scoped to the repo and easy to inspect/undo.
  const target = resolve(process.cwd(), ".mcp.json");
  const entry = config.mcpServers[name];
  // A real --token in the file → owner-only perms; placeholder-only stays default.
  writeClaudeCodeConfig(target, name, entry, defaultFsSeam, { secret: token !== undefined });

  printLine(`wrote MCP server "${name}" → ${target}`);
  printLine(`endpoint: ${entry.url}`);
  if (token === undefined) {
    printLine("");
    printLine(BEARER_CAVEAT);
  }
  return ExitCode.OK;
}
