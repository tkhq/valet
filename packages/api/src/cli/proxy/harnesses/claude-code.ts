/**
 * Claude Code adapter for `valet proxy setup claude-code`. It writes two
 * values to the Claude Code user settings (`~/.claude/settings.json`, or
 * `$CLAUDE_CONFIG_DIR/settings.json`):
 *
 *   env.ANTHROPIC_BASE_URL = <instance>/proxy/anthropic
 *   apiKeyHelper           = <valet> proxy token claude-code --instance <name>
 *
 * Claude Code picks one credential in a fixed order: `ANTHROPIC_AUTH_TOKEN`,
 * then `ANTHROPIC_API_KEY`, then `apiKeyHelper`, then a claude.ai login
 * (https://code.claude.com/docs/en/authentication#authentication-precedence).
 * So an exported key wins over the helper, and the helper wins over a
 * subscription login. It sends the helper's key as both `x-api-key` and
 * `Authorization: Bearer`. In pass-through mode the gateway needs the
 * person's own key in `x-api-key`, so this adapter supports centralized mode
 * only.
 *
 * The merge functions are pure over a settings object; the file read and
 * write is a thin shell around them.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError } from "../../exit.js";
import type { HarnessAdapter, HarnessPlan, HarnessPreflight, HarnessTarget, HarnessUnapplyReport } from "./index.js";

type Settings = Record<string, unknown>;

/** Env values that Claude Code uses before the helper. */
const OVERRIDING_ENV = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** Where admins put Claude Code managed settings (https://code.claude.com/docs/en/managed-settings). */
export function managedSettingsDirs(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode"];
  if (platform === "linux") return ["/etc/claude-code"];
  if (platform === "win32") return ["C:\\Program Files\\ClaudeCode"];
  return [];
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(dir, "settings.json");
}

export function proxyBaseUrl(instanceUrl: string): string {
  return `${instanceUrl.replace(/\/$/, "")}/proxy/anthropic`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envOf(settings: Settings): Record<string, unknown> {
  return isRecord(settings.env) ? settings.env : {};
}

/** A helper setup wrote for this harness and instance, wherever the valet binary was. */
function isOwnHelper(value: unknown, helperArgs: string): boolean {
  return typeof value === "string" && value.endsWith(` ${helperArgs}`);
}

export interface SettingsPlan {
  next: Settings;
  changes: string[];
  conflicts: string[];
}

/**
 * The settings after setup, with what changes and what conflicts. A value
 * conflicts when it holds something setup did not write. With conflicts,
 * `next` replaces them, and the caller writes it only under `--force`.
 */
export function planClaudeSettings(current: Settings, target: HarnessTarget): SettingsPlan {
  const baseUrl = proxyBaseUrl(target.instanceUrl);
  const env = envOf(current);
  const changes: string[] = [];
  const conflicts: string[] = [];
  const nextEnv: Record<string, unknown> = { ...env };

  if (env.ANTHROPIC_BASE_URL !== baseUrl) {
    if (env.ANTHROPIC_BASE_URL !== undefined) conflicts.push(`env.ANTHROPIC_BASE_URL is set to ${String(env.ANTHROPIC_BASE_URL)}`);
    changes.push(`env.ANTHROPIC_BASE_URL = ${baseUrl}`);
    nextEnv.ANTHROPIC_BASE_URL = baseUrl;
  }
  for (const name of OVERRIDING_ENV) {
    if (env[name] === undefined) continue;
    // Never print the value: it is a credential.
    conflicts.push(`env.${name} is set, and Claude Code would send it instead of the proxy key`);
    changes.push(`remove env.${name}`);
    delete nextEnv[name];
  }
  if (current.apiKeyHelper !== target.helperCommand) {
    if (current.apiKeyHelper !== undefined && !isOwnHelper(current.apiKeyHelper, target.helperArgs)) {
      conflicts.push(`apiKeyHelper is set to ${String(current.apiKeyHelper)}`);
    }
    changes.push(`apiKeyHelper = ${target.helperCommand}`);
  }
  if (current.env !== undefined && !isRecord(current.env)) conflicts.push("env is not an object");

  return { next: { ...current, env: nextEnv, apiKeyHelper: target.helperCommand }, changes, conflicts };
}

/** The settings after remove. Removes only the values setup wrote for this instance. */
export function unapplyClaudeSettings(
  current: Settings,
  target: Pick<HarnessTarget, "instanceUrl" | "helperArgs">,
): { next: Settings; removed: string[]; kept: string[] } {
  const baseUrl = proxyBaseUrl(target.instanceUrl);
  const next: Settings = { ...current };
  const removed: string[] = [];
  const kept: string[] = [];
  if (isOwnHelper(current.apiKeyHelper, target.helperArgs)) {
    delete next.apiKeyHelper;
    removed.push("apiKeyHelper");
  } else if (current.apiKeyHelper !== undefined) {
    kept.push("apiKeyHelper (setup did not write it for this instance)");
  }
  if (isRecord(current.env) && current.env.ANTHROPIC_BASE_URL !== undefined) {
    if (current.env.ANTHROPIC_BASE_URL === baseUrl) {
      const env = { ...current.env };
      delete env.ANTHROPIC_BASE_URL;
      if (Object.keys(env).length === 0) delete next.env;
      else next.env = env;
      removed.push("env.ANTHROPIC_BASE_URL");
    } else {
      kept.push(`env.ANTHROPIC_BASE_URL (set to ${String(current.env.ANTHROPIC_BASE_URL)}, not this instance's proxy)`);
    }
  }
  return { next, removed, kept };
}

/**
 * Admin policy that stops Claude Code from using the helper or the proxy URL
 * (https://code.claude.com/docs/en/authentication#restrict-login-to-your-organization).
 * Pure over the parsed managed settings documents.
 */
export function managedSettingsBlockers(docs: Array<{ path: string; settings: Settings }>): string[] {
  const blockers: string[] = [];
  for (const { path, settings } of docs) {
    for (const key of ["forceLoginMethod", "forceLoginOrgUUID"]) {
      if (settings[key] !== undefined) {
        blockers.push(`${path} sets ${key}. Under that policy Claude Code refuses to start with a key helper.`);
      }
    }
    if (Array.isArray(settings.allowedProviders) && !settings.allowedProviders.includes("customEndpoint")) {
      blockers.push(`${path} sets allowedProviders without "customEndpoint". Claude Code refuses requests to the Valet proxy URL.`);
    }
    if (settings.apiKeyHelper !== undefined) blockers.push(`${path} sets apiKeyHelper, which replaces the Valet key helper.`);
    if (isRecord(settings.env) && settings.env.ANTHROPIC_BASE_URL !== undefined) {
      blockers.push(`${path} sets env.ANTHROPIC_BASE_URL, which replaces the Valet proxy URL.`);
    }
  }
  return blockers;
}

/** Managed settings files on this computer: `managed-settings.json` and `managed-settings.d/*.json`. Unreadable files are skipped. */
function readManagedSettings(platform: NodeJS.Platform): Array<{ path: string; settings: Settings }> {
  const docs: Array<{ path: string; settings: Settings }> = [];
  for (const dir of managedSettingsDirs(platform)) {
    const files = [join(dir, "managed-settings.json")];
    const dropIns = join(dir, "managed-settings.d");
    try {
      for (const name of readdirSync(dropIns).sort()) {
        if (name.endsWith(".json") && !name.startsWith(".")) files.push(join(dropIns, name));
      }
    } catch {
      // No drop-in directory.
    }
    for (const path of files) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (isRecord(parsed)) docs.push({ path, settings: parsed });
      } catch {
        // Missing or unreadable: Claude Code reports a broken policy file itself.
      }
    }
  }
  return docs;
}

