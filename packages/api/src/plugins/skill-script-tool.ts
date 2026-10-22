import { posix } from "node:path";
import { Type, type TSchema } from "typebox";
import { bashTool, type SkillSource, type ToolDef, type ToolResult } from "@valet/engine";
import { skillWithFilesSha, validSkillPath } from "../services/content-sync/skill-files.js";
import type { SkillToolSession } from "./skill-tool.js";

export const SKILL_SCRIPT_TOOL_NAME = "skill_script";
const OUTPUT_BYTES = 32 * 1024;

function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

/** Quote each argument separately. Script arguments are never shell source. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function interpreter(bytes: Uint8Array, path: string): string[] {
  const first = new TextDecoder().decode(bytes).split(/\r?\n/, 1)[0] ?? "";
  if (first.startsWith("#!")) {
    const match = /^#!\s*(\S+)(?:\s+(.*?))?\s*$/.exec(first);
    if (match?.[1]) return match[2] ? [match[1], match[2]] : [match[1]];
  }
  if (path.endsWith(".py")) return ["python3"];
  if (path.endsWith(".sh")) return ["bash"];
  if (path.endsWith(".js") || path.endsWith(".mjs")) return ["node"];
  return [];
}

export function buildSkillScriptTool(
  skills: SkillSource[],
  session?: () => SkillToolSession | undefined,
): ToolDef {
  const builtWith = new Map(skills.map((skill) => [skill.name, skill]));
  return defineTool({
    name: SKILL_SCRIPT_TOOL_NAME,
    description: "Run a stored script from an installed skill. This writes only the skill's scripts/ files to a content-addressed sandbox directory. " +
      "The script runs in your normal working directory. SKILL_DIR names the stored skill directory. References and assets are not written. " +
      "The result includes the script path, exit code, stdout, and stderr. You can reuse that path in bash.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the installed skill that owns the script." }),
      script: Type.String({ description: "Stored script path relative to the skill directory. The path must start with scripts/." }),
      args: Type.Optional(Type.Array(Type.String({ description: "One argument passed to the script without shell interpolation." }))),
    }),
    // Use the same approval policy as bash, including its default risk level.
    riskLevel: bashTool.riskLevel,
    execute: async (args, ctx): Promise<ToolResult> => {
      const bound = session?.();
      if (bound && !bound.skills.has(args.name)) {
        try { await bound.refreshSkills(); } catch (err) { console.error("skill_script: skill refresh failed:", err); }
      }
      const skill = (bound?.skills ?? builtWith).get(args.name);
      if (!skill) return { text: "[skill_not_found] Choose an installed skill. Call skill to see its files." };
      if (!validSkillPath(args.script) || !args.script.startsWith("scripts/")) {
        return { text: "[skill_bad_path] Choose a stored scripts/ file. Use a relative path without dot or parent segments." };
      }
      const script = skill.files?.find((file) => file.path === args.script);
      if (!script) return { text: "[skill_file_not_found] Choose a script from the skill manifest. Call skill to see its files." };
      if (!ctx.sandbox) return { text: "[skill_no_sandbox] This session has no sandbox. Run the script in a session with a sandbox." };
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) {
        return { text: "[skill_bad_name] Use a skill with a lowercase name containing letters, digits, and single hyphens." };
      }
      try {
        const sandbox = ctx.sandbox;
        const home = await sandbox.exec('printf "%s" "$HOME"', { signal: ctx.signal, maxOutputBytes: 4096 });
        if (home.exitCode !== 0 || !posix.isAbsolute(home.stdout) || home.stdout.includes("\0")) {
          return { text: "[skill_script_failed] The sandbox has no absolute home directory. Set HOME, then call skill_script again." };
        }
        const sha = skillWithFilesSha(skill.content, skill.files ?? []);
        const directory = posix.join(home.stdout, ".valet", "skills", `${skill.name}@${sha}`);
        const marker = `${directory}/.scripts-ready`;
        const ready = await sandbox.exec(`test -d ${quote(marker)}`, { signal: ctx.signal });
        if (ready.exitCode !== 0) {
          for (const file of skill.files ?? []) {
            if (!file.path.startsWith("scripts/") || !validSkillPath(file.path)) continue;
            const path = `${directory}/${file.path}`;
            await sandbox.mkdir(posix.dirname(path));
            await sandbox.writeBinary(path, file.bytes);
            const mode = file.mode === "100755" ? "755" : "644";
            const chmod = await sandbox.exec(`chmod ${mode} ${quote(path)}`, { signal: ctx.signal });
            if (chmod.exitCode !== 0) throw new Error(`Cannot set script permissions: ${chmod.stderr}`);
          }
          await sandbox.mkdir(marker);
        }
        const path = `${directory}/${args.script}`;
        const command = [...interpreter(script.bytes, path), path, ...(args.args ?? [])].map(quote).join(" ");
        const result = await sandbox.exec(command, {
          cwd: ctx.cwd, env: { SKILL_DIR: directory }, signal: ctx.signal,
          timeout: 120_000, maxOutputBytes: OUTPUT_BYTES,
        });
        const bounded = (text: string) => Buffer.from(text).subarray(0, OUTPUT_BYTES).toString("utf8");
        const text = JSON.stringify({ path, exitCode: result.exitCode, stdout: bounded(result.stdout), stderr: bounded(result.stderr),
          ...(result.timedOut ? { timedOut: true } : {}),
          ...(result.truncated || Buffer.byteLength(result.stdout) > OUTPUT_BYTES || Buffer.byteLength(result.stderr) > OUTPUT_BYTES ? { truncated: true } : {}),
        });
        await ctx.recordSkillInvocation?.(skill, "script_run", text);
        return { text };
      } catch (err) {
        return { text: `[skill_script_failed] ${err instanceof Error ? err.message : String(err)}. Check the script and sandbox, then retry.` };
      }
    },
  });
}
