import { parseCommandArgs, substituteArgs } from "./args.js";
import type { CommandRegistry } from "./registry.js";
import type { ResolvedCommand } from "./types.js";

export type DispatchOutcome =
  | { kind: "pass"; nearMiss?: string }
  | { kind: "expand"; text: string }
  | { kind: "execute"; resolved: ResolvedCommand; args: string[]; raw: string };

/**
 * Dispatch a text input against a command registry.
 *
 * - Plain text (no leading `/`): pass through.
 * - Unknown `/word`: pass through with an optional near-miss hint.
 * - Skill command: expand to a `<skill>` block with optional raw args appended.
 * - Template command: expand by substituting positional args into template content.
 * - Builtin / plugin command: return an execute outcome with parsed args.
 *
 * The command token is the text up to the first whitespace (space or newline),
 * minus the leading `/`. Everything after that first whitespace char is `raw`
 * (trimmed). This means "/status\nand more" resolves "status" as the token.
 */
export function dispatchCommand(text: string, registry: CommandRegistry): DispatchOutcome {
  if (!text.startsWith("/")) {
    return { kind: "pass" };
  }

  // Split on the first whitespace character (space or newline).
  const firstWs = text.search(/[ \t\n]/);
  const token = firstWs === -1 ? text.slice(1) : text.slice(1, firstWs);
  const raw = firstWs === -1 ? "" : text.slice(firstWs + 1).trim();

  const resolved = registry.resolve(token);

  if (!resolved) {
    const nearMiss = registry.nearMiss(token);
    return nearMiss !== undefined ? { kind: "pass", nearMiss } : { kind: "pass" };
  }

  switch (resolved.source) {
    case "skill": {
      const { skill } = resolved;
      const block = `<skill name="${skill.name}">\n${skill.content.trim()}\n</skill>`;
      const text = raw ? `${block}\n\n${raw}` : block;
      return { kind: "expand", text };
    }

    case "template": {
      const { template } = resolved;
      const args = parseCommandArgs(raw);
      const expanded = substituteArgs(template.content, args);
      return { kind: "expand", text: expanded };
    }

    case "builtin":
    case "plugin": {
      const args = parseCommandArgs(raw);
      return { kind: "execute", resolved, args, raw };
    }
  }
}
