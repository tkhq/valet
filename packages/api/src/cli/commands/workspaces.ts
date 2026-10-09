/** `valet workspaces` — see `whoami.ts`. */
import { runWithClient } from "../command-kit.js";
import type { CliContext } from "../types.js";
import { runWorkspaces } from "./whoami.js";

export async function run(args: string[], ctx: CliContext): Promise<number> {
  return runWithClient(args, ctx, runWorkspaces);
}
