import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { VALET_VERSION } from "../version.js";
import { parseGlobalFlags } from "./output.js";

const invocation = new AsyncLocalStorage<{ id: string; command: string }>();
const SUBCOMMANDS: Record<string, readonly string[]> = {
  threads: ["list", "new", "show"], sessions: ["list", "new", "show"],
  gates: ["list", "resolve"], tools: ["search", "describe", "call"],
  prebuild: ["plan", "build"],
  mcp: ["setup"], instance: ["list", "use"],
};

/** Only command words enter headers. Positional arguments can contain secrets. */
export function cliCommandPath(command: string, args: string[]): string {
  const sub = parseGlobalFlags(args).rest[0];
  return sub && SUBCOMMANDS[command]?.includes(sub) ? `${command} ${sub}` : command;
}

export function withCliInvocation<T>(command: string, args: string[], run: () => T): T {
  return invocation.run({ id: randomUUID(), command: cliCommandPath(command, args) }, run);
}

export function cliTelemetryHeaders(): Record<string, string> {
  const current = invocation.getStore();
  return current ? {
    "x-valet-cli-invocation": current.id,
    "x-valet-cli-command": current.command,
    "x-valet-cli-version": VALET_VERSION,
  } : {};
}
