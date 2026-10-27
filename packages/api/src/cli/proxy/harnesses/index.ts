/**
 * Harness adapters for `valet proxy setup <harness>`
 * (`docs/specs/2026-10-27-cli-proxy-setup-design.md`). Each adapter owns one
 * local coding tool's config files. The command owns the shared steps: the
 * profile, the gateway settings, the proxy key, and the report.
 */
import type { ProxySettingsResponse } from "../../../wire/types.js";
import { claudeCodeAdapter } from "./claude-code.js";

export type ProxyMode = ProxySettingsResponse["mode"];

/** What the harness config must point at. */
export interface HarnessTarget {
  /** Instance base URL, trailing slash stripped. */
  instanceUrl: string;
  /** The shell command the harness runs to read the key (`valet proxy token <harness> ...`). */
  helperCommand: string;
}

/** The changes setup would make to the harness config, computed before any write. */
export interface HarnessPlan {
  /** The config file the plan writes. */
  path: string;
  /** One line per value setup sets. Empty when the config is already set up. */
  changes: string[];
  /** One line per value that holds something setup did not write. `--force` replaces them. */
  conflicts: string[];
  /** Writes the planned config. With conflicts, writes only under `force`, after a backup. Returns report lines. */
  apply(opts: { force: boolean }): string[];
}

export interface HarnessUnapplyReport {
  path: string;
  /** Values removed. */
  removed: string[];
  /** Values left in place because setup did not write them. */
  kept: string[];
}

export interface HarnessAdapter {
  id: string;
  /** Display name, e.g. "Claude Code". */
  label: string;
  modes: readonly ProxyMode[];
  /** Why the adapter cannot run in `mode`. */
  modeRefusal(mode: ProxyMode): string;
  plan(target: HarnessTarget): HarnessPlan;
  unapply(target: HarnessTarget): HarnessUnapplyReport;
  /** Warnings about the current process environment, e.g. exported keys that bypass the proxy. */
  envWarnings(env: NodeJS.ProcessEnv): string[];
  /** The last line setup prints. */
  nextStep: string;
}

const ADAPTERS: readonly HarnessAdapter[] = [claudeCodeAdapter];

export function harnessAdapter(id: string | undefined): HarnessAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

export function harnessIds(): string[] {
  return ADAPTERS.map((adapter) => adapter.id);
}
