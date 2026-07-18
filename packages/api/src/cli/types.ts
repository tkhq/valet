/**
 * Shared CLI types. Command modules under `cli/commands/` export a
 * `run(args, ctx)` matching `CommandModule`; the dispatcher builds the
 * `CliContext` and invokes it.
 */
import type { ValetConfig } from "./config.js";

export interface CliContext {
  /** The invoked subcommand name (e.g. "sessions"). */
  command: string;
  /** The loaded config file contents (`{}` when absent). */
  config: ValetConfig;
}

/** A command module: an exported `run` returning the process exit code. */
export interface CommandModule {
  run(args: string[], ctx: CliContext): Promise<number> | number;
}