/** Read the settings file. A missing file is `{}`; a file that is not a JSON object throws, and nothing is written. */
export function readClaudeSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix the file, then run the command again.`);
  }
  if (!isRecord(parsed)) throw new ConfigError(`${path} must hold a JSON object. Fix the file, then run the command again.`);
  return parsed;
}

/**
 * Write the settings atomically: a temp file in the same directory, then a
 * rename. A symlinked settings file (dotfiles) is written through to its
 * target, so the link survives. The file keeps its mode.
 */
export function writeClaudeSettings(path: string, settings: Settings): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
  const temp = `${target}.valet-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, mode === undefined ? {} : { mode });
  renameSync(temp, target);
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  label: "Claude Code",
  modes: ["centralized"],
  modeRefusal: () =>
    "Your org's proxy runs in pass-through mode. `valet proxy setup claude-code` supports centralized mode only. Use the manual setup in Settings > Proxy.",

  preflight(env: NodeJS.ProcessEnv): HarnessPreflight {
    const shellBlockers = OVERRIDING_ENV
      .filter((name) => env[name])
      .map((name) =>
        `Your shell exports ${name}. Claude Code uses it before the key helper, so it would send that key to the Valet proxy and fail. Remove the export from your shell profile, and open a new shell.`);
    const warnings = env.ANTHROPIC_BASE_URL
      ? ["Your shell exports ANTHROPIC_BASE_URL. Remove it from your shell profile, so it cannot point Claude Code away from the Valet proxy."]
      : [];
    return { blockers: managedSettingsBlockers(readManagedSettings(process.platform)), shellBlockers, warnings };
  },

  plan(target: HarnessTarget): HarnessPlan {
    const path = claudeSettingsPath(process.env);
    const current = readClaudeSettings(path);
    const { next, changes, conflicts } = planClaudeSettings(current, target);
    return {
      path,
      changes,
      conflicts,
      apply({ force }) {
        if (changes.length === 0) return [`${path} is already set up.`];
        if (conflicts.length > 0 && !force) throw new ConfigError(`${path} has conflicts. Run again with --force to replace them.`);
        const lines: string[] = [];
        if (conflicts.length > 0 && existsSync(path)) {
          const backup = `${path}.valet-backup`;
          copyFileSync(path, backup);
          lines.push(`Saved the old settings to ${backup}.`);
        }
        writeClaudeSettings(path, next);
        lines.push(`Updated ${path}:`, ...changes.map((change) => `  ${change}`));
        return lines;
      },
    };
  },

  unapply(target): HarnessUnapplyReport {
    const path = claudeSettingsPath(process.env);
    if (!existsSync(path)) return { path, removed: [], kept: [] };
    const { next, removed, kept } = unapplyClaudeSettings(readClaudeSettings(path), target);
    if (removed.length > 0) writeClaudeSettings(path, next);
    return { path, removed, kept };
  },

  notices: [
    "Claude Code now authenticates with the Valet proxy key. The key helper ranks above a claude.ai login, so your model use bills through Valet, not your Claude subscription.",
    "A repository's .claude/settings.json or settings.local.json can still override these values in that repository.",
  ],

  nextStep: "Start a new `claude` session to use the Valet proxy. Run `/status` in it to check the key source.",
};
