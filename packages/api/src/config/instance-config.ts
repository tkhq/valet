/**
 * Instance config file (`valet.yaml`) — loader and validator.
 *
 * `VALET_CONFIG` points at the file. Unset → null (opt-in). Any parse or
 * validation error throws `InstanceConfigError` with the field path and the
 * corrective action. Fail-fast: a half-applied config is worse than no api.
 *
 * This module MUST stay free of side effects on import.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolPolicyRule {
  // Exactly one of service/action/riskLevel names the policy target. `action`
  // is the fully-qualified `service.action` id (the policy engine's actionId
  // convention). These reconcile into `action_policies` org rows.
  service?: string;
  action?: string;
  riskLevel?: "low" | "medium" | "high" | "critical";
  mode: "allow" | "require_approval" | "deny";
  appliesIn?: "any" | "session" | "workflow";
}

export interface InstanceMemberDecl {
  email: string;
  role: "admin" | "member";
}

export interface InstanceConfig {
  version: 1;
  auth?: { allowedEmailDomains?: string[] };
  plugins?: { allow?: string[]; deny?: string[] };
  toolPolicies?: ToolPolicyRule[];
  org?: {
    name?: string;
    features?: Record<string, boolean>;
    modelPreferences?: string[];
    bareSkillCommands?: boolean;
    members?: InstanceMemberDecl[];
  };
  teams?: { name: string; members?: InstanceMemberDecl[] }[];
  llmProviders?: {
    kind: "anthropic" | "openai" | "google" | "openrouter" | "openai_compatible";
    name?: string; // required when kind === "openai_compatible"
    baseUrl?: string;
    enabled?: boolean;
    models?: { id: string; name?: string }[];
  }[];
  skillSources?: { repo: string; ref?: string; subpath?: string }[];
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class InstanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceConfigError";
  }
}

// ---------------------------------------------------------------------------
// Known keys
// ---------------------------------------------------------------------------

const KNOWN_TOP_LEVEL_KEYS = new Set<string>([
  "version",
  "auth",
  "plugins",
  "toolPolicies",
  "org",
  "teams",
  "llmProviders",
  "skillSources",
]);

const TOOL_POLICY_MODES = new Set<string>(["allow", "require_approval", "deny"]);

const TOOL_POLICY_RISK_LEVELS = new Set<string>(["low", "medium", "high", "critical"]);

const TOOL_POLICY_APPLIES_IN = new Set<string>(["any", "session", "workflow"]);

const MEMBER_ROLES = new Set<string>(["admin", "member"]);

const LLM_PROVIDER_KINDS = new Set<string>([
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "openai_compatible",
]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function err(msg: string): never {
  throw new InstanceConfigError(msg);
}

function assertString(value: unknown, fieldPath: string, path: string): string {
  if (typeof value !== "string") {
    err(`${path}: ${fieldPath} must be a string, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function assertBoolean(value: unknown, fieldPath: string, path: string): boolean {
  if (typeof value !== "boolean") {
    err(`${path}: ${fieldPath} must be a boolean, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function assertArray(value: unknown, fieldPath: string, path: string): unknown[] {
  if (!Array.isArray(value)) {
    err(`${path}: ${fieldPath} must be an array, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function assertRecord(value: unknown, fieldPath: string, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    err(`${path}: ${fieldPath} must be an object, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function assertStringArray(value: unknown, fieldPath: string, path: string): string[] {
  const arr = assertArray(value, fieldPath, path);
  return arr.map((item, i) => assertString(item, `${fieldPath}[${i}]`, path));
}

function validateEmail(value: unknown, fieldPath: string, path: string): string {
  const raw = assertString(value, fieldPath, path).trim().toLowerCase();
  if (!raw.includes("@")) {
    err(`${path}: ${fieldPath} must contain "@", got ${JSON.stringify(raw)}.`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Section validators
// ---------------------------------------------------------------------------

function validateAuth(
  value: unknown,
  path: string,
): NonNullable<InstanceConfig["auth"]> {
  const obj = assertRecord(value, "auth", path);
  const result: NonNullable<InstanceConfig["auth"]> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (key === "allowedEmailDomains") {
      const raw = assertStringArray(v, "auth.allowedEmailDomains", path);
      result.allowedEmailDomains = raw
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    } else {
      err(`${path}: unknown key "auth.${key}". Remove it or check for a typo.`);
    }
  }
  return result;
}

function validatePlugins(
  value: unknown,
  path: string,
): NonNullable<InstanceConfig["plugins"]> {
  const obj = assertRecord(value, "plugins", path);
  const result: NonNullable<InstanceConfig["plugins"]> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (key === "allow") {
      result.allow = assertStringArray(v, "plugins.allow", path);
    } else if (key === "deny") {
      result.deny = assertStringArray(v, "plugins.deny", path);
    } else {
      err(`${path}: unknown key "plugins.${key}". Remove it or check for a typo.`);
    }
  }
  return result;
}

function validateToolPolicies(
  value: unknown,
  path: string,
): ToolPolicyRule[] {
  const arr = assertArray(value, "toolPolicies", path);
  return arr.map((item, i) => {
    const obj = assertRecord(item, `toolPolicies[${i}]`, path);
    let service: string | undefined;
    let action: string | undefined;
    let riskLevel: ToolPolicyRule["riskLevel"] | undefined;
    let mode: string | undefined;
    let appliesIn: ToolPolicyRule["appliesIn"] | undefined;
    for (const [key, v] of Object.entries(obj)) {
      if (key === "service") {
        service = assertString(v, `toolPolicies[${i}].service`, path);
      } else if (key === "action") {
        action = assertString(v, `toolPolicies[${i}].action`, path);
      } else if (key === "riskLevel") {
        const riskVal = assertString(v, `toolPolicies[${i}].riskLevel`, path);
        if (!TOOL_POLICY_RISK_LEVELS.has(riskVal)) {
          err(
            `${path}: toolPolicies[${i}].riskLevel got "${riskVal}", allowed values are low, medium, high, critical.`,
          );
        }
        riskLevel = riskVal as ToolPolicyRule["riskLevel"];
      } else if (key === "mode") {
        const modeVal = assertString(v, `toolPolicies[${i}].mode`, path);
        if (!TOOL_POLICY_MODES.has(modeVal)) {
          err(
            `${path}: toolPolicies[${i}].mode got "${modeVal}", allowed values are allow, require_approval, deny.`,
          );
        }
        mode = modeVal;
      } else if (key === "appliesIn") {
        const appliesVal = assertString(v, `toolPolicies[${i}].appliesIn`, path);
        if (!TOOL_POLICY_APPLIES_IN.has(appliesVal)) {
          err(
            `${path}: toolPolicies[${i}].appliesIn got "${appliesVal}", allowed values are any, session, workflow.`,
          );
        }
        appliesIn = appliesVal as ToolPolicyRule["appliesIn"];
      } else {
        err(`${path}: unknown key "toolPolicies[${i}].${key}". Remove it or check for a typo.`);
      }
    }

    // Exactly one target dimension — mirrors policies/admin.ts validateTarget.
    const targetCount =
      (service !== undefined ? 1 : 0) +
      (action !== undefined ? 1 : 0) +
      (riskLevel !== undefined ? 1 : 0);
    if (targetCount === 0) {
      err(
        `${path}: toolPolicies[${i}] must set exactly one of service, action, riskLevel. Add one target field.`,
      );
    }
    if (targetCount > 1) {
      err(
        `${path}: toolPolicies[${i}] sets more than one of service, action, riskLevel. Keep exactly one target field.`,
      );
    }
    if (mode === undefined) err(`${path}: toolPolicies[${i}].mode is required.`);

    const rule: ToolPolicyRule = { mode: mode as ToolPolicyRule["mode"] };
    if (service !== undefined) rule.service = service;
    if (action !== undefined) rule.action = action;
    if (riskLevel !== undefined) rule.riskLevel = riskLevel;
    if (appliesIn !== undefined) rule.appliesIn = appliesIn;
    return rule;
  });
}

function validateMembers(
  value: unknown,
  fieldPath: string,
  path: string,
): InstanceMemberDecl[] {
  const arr = assertArray(value, fieldPath, path);
  return arr.map((item, i) => {
    const obj = assertRecord(item, `${fieldPath}[${i}]`, path);
    let email: string | undefined;
    let role: string | undefined;
    for (const [key, v] of Object.entries(obj)) {
      if (key === "email") {
        email = validateEmail(v, `${fieldPath}[${i}].email`, path);
      } else if (key === "role") {
        const roleVal = assertString(v, `${fieldPath}[${i}].role`, path);
        if (!MEMBER_ROLES.has(roleVal)) {
          err(
            `${path}: ${fieldPath}[${i}].role got "${roleVal}", allowed values are admin, member.`,
          );
        }
        role = roleVal;
      } else {
        err(
          `${path}: unknown key "${fieldPath}[${i}].${key}". Remove it or check for a typo.`,
        );
      }
    }
    if (email === undefined) err(`${path}: ${fieldPath}[${i}].email is required.`);
    if (role === undefined) err(`${path}: ${fieldPath}[${i}].role is required.`);
    return { email, role: role as InstanceMemberDecl["role"] };
  });
}

function validateOrg(
  value: unknown,
  path: string,
): NonNullable<InstanceConfig["org"]> {
  const obj = assertRecord(value, "org", path);
  const result: NonNullable<InstanceConfig["org"]> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (key === "name") {
      result.name = assertString(v, "org.name", path);
    } else if (key === "features") {
      const rec = assertRecord(v, "org.features", path);
      const features: Record<string, boolean> = {};
      for (const [fk, fv] of Object.entries(rec)) {
        features[fk] = assertBoolean(fv, `org.features.${fk}`, path);
      }
      result.features = features;
    } else if (key === "modelPreferences") {
      result.modelPreferences = assertStringArray(v, "org.modelPreferences", path);
    } else if (key === "bareSkillCommands") {
      result.bareSkillCommands = assertBoolean(v, "org.bareSkillCommands", path);
    } else if (key === "members") {
      result.members = validateMembers(v, "org.members", path);
    } else {
      err(`${path}: unknown key "org.${key}". Remove it or check for a typo.`);
    }
  }
  return result;
}

function validateTeams(
  value: unknown,
  path: string,
): NonNullable<InstanceConfig["teams"]> {
  const arr = assertArray(value, "teams", path);
  return arr.map((item, i) => {
    const obj = assertRecord(item, `teams[${i}]`, path);
    let name: string | undefined;
    let members: InstanceMemberDecl[] | undefined;
    for (const [key, v] of Object.entries(obj)) {
      if (key === "name") {
        name = assertString(v, `teams[${i}].name`, path);
      } else if (key === "members") {
        members = validateMembers(v, `teams[${i}].members`, path);
      } else {
        err(`${path}: unknown key "teams[${i}].${key}". Remove it or check for a typo.`);
      }
    }
    if (name === undefined) err(`${path}: teams[${i}].name is required.`);
    const entry: { name: string; members?: InstanceMemberDecl[] } = { name };
    if (members !== undefined) entry.members = members;
    return entry;
  });
}

function validateLlmProviders(
  value: unknown,
  path: string,
): NonNullable<InstanceConfig["llmProviders"]> {
  const arr = assertArray(value, "llmProviders", path);
  return arr.map((item, i) => {
    const obj = assertRecord(item, `llmProviders[${i}]`, path);
    type ProviderEntry = NonNullable<InstanceConfig["llmProviders"]>[number];
    const entry: Partial<ProviderEntry> = {};

    for (const [key, v] of Object.entries(obj)) {
      if (key === "kind") {
        const kindVal = assertString(v, `llmProviders[${i}].kind`, path);
        if (!LLM_PROVIDER_KINDS.has(kindVal)) {
          err(
            `${path}: llmProviders[${i}].kind got "${kindVal}", allowed values are anthropic, openai, google, openrouter, openai_compatible.`,
          );
        }
        entry.kind = kindVal as ProviderEntry["kind"];
      } else if (key === "name") {
        entry.name = assertString(v, `llmProviders[${i}].name`, path);
      } else if (key === "baseUrl") {
        entry.baseUrl = assertString(v, `llmProviders[${i}].baseUrl`, path);
      } else if (key === "enabled") {
        entry.enabled = assertBoolean(v, `llmProviders[${i}].enabled`, path);
      } else if (key === "models") {
        const models = assertArray(v, `llmProviders[${i}].models`, path);
        entry.models = models.map((m, mi) => {
          const mobj = assertRecord(m, `llmProviders[${i}].models[${mi}]`, path);
          let id: string | undefined;
          let name: string | undefined;
          for (const [mk, mv] of Object.entries(mobj)) {
            if (mk === "id") {
              id = assertString(mv, `llmProviders[${i}].models[${mi}].id`, path);
            } else if (mk === "name") {
              name = assertString(mv, `llmProviders[${i}].models[${mi}].name`, path);
            } else {
              err(
                `${path}: unknown key "llmProviders[${i}].models[${mi}].${mk}". Remove it or check for a typo.`,
              );
            }
          }
          if (id === undefined)
            err(`${path}: llmProviders[${i}].models[${mi}].id is required.`);
          const model: { id: string; name?: string } = { id };
          if (name !== undefined) model.name = name;
          return model;
        });
      } else {
        err(
          `${path}: unknown key "llmProviders[${i}].${key}". Remove it or check for a typo.`,
        );
      }
    }

    if (entry.kind === undefined) err(`${path}: llmProviders[${i}].kind is required.`);
    if (entry.kind === "openai_compatible" && !entry.name) {
      err(
        `${path}: llmProviders[${i}].name is required when kind is "openai_compatible". Set a unique name.`,
      );
    }

    return entry as ProviderEntry;
  });
}

function validateSkillSources(
  value: unknown,
  path: string,
): NonNullable<InstanceConfig["skillSources"]> {
  const arr = assertArray(value, "skillSources", path);
  const entries = arr.map((item, i) => {
    const obj = assertRecord(item, `skillSources[${i}]`, path);
    let repo: string | undefined;
    let ref: string | undefined;
    let subpath: string | undefined;
    for (const [key, v] of Object.entries(obj)) {
      if (key === "repo") {
        repo = assertString(v, `skillSources[${i}].repo`, path);
      } else if (key === "ref") {
        ref = assertString(v, `skillSources[${i}].ref`, path);
      } else if (key === "subpath") {
        subpath = assertString(v, `skillSources[${i}].subpath`, path);
      } else {
        err(
          `${path}: unknown key "skillSources[${i}].${key}". Remove it or check for a typo.`,
        );
      }
    }
    if (repo === undefined) err(`${path}: skillSources[${i}].repo is required.`);
    const entry: { repo: string; ref?: string; subpath?: string } = { repo };
    if (ref !== undefined) entry.ref = ref;
    if (subpath !== undefined) entry.subpath = subpath;
    return entry;
  });

  // Reject configs with duplicate (repo, subpath) pairs — they would collide on
  // the DB unique index (orgId, ownerType, ownerId, repoFullName, subpath) at
  // boot. We compare the raw repo string lowercased + subpath so the check is
  // dependency-light and avoids importing parseRepoInput here; note that two
  // entries differing only in URL scheme or trailing ".git" will NOT be caught
  // by this check — the reconciler's unmanaged-row guard will warn at runtime.
  const seen = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const key = `${e.repo.toLowerCase()}|${e.subpath ?? ""}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      err(
        `${path}: skillSources[${prior}] and skillSources[${i}] track the same repository and subpath. Remove one (a source can track only one ref).`,
      );
    }
    seen.set(key, i);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses + validates YAML text. Throws `InstanceConfigError` with the field
 * path and corrective action on any error.
 */
