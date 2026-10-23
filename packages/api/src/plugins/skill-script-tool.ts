import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Type, type TSchema } from "typebox";
import { bashTool, runForegroundExec, type SkillSource, type ToolDef, type ToolResult } from "@valet/engine";
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
  const newline = bytes.indexOf(10);
  const first = new TextDecoder().decode(bytes.subarray(0, Math.min(newline < 0 ? bytes.length : newline, 256))).trimEnd();
  if (first.startsWith("#!") && first.slice(2).trim()) return first.slice(2).trim().split(/\s+/);
  if (path.endsWith(".py")) return ["python3"];
  if (path.endsWith(".sh")) return ["bash"];
  if (path.endsWith(".js") || path.endsWith(".mjs")) return ["node"];
  return [];
}

export function buildSkillScriptTool(
  skills: SkillSource[],
  session?: () => SkillToolSession | undefined,
): ToolDef {
  let refreshedUnknown = false;
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
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Timeout in seconds. Default 120." })),
    }),
    // Use the same approval policy as bash, including its default risk level.
    riskLevel: bashTool.riskLevel,
    execute: async (args, ctx): Promise<ToolResult> => {
      const bound = session?.();
      if (bound && !bound.skills.has(args.name) && !refreshedUnknown) {
        refreshedUnknown = true;
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
        const sha = skillWithFilesSha(skill.content, skill.files ?? []);
        const key = `${skill.name}@${sha}`;
        const temporary = `.tmp-${randomUUID()}`;
        let scriptBytes: Uint8Array | undefined;
        const writes: string[] = [];
        const moves: string[] = [];
        for (const file of skill.files ?? []) {
          if (!file.path.startsWith("scripts/") || !validSkillPath(file.path)) continue;
          const bytes = file.bytes ?? await skill.readFile?.(file);
          if (!bytes) throw new Error(`Stored script ${file.path} changed or was removed`);
          const parent = quote(posix.dirname(file.path));
          const relative = quote(file.path);
          writes.push(`mkdir -p -- "$stage/"${parent}
printf %s ${quote(Buffer.from(bytes).toString("base64"))} | base64 -d > "$stage/"${relative}
chmod ${file.mode === "100755" ? "755" : "644"} "$stage/"${relative}`);
          moves.push(`mkdir -p -- "$directory/"${parent}
mv -f -- "$stage/"${relative} "$directory/"${relative}`);
          if (file.path === args.script) scriptBytes = bytes;
        }
        if (!scriptBytes) throw new Error("Stored script is unavailable");
        // One exec publishes the full set. The trap and host finally own temporary cleanup.
        const preferredCache = `case "\${XDG_CACHE_HOME:-}" in
/*) base="$XDG_CACHE_HOME/valet/skills" ;;
*) case "\${HOME:-}" in /*) base="$HOME/.cache/valet/skills" ;; *) base="" ;; esac ;;
esac`;
        const setup = `set -eu
umask 077
${preferredCache}
private_dir() { mkdir -p -- "$1" && test -d "$1" && test -w "$1" && chmod 700 -- "$1"; }
if [ -z "$base" ] || ! private_dir "$base" 2>/dev/null; then
  base=/tmp/valet-skills
  if ! private_dir "$base" 2>/dev/null; then base="/tmp/valet-skills-$(id -u)"; private_dir "$base"; fi
fi
directory="$base/"${quote(key)}
stage="$base/"${quote(temporary)}
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p -- "$stage" "$directory"
chmod 700 -- "$stage" "$directory"
${writes.join("\n")}
${moves.join("\n")}
printf '%s' "$directory"`;
        let directory: string;
        try {
          const published = await sandbox.exec("sh -s", { stdin: setup, signal: ctx.signal, maxOutputBytes: 4096 });
          if (published.exitCode !== 0) throw new Error(`Cannot publish scripts: ${published.stderr}`);
          directory = published.stdout;
          if (!posix.isAbsolute(directory) || directory.includes("\0")) throw new Error("Invalid sandbox cache path");
        } finally {
          // A provider can stop its client before the remote shell handles the abort.
          // Remove only this call's unique stage, without the aborted signal.
          await sandbox.exec(`${preferredCache}
if [ -n "$base" ]; then rm -rf -- "$base/"${quote(temporary)}; fi
rm -rf -- /tmp/valet-skills/${quote(temporary)} "/tmp/valet-skills-$(id -u)/"${quote(temporary)}`, { timeout: 10_000 }).catch(() => {});
        }
        const path = `${directory}/${args.script}`;
        const command = [...interpreter(scriptBytes, path), path, ...(args.args ?? [])].map(quote).join(" ");
        const result = await runForegroundExec(ctx, command, {
          env: { SKILL_DIR: directory }, signal: ctx.signal,
          timeout: (args.timeout ?? 120) * 1000, maxOutputBytes: OUTPUT_BYTES,
        });
        const bounded = (text: string) => Buffer.from(text).subarray(0, OUTPUT_BYTES).toString("utf8");
        const text = JSON.stringify({ path, exitCode: result.exitCode, stdout: bounded(result.stdout), stderr: bounded(result.stderr),
          ...(result.jobFailed ? { jobFailed: true, error: "The job failed. Check the sandbox, then retry." } : {}),
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
