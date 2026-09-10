import { buildSkillBlock } from "@valet/shared";
import { parseCommandArgs, substituteArgs } from "./args.js";
import type { CommandRegistry } from "./registry.js";
import type { SkillSource } from "../types.js";
import type { ResolvedCommand } from "./types.js";

export type DispatchOutcome =
  | { kind: "pass"; nearMiss?: string }
  | {
      kind: "expand";
      text: string;
      /**
       * Identifies either skill expansion for telemetry. Context skills also
       * use the raw args to render a skill card. Prompt skills render as prose.
       */
      skill?: { source: SkillSource; args: string; path: "slash_context" | "slash_prompt" };
    }
  | { kind: "execute"; resolved: ResolvedCommand; args: string[]; raw: string };

/**
 * Dispatch a text input against a command registry.
 *
 * - Plain text (no leading `/`): pass through.
 * - Unknown `/word`: pass through with an optional near-miss hint.
 * - Context-invocation skill: expand to a `<skill>` block with raw args appended.
 * - Prompt-invocation skill: expand by substituting positional args into the body.
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
      if (skill.invocation === "prompt") {
        const args = parseCommandArgs(raw);
        return {
          kind: "expand",
          text: substituteArgs(skill.content, args),
          skill: { source: skill, args: raw, path: "slash_prompt" },
        };
      }
      return {
        kind: "expand",
        text: buildSkillBlock(skill.name, skill.content, raw),
        skill: { source: skill, args: raw, path: "slash_context" },
      };
    }

    case "builtin":
    case "plugin": {
      const args = parseCommandArgs(raw);
      return { kind: "execute", resolved, args, raw };
    }
  }
}
