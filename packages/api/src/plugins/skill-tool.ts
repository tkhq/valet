/**
 * The `skill` tool — how an assembled plugin set's markdown skills reach
 * the model.
 *
 * Skills are progressive disclosure: the tool description carries only the
 * name and the one-line summary of each skill, and the full body arrives
 * only when the model asks for it. That keeps eleven playbooks off every
 * turn's prompt while leaving all of them reachable.
 *
 * `"skill"` is in the engine's `DEFAULT_PROTECTED_TOOLS`, and the ToolDef
 * sets `protectedFromPruning` — a skill body the model asked for must
 * survive compaction, or the turn loses the instructions it is following.
 *
 * This is a plain `ToolDef` built in the API layer. The engine needs no
 * change: `Thread.skill()` remains the host-side entry point for invoking
 * a skill as a new prompt, while this tool serves the model's own
 * mid-turn request.
 */
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { renderTemplate } from "@valet/engine";
import type { SkillSource, ToolDef, ToolResult } from "@valet/engine";

export const SKILL_TOOL_NAME = "skill";

/** Preserves the schema's static type through the ToolDef so `args` in
 * `execute` is typed precisely instead of `unknown` (same idiom as
 * `orchestrator/memory-tools.ts` — the engine's own `defineTool` is not
 * exported). */
function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

const skillParameters = Type.Object({
  name: Type.String({
    description: "Name of the skill to read. Use one of the names listed in this tool's description.",
  }),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Values for the skill's placeholders. Supply these only for a skill whose description says it takes arguments.",
    }),
  ),
});

/**
 * Builds the tool description: the instruction, then one line per skill.
 * The model can only ask for a skill it can see, so every installed skill
 * is named here.
 */
function describeSkills(skills: SkillSource[]): string {
  const lines = skills.map((skill) => {
    const summary = skill.description ? ` — ${skill.description}` : "";
    const args = skill.argsSchema ? " (takes arguments)" : "";
    return `- ${skill.name}${args}${summary}`;
  });
  return [
    "Read an installed skill: a playbook with detailed instructions for one integration or task.",
    "Call this before you use an integration's tools for the first time in a turn.",
    "",
    "Available skills:",
    ...lines,
  ].join("\n");
}

/**
 * Renders one skill for the model. Returns tool TEXT for every outcome,
 * including failures — a thrown error would abort the turn, while text
 * lets the model correct itself and call again.
 */
export function renderSkill(
  skills: Map<string, SkillSource>,
  name: string,
  args: Record<string, unknown>,
): string {
  const skill = skills.get(name);
  if (!skill) {
    const known = [...skills.keys()].join(", ");
    return `[skill_not_found] There is no skill named "${name}". Call skill again with one of: ${known}.`;
  }
  if (skill.argsSchema) {
    const validator = Compile(skill.argsSchema);
    if (!validator.Check(args)) {
      const errors = [...validator.Errors(args)]
        .map((e) => `  - ${e.instancePath || "(root)"}: ${e.message}`)
        .join("\n");
      return `[skill_bad_args] The arguments for skill "${name}" are not valid. Correct them and call skill again:\n${errors}`;
    }
  }
  return renderTemplate(skill.content, args);
}

/**
 * Builds the `skill` ToolDef over an assembled plugin set's skills.
 * Returns `null` when the set ships no skills — a tool that can list
 * nothing is worse than no tool.
 *
 * Callers must resolve duplicate names BEFORE this point: `collectSkills`
 * rejects two plugins that claim one name, and `pluginSessionExtras` drops
 * a stored skill that shadows a plugin's. A duplicate that reaches here
 * means one of those guards was bypassed, and the name index below would
 * quietly keep the last one — serving one skill's body under another's
 * name. It throws instead.
 */
export function buildSkillTool(skills: SkillSource[]): ToolDef | null {
  if (skills.length === 0) return null;
  const byName = new Map<string, SkillSource>();
  for (const skill of skills) {
    if (byName.has(skill.name)) {
      throw new Error(
        `Two skills are named "${skill.name}". Deduplicate the skills before you build the skill tool.`,
      );
    }
    byName.set(skill.name, skill);
  }

  return defineTool({
    name: SKILL_TOOL_NAME,
    description: describeSkills(skills),
    parameters: skillParameters,
    riskLevel: "low",
    protectedFromPruning: true,
    execute: async (args): Promise<ToolResult> => ({
      text: renderSkill(byName, args.name, args.args ?? {}),
    }),
  });
}
