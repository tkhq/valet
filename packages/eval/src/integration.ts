/**
 * Real plugin catalog with live credentials (TKAI-336).
 *
 * `profile: integration` exposes real plugin actions restricted to
 * riskLevel "low" (the read-only approximation the issue calls for);
 * `profile: full` exposes every action and runs on a Docker sandbox.
 * Credentials seed the eval engine's `InMemoryCredentialStore` from a
 * dedicated `.env.eval` file (with process-env fallback) — never the dev
 * `.env`, and never production keys: known production variables are
 * rejected outright.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pluginCatalogTools, type ActionPlugin, type ToolDef, type ValetPlugin } from "@valet/engine";

/** Env var → credential service. Extend as integration cases need more services. */
export const ENV_CREDENTIAL_MAP: Record<string, string> = {
  GITHUB_TOKEN: "github",
  LINEAR_API_KEY: "linear",
  SLACK_BOT_TOKEN: "slack",
  NOTION_API_KEY: "notion",
  STRIPE_API_KEY: "stripe",
  SENTRY_AUTH_TOKEN: "sentry",
  OPENAI_API_KEY: "openai",
  CLOUDFLARE_API_TOKEN: "cloudflare",
  TYPEFULLY_API_KEY: "typefully",
};

/**
 * Production-shaped variables that must never reach an eval run. A hit is a
 * hard error, not a warning: evals with production credentials can mutate
 * production state.
 */
const FORBIDDEN_ENV_KEYS = ["DATABASE_URL", "POSTGRES_URL", "PGHOST", "PGDATABASE", "VALET_DATA_DIR"];

/** Parse a dotenv-style file: KEY=VALUE lines, `#` comments, optional quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface LoadCredentialsOptions {
  /** Path to the eval credential file. Missing file === no file entries. */
  envFilePath?: string;
  /** Process env fallback (tests inject a fake). Default: process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Load eval credentials keyed by credential service. File entries win over
 * process-env entries. Throws when the file carries a production variable.
 */
export async function loadEvalCredentials(opts: LoadCredentialsOptions = {}): Promise<Record<string, string>> {
  const env = opts.env ?? process.env;
  let fileEntries: Record<string, string> = {};
  if (opts.envFilePath !== undefined) {
    try {
      fileEntries = parseEnvFile(await readFile(opts.envFilePath, "utf8"));
    } catch {
      fileEntries = {};
    }
  }

  for (const key of Object.keys(fileEntries)) {
    if (FORBIDDEN_ENV_KEYS.includes(key)) {
      throw new Error(
        `.env.eval sets \`${key}\`, which looks like a production credential. ` +
          "Remove it: evals must run with dedicated eval credentials only.",
      );
    }
  }

  const credentials: Record<string, string> = {};
  for (const [envKey, service] of Object.entries(ENV_CREDENTIAL_MAP)) {
    const value = fileEntries[envKey] ?? env[envKey];
    if (typeof value === "string" && value.length > 0) credentials[service] = value;
  }
  return credentials;
}

/** The env var that provides a service's credential, for skip messages. */
export function envKeyForService(service: string): string | undefined {
  return Object.entries(ENV_CREDENTIAL_MAP).find(([, s]) => s === service)?.[0];
}

/**
 * Build the real `[list_tools, call_tool]` pair from plugin manifests.
 * `integration` keeps only riskLevel "low" actions — the read-only subset;
 * `full` keeps everything. Both auto-allow approvals: eval runs are
 * unattended, and a pending gate would hang the case. `full` cases must
 * therefore point at throwaway resources.
 */
export function buildRealCatalogTools(
  plugins: ValetPlugin[],
  profile: "integration" | "full",
  /** Restrict the catalog to these action ids (see EvalCase.allowed_actions). */
  allowedActions?: string[],
): ToolDef[] {
  const allowed = allowedActions !== undefined ? new Set(allowedActions) : undefined;
  const actionPlugins: ActionPlugin[] = plugins
    .flatMap((p) => p.actions ?? [])
    .map((plugin) => {
      const byRisk =
        profile === "integration"
          ? plugin.actions.filter((a) => a.riskLevel === "low")
          : plugin.actions;
      const filtered: ActionPlugin = {
        ...plugin,
        defaultApprovalMode: "allow" as const,
        actions: allowed !== undefined ? byRisk.filter((a) => allowed.has(a.id)) : byRisk,
      };
      // Dynamic discovery (resolveActions) can surface actions the static
      // filters never saw — including mutations. The integration profile
      // must stay read-only, and an allowed_actions pin must be airtight,
      // so both drop the seam entirely.
      if (profile === "integration" || allowed !== undefined) delete filtered.resolveActions;
      return filtered;
    })
    .filter((plugin) => plugin.actions.length > 0);
  return pluginCatalogTools({ plugins: actionPlugins });
}

/** True when a usable Docker daemon answers `docker info` within 5s. */
export function dockerAvailable(): Promise<boolean> {
  return new Promise((resolveProbe) => {
    execFile("docker", ["info"], { timeout: 5_000 }, (err) => resolveProbe(err === null));
  });
}
