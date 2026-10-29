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
 * sets `protectedFromPruning` for body reads. Path reads are pruneable. A skill body the model asked for must
 * survive compaction, or the turn loses the instructions it is following.
 *
 * This is a plain `ToolDef` built in the API layer. The engine needs no
 * change: `Thread.skill()` remains the host-side entry point for invoking
 * a skill as a new prompt, while this tool serves the model's own
 * mid-turn request.
 */
import { validSkillPath } from "../services/content-sync/skill-files.js";
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { isPlaybook, playbookSeedNote, renderTemplate, skillFileManifest } from "@valet/engine";
import type { SkillSource, ToolDef, ToolResult } from "@valet/engine";

export const SKILL_TOOL_NAME = "skill";
const MAX_REFERENCE_BYTES = 64 * 1024;

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
  path: Type.Optional(Type.String({ description: "Path of a stored text file, relative to the skill directory. Omit this to read SKILL.md." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based byte offset for a path read. Default 0. Must start at a UTF-8 character boundary." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_REFERENCE_BYTES, description: "Maximum bytes returned by a path read. Default and maximum 65536." })),
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
    const playbook = isPlaybook(skill) ? " (playbook)" : "";
    return `- ${skill.name}${playbook}${args}${summary}`;
  });
  return [
    "Read an installed skill: a playbook with detailed instructions for one integration or task.",
    "Call this before you use an integration's tools for the first time in a turn.",
    "Omit path to read the protected SKILL.md body and file manifest. Path reads are not protected from pruning.",
    "Read references with path, offset (byte offset, default 0), and limit (bytes, default and maximum 65536).",
    "Pages end at UTF-8 character boundaries. The footer reports total_bytes, next_offset, and end. Use next_offset to continue.",
    "Reading a (playbook) skill sets this thread's plan to its steps, unless the thread has an open plan.",
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
async function renderSkillResult(
  skills: ReadonlyMap<string, SkillSource>,
  name: string,
  args: Record<string, unknown>,
  path?: string,
  offset = 0,
  limit = MAX_REFERENCE_BYTES,
): Promise<{ text: string; skill?: SkillSource }> {
  const skill = skills.get(name);
  if (!skill) {
    const known = [...skills.keys()].join(", ");
    return { text: `[skill_not_found] There is no skill named "${name}". Call skill again with one of: ${known}.` };
  }
  if (path !== undefined) {
    if (!validSkillPath(path)) return { text: "[skill_bad_path] Use a relative file path without empty, dot, or parent segments." };
    const file = skill.files?.find((file) => file.path === path);
    if (!file) return { text: `[skill_file_not_found] There is no stored file "${path}". Read skill({ name: "${name}" }) to see its files.` };
    const bytes = file.bytes ?? await skill.readFile?.(file);
    if (!bytes) return { text: "[skill_file_unavailable] The stored file changed or was removed. Read the skill again to refresh its manifest." };
    const text = skillFileText(bytes);
    if (text === null) return { text: "[skill_binary_file] This file is binary. Choose a text file from the skill manifest." };
    if (offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80) {
      return { text: "[skill_bad_range] Offset splits a UTF-8 character. Use the next byte offset from the previous page." };
    }
    let end = Math.min(bytes.byteLength, offset + limit);
    while (end > offset && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === offset && offset < bytes.byteLength) {
      return { text: "[skill_bad_range] Limit is too small for the next UTF-8 character. Increase limit to at least 4 bytes." };
    }
    return { text: new TextDecoder().decode(bytes.subarray(offset, end)) +
      `\n\n[total_bytes=${bytes.byteLength} next_offset=${Math.min(end, bytes.byteLength)} end=${end >= bytes.byteLength}]`, skill };
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
  return { text: renderTemplate(skill.content, args) + skillFileManifest(skill), skill };
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
 * Returns `null` only for an empty static set. A session-bound tool stays
 * available so its first saved skill can appear without a runtime restart.
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
  session?: () => SkillToolSession | undefined,
): ToolDef | null {
  if (skills.length === 0 && !session) return null;
  const builtWith = new Map<string, SkillSource>();
  for (const skill of skills) {
    if (builtWith.has(skill.name)) {
      throw new Error(
        `Two skills are named "${skill.name}". Deduplicate the skills before you build the skill tool.`,
      );
    }
    builtWith.set(skill.name, skill);
  }
  const current = (): ReadonlyMap<string, SkillSource> => session?.()?.skills ?? builtWith;

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
      const bound = session?.();
      if (bound && !bound.skills.has(args.name)) {
        try {
          await bound.refreshSkills();
        } catch (err) {
          console.error(`skill tool: skill refresh failed while looking up "${args.name}":`, err);
        }
      }
      if (args.path === undefined && (args.offset !== undefined || args.limit !== undefined)) {
        return { text: "[skill_bad_range] Supply path when using offset or limit." };
      }
      let rendered;
      try { rendered = await renderSkillResult(current(), args.name, args.args ?? {}, args.path, args.offset, args.limit); }
      catch { return { text: args.path === undefined
        ? "[skill_body_unavailable] The skill body could not be rendered. Check the skill arguments, then retry."
        : "[skill_file_unavailable] The stored file could not be read. Retry the skill call." }; }
      if (rendered.skill && ctx.recordSkillInvocation) {
        await ctx.recordSkillInvocation(rendered.skill, args.path === undefined ? "model_tool" : "file_read", rendered.text);
      }
      if (rendered.skill && args.path === undefined && isPlaybook(rendered.skill)) {
        const seed = ctx.seedPlaybookPlan ? await ctx.seedPlaybookPlan(rendered.skill) : { kind: "unavailable" as const };
        return { text: `${rendered.text}\n\n${playbookSeedNote(rendered.skill.name, seed)}` };
      }
      return { text: rendered.text };
    },
  });
}

/** Text references must be valid UTF-8 without binary control bytes. */
export function skillFileText(bytes: Uint8Array): string | null {
  if (bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
