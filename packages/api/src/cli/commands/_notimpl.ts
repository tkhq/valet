/**
 * Placeholder command target for subcommands that are declared in the
 * dispatch table but not yet built (later tasks). Prints
 * `"<cmd>: not implemented yet"` to stderr and exits 2.
 */
import { ExitCode } from "../exit.js";
import { printErr } from "../output.js";
import type { CliContext } from "../types.js";

export function run(_args: string[], ctx: CliContext): number {
  printErr(`${ctx.command}: not implemented yet`);
  return ExitCode.Usage;
}