export function parseInstanceConfig(yamlText: string, path: string): InstanceConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    err(`${path}: YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!isRecord(raw)) {
    err(`${path}: config must be a YAML object.`);
  }

  // Check for unknown top-level keys first (before version check).
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      err(`${path}: unknown key "${key}". Remove it or check for a typo.`);
    }
  }

  // version must be present and exactly 1.
  if (!("version" in raw)) {
    err(`${path}: version must be 1. Set "version: 1".`);
  }
  if (raw["version"] !== 1) {
    err(`${path}: version must be 1. Set "version: 1".`);
  }

  const cfg: InstanceConfig = { version: 1 };

  if ("auth" in raw) cfg.auth = validateAuth(raw["auth"], path);
  if ("plugins" in raw) cfg.plugins = validatePlugins(raw["plugins"], path);
  if ("toolPolicies" in raw) cfg.toolPolicies = validateToolPolicies(raw["toolPolicies"], path);
  if ("org" in raw) cfg.org = validateOrg(raw["org"], path);
  if ("teams" in raw) cfg.teams = validateTeams(raw["teams"], path);
  if ("llmProviders" in raw) cfg.llmProviders = validateLlmProviders(raw["llmProviders"], path);
  if ("skillSources" in raw) cfg.skillSources = validateSkillSources(raw["skillSources"], path);

  return cfg;
}

/**
 * Reads `env.VALET_CONFIG`. Unset → null. Missing/unreadable file or invalid
 * content → `InstanceConfigError`.
 */
export function loadInstanceConfig(env: NodeJS.ProcessEnv): InstanceConfig | null {
  const configPath = env["VALET_CONFIG"];
  if (!configPath) return null;

  if (!existsSync(configPath)) {
    err(
      `Config file not found at ${configPath}. Fix VALET_CONFIG or create the file.`,
    );
  }

  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (e) {
    err(
      `Config file not found at ${configPath}. Fix VALET_CONFIG or create the file.`,
    );
  }

  return parseInstanceConfig(text, configPath);
}

/**
 * Both-set guard + merge for `allowedEmailDomains`.
 *
 * Throws `InstanceConfigError` with the spec's exact copy when
 * `AUTH_ALLOWED_EMAIL_DOMAINS` is set AND `cfg.auth?.allowedEmailDomains` is
 * present. Returns the domains the caller should use — the config value when
 * config declares it, else `envParsed`.
 */
export function resolveAllowedEmailDomains(
  cfg: InstanceConfig | null,
  env: NodeJS.ProcessEnv,
  envParsed: string[],
): string[] {
  const configPath = env["VALET_CONFIG"];
  const configDomains = cfg?.auth?.allowedEmailDomains;
  const envSet = Boolean(env["AUTH_ALLOWED_EMAIL_DOMAINS"]);

  if (envSet && configDomains !== undefined) {
    err(
      `AUTH_ALLOWED_EMAIL_DOMAINS is set and ${configPath} declares auth.allowedEmailDomains. Remove one.`,
    );
  }

  if (configDomains !== undefined) return configDomains;
  return envParsed;
}
