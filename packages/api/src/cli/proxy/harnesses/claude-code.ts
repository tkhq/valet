/**
 * Claude Code adapter for `valet proxy setup claude-code`. It writes two
 * values to the Claude Code user settings (`~/.claude/settings.json`, or
 * `$CLAUDE_CONFIG_DIR/settings.json`):
 *
 *   env.ANTHROPIC_BASE_URL = <instance>/proxy/anthropic
 *   apiKeyHelper           = <valet> proxy token claude-code --instance <name>
 *
 * Claude Code runs the helper for its key and sends the result as both
 * `x-api-key` and `Authorization: Bearer`. In pass-through mode the gateway
 * needs the person's own key in `x-api-key`, so this adapter supports
 * centralized mode only.
 *
 * The merge functions are pure over a settings object; the file read and
 * write is a thin shell around them.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError } from "../../exit.js";
import type { HarnessAdapter, HarnessPlan, HarnessTarget, HarnessUnapplyReport } from "./index.js";

type Settings = Record<string, unknown>;

/** Env values that make Claude Code skip the helper or the proxy. */
const OVERRIDING_ENV = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

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

/** A setup helper for any instance or valet path. Remove treats it as setup's own value. */
function isProxyHelper(value: unknown): boolean {
  return typeof value === "string" && / proxy token claude-code(\s|$)/.test(value);
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
    // An older setup helper (the valet binary moved) is setup's own value.
    if (current.apiKeyHelper !== undefined && !isProxyHelper(current.apiKeyHelper)) {
      conflicts.push(`apiKeyHelper is set to ${String(current.apiKeyHelper)}`);
    }
    changes.push(`apiKeyHelper = ${target.helperCommand}`);
  }
  if (current.env !== undefined && !isRecord(current.env)) conflicts.push("env is not an object");

  return { next: { ...current, env: nextEnv, apiKeyHelper: target.helperCommand }, changes, conflicts };
}

/** The settings after remove. Removes only values setup wrote. */
export function unapplyClaudeSettings(current: Settings, target: HarnessTarget): { next: Settings; removed: string[]; kept: string[] } {
  const baseUrl = proxyBaseUrl(target.instanceUrl);
  const next: Settings = { ...current };
  const removed: string[] = [];
  const kept: string[] = [];
  if (isProxyHelper(current.apiKeyHelper)) {
    delete next.apiKeyHelper;
    removed.push("apiKeyHelper");
  } else if (current.apiKeyHelper !== undefined) {
    kept.push("apiKeyHelper (setup did not write it)");
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

function writeClaudeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  label: "Claude Code",
  modes: ["centralized"],
  modeRefusal: () =>
    "Your org's proxy runs in pass-through mode. `valet proxy setup claude-code` supports centralized mode only. Use the manual setup in Settings > Proxy.",

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

  unapply(target: HarnessTarget): HarnessUnapplyReport {
    const path = claudeSettingsPath(process.env);
    if (!existsSync(path)) return { path, removed: [], kept: [] };
    const { next, removed, kept } = unapplyClaudeSettings(readClaudeSettings(path), target);
    if (removed.length > 0) writeClaudeSettings(path, next);
    return { path, removed, kept };
  },

  envWarnings(env: NodeJS.ProcessEnv): string[] {
    return [...OVERRIDING_ENV, "ANTHROPIC_BASE_URL"]
      .filter((name) => env[name])
      .map((name) => `Your shell exports ${name}. Claude Code can use it instead of the Valet proxy. Unset it in your shell profile.`);
  },

  nextStep: "Start a new `claude` session to use the Valet proxy.",
};
