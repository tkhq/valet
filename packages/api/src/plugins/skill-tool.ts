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
function renderSkillResult(
  skills: ReadonlyMap<string, SkillSource>,
  name: string,
  args: Record<string, unknown>,
): { text: string; skill?: SkillSource } {
  const skill = skills.get(name);
  if (!skill) {
    const known = [...skills.keys()].join(", ");
    return { text: `[skill_not_found] There is no skill named "${name}". Call skill again with one of: ${known}.` };
  }
  if (skill.argsSchema) {
    const validator = Compile(skill.argsSchema);
    if (!validator.Check(args)) {
      const errors = [...validator.Errors(args)]
        .map((e) => `  - ${e.instancePath || "(root)"}: ${e.message}`)
        .join("\n");
      return {
        text: `[skill_bad_args] The arguments for skill "${name}" are not valid. Correct them and call skill again:\n${errors}`,
      };
    }
  }
  return { text: renderTemplate(skill.content, args), skill };
}

/**
 * The part of an engine `Session` the `skill` tool reads once the host binds
 * it. The session re-reads `skills` at the start of each turn
 * (`Session.refreshSkills`), so a bound tool always describes and serves the
 * set the session holds now.
 */
export interface SkillToolSession {
  readonly skills: ReadonlyMap<string, SkillSource>;
  refreshSkills(): Promise<void>;
}

/**
 * Builds the `skill` ToolDef over an assembled plugin set's skills.
 * Returns `null` when the set ships no skills — a tool that can list
 * nothing is worse than no tool.
 *
 * `session` returns the session that carries this tool, once the host has
 * built it and bound it (`PluginSessionExtras.bindSession`). Until then, and
 * for a caller that never binds, the tool serves the `skills` it was built
 * with. The description is a getter: the engine rebuilds its tool list each
 * turn and reads the description then, so a bound tool lists the skills of
 * that turn, not of the session build.
 *
 * Callers must resolve duplicate names BEFORE this point: `collectSkills`
 * rejects two plugins that claim one name, and `pluginSessionExtras` drops
 * a stored skill that shadows a plugin's. A duplicate that reaches here
 * means one of those guards was bypassed, and the name index below would
 * quietly keep the last one — serving one skill's body under another's
 * name. It throws instead.
 */
export function buildSkillTool(
  skills: SkillSource[],
  session: () => SkillToolSession | undefined = () => undefined,
): ToolDef | null {
  if (skills.length === 0) return null;
  const builtWith = new Map<string, SkillSource>();
  for (const skill of skills) {
    if (builtWith.has(skill.name)) {
      throw new Error(
        `Two skills are named "${skill.name}". Deduplicate the skills before you build the skill tool.`,
      );
    }
    builtWith.set(skill.name, skill);
  }
  const current = (): ReadonlyMap<string, SkillSource> => session()?.skills ?? builtWith;

  return defineTool({
    name: SKILL_TOOL_NAME,
    get description() {
      return describeSkills([...current().values()]);
    },
    parameters: skillParameters,
    riskLevel: "low",
    protectedFromPruning: true,
    execute: async (args, ctx): Promise<ToolResult> => {
      // A skill saved earlier in this same turn is not in the turn-start
      // read. Re-read the session's skills once before answering that a
      // name does not exist. A failed read answers from the previous set.
      const bound = session();
      if (bound && !bound.skills.has(args.name)) {
        try {
          await bound.refreshSkills();
        } catch (err) {
          console.error(`skill tool: skill refresh failed while looking up "${args.name}":`, err);
        }
      }
      const rendered = renderSkillResult(current(), args.name, args.args ?? {});
      if (rendered.skill && ctx.recordSkillInvocation) {
        await ctx.recordSkillInvocation(rendered.skill, "model_tool", rendered.text);
      }
      return { text: rendered.text };
    },
  });
}
