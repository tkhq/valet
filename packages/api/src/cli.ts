/**
 * `valet` CLI entry point / dispatcher.
 *
 * `valet serve` boots the full product; every other subcommand is a client
 * of a running instance. All command modules — and the TUI/prompt/client
 * deps they pull in — are loaded via DYNAMIC import so `serve` pays nothing
 * for them.
 *
 * This module is the bundle entry (see `build.mjs`). Importing it must not
 * have side effects beyond running `main()` at the bottom.
 */
import { loadConfig } from "./cli/config.js";
import { CliError, ExitCode } from "./cli/exit.js";
import { printErr, printLine } from "./cli/output.js";
import type { CommandModule } from "./cli/types.js";
import { VALET_VERSION } from "./version.js";

/**
 * Lazy importer for a command module. Registering a real command later is a
 * one-line change: swap the `_notimpl` importer for the real module's.
 */
type CommandImporter = () => Promise<CommandModule>;

const notImpl: CommandImporter = () => import("./cli/commands/_notimpl.js");

/**
 * The subcommand dispatch table. `serve` is handled separately (it boots the
 * product via `./main.js` rather than a `run(args, ctx)` client command).
 *
 * Every entry is a lazy importer so unrelated deps stay off the `serve`
 * path. Commands not yet built point at `_notimpl`; later tasks replace the
 * importer with the real module (which must export `run(args, ctx)`).
 */
const COMMANDS: Record<string, CommandImporter> = {
  sessions: notImpl,
  send: notImpl,
  gates: notImpl,
  status: notImpl,
  login: notImpl,
  logout: notImpl,
  instance: notImpl,
  config: notImpl,
  chat: notImpl,
  mcp: notImpl,
  reset: notImpl,
};

const USAGE = `valet <command> [options]

Commands:
  serve       Boot the Valet server (the full product)
  sessions    List and inspect sessions on an instance
  send        Send a prompt to a session
  gates       List and resolve decision gates
  status      Show instance / session status
  login       Add or authenticate an instance profile
  logout      Remove an instance profile
  instance    Manage instance profiles
  config      View or edit CLI config
  chat        Interactive chat with a session
  mcp         MCP client operations
  reset       Reset local state

Global options:
  --json          Machine-readable JSON output (where supported)
  --instance <n>  Select an instance profile
  -h, --help      Show this help
  -V, --version   Show the CLI version`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  // No subcommand → usage to stderr, exit 2.
  if (first === undefined) {
    printErr(USAGE);
    return ExitCode.Usage;
  }

  // Global help / version, only when they are the leading token.
  if (first === "--help" || first === "-h") {
    printLine(USAGE);
    return ExitCode.OK;
  }
  if (first === "--version" || first === "-V") {
    printLine(VALET_VERSION);
    return ExitCode.OK;
  }

  const rest = argv.slice(1);

  // `serve` boots the product. TEMPORARY: main.ts self-boots on import today,
  // so importing it here starts the server exactly as before.
  // TODO(T5): refactor main.ts into an exported `startServer()` and give
  // `serve` real flags + sandbox detection; then call that instead.
  if (first === "serve") {
    await import("./main.js");
    // main.js keeps the process alive (server listening); this return is
    // effectively unreached, but keeps the control flow well-typed.
    return ExitCode.OK;
  }

  const importer = COMMANDS[first];
  if (importer === undefined) {
    printErr(`unknown command: ${first}\n`);
    printErr(USAGE);
    return ExitCode.Usage;
  }

  const config = loadConfig();
  const mod = await importer();
  return await mod.run(rest, { command: first, config });
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    printErr(message);
    process.exit(err instanceof CliError ? err.exitCode : 1);
  });
