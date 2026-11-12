/** Codex 0.164+ profile files and command-backed provider authentication. */
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../../exit.js";
import type { HarnessAdapter, HarnessTarget } from "./index.js";
import { assertUnchanged, backupSettings, installedVersion, readText, versionParts, writeAtomicText } from "./files.js";

export function codexVersionBlockers(version: string | undefined): string[] {
  const parts = version ? versionParts(version) : undefined;
  if (parts && ((parts[0] ?? 0) > 0 || (parts[1] ?? 0) >= 164)) return [];
  return ["Install Codex CLI 0.164.0 or later, then run setup again. This adapter requires profile files and command-backed provider auth."];
}

function profilePath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "valet.config.toml");
}

function profileText(target: HarnessTarget): string {
  return `# Managed by valet proxy setup codex.\n# valet-owner: ${JSON.stringify([target.instanceUrl, target.helperArgs])}\nmodel_provider = "valet"\n\n[model_providers.valet]\nname = "Valet"\nbase_url = ${JSON.stringify(`${target.instanceUrl}/proxy/openai/v1`)}\nwire_api = "responses"\n\n[model_providers.valet.auth]\ncommand = "/bin/sh"\nargs = ["-c", ${JSON.stringify(target.helperCommand)}]\n`;
}

/** Recognize only a complete generated file, including this instance's owner. */
function ownProfile(raw: string, target: Pick<HarnessTarget, "instanceUrl" | "helperArgs">): boolean {
  const match = /^args = \["-c", (".*")\]$/m.exec(raw);
  if (!match?.[1]) return false;
  let command: unknown;
  try { command = JSON.parse(match[1]); } catch { return false; }
  return typeof command === "string" && command.endsWith(` ${target.helperArgs}`)
    && raw === profileText({ ...target, helperCommand: command });
}

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  label: "Codex",
  modes: ["centralized"],
  modeRefusal: () => "Codex automatic setup supports centralized proxy mode only. Ask your org admin to enable centralized mode, or use Settings > Proxy.",
  preflight() {
    return { blockers: codexVersionBlockers(installedVersion("codex")), shellBlockers: [], warnings: [] };
  },
  plan(target) {
    const path = profilePath();
    const current = readText(path);
    const next = profileText(target);
    const conflicts = current.trim() && !ownProfile(current, target) ? ["The valet profile contains settings that setup did not write for this instance."] : [];
    const changes = current === next ? [] : ["Configure the valet profile with the OpenAI proxy and key helper."];
    return {
      path, conflicts, changes,
      apply({ force }) {
        assertUnchanged(path, current);
        if (conflicts.length > 0 && !force) throw new ConfigError(`${path} has conflicts. Run setup again with --force to save a backup and replace it.`);
        if (changes.length === 0) return [`${path} is already set up.`];
        const lines = conflicts.length > 0 && existsSync(path) ? [backupSettings(path)] : [];
        writeAtomicText(path, next);
        return [...lines, `Updated ${path}.`];
      },
    };
  },
  unapply(target) {
    const path = profilePath();
    if (!existsSync(path)) return { path, removed: [], kept: [] };
    if (!ownProfile(readText(path), target)) return { path, removed: [], kept: ["valet profile (it contains user changes or another instance's settings)"] };
    unlinkSync(path);
    return { path, removed: ["valet profile"], kept: [] };
  },
  notices: [
    "The valet profile sends OpenAI model calls through Valet. Your default Codex config and ChatGPT login stay available.",
    "This adapter requires Codex CLI 0.164.0 or later. Select a model your org's OpenAI provider supports.",
  ],
  nextStep: "Start `codex --profile valet` to use the Valet proxy.",
};
