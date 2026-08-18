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

/**
 * How the identity provider's group claim maps onto teams. Non-secret, the
 * same on every replica, and it changes the shape of instance state — so it
 * belongs in the file, while the issuer and the client secret stay in env.
 *
 * Provider-agnostic on purpose: a provider that names these claims
 * differently needs no code change, only different values here.
 */
export interface SsoTeamMapping {
  /** Claim that carries full group paths, e.g. `["/platform/admins"]`. */
  claim?: string;
  /** Claim whose presence proves the group mapper ran. Any value counts. */
  assertedClaim?: string;
  /** Sub-group that grants admin on the parent team, e.g. `admins`. */
  adminSubGroup?: string;
  /**
   * Top-level group paths this instance mirrors. Omitted means every
   * top-level group the claim carries.
   */
  groups?: string[];
}

/**
 * A custom MCP server the instance exposes as an action service. The file
 * never holds secrets, so `auth: bearer` names an env var (`tokenEnv`)
 * instead of a token. `auth: oauth` uses MCP OAuth discovery + dynamic
 * registration against `url`; `auth: api_key` asks each user for a token in
 * the connect UI.
 */
export interface McpServerDecl {
  /** Service name; actions surface as `<name>.<tool>`. Lowercase slug. */
  name: string;
  /** Human-readable name for the connect UI, e.g. "Grafana Cloud". Defaults
   * to a title-cased `name`. */
  displayName?: string;
  /** The remote MCP server endpoint (http/https). */
  url: string;
  auth: "none" | "oauth" | "api_key" | "bearer";
  /** Env var holding the instance-wide token. Required iff auth is "bearer". */
  tokenEnv?: string;
  /** Send the credential as this URL query param instead of an Authorization header. */
  authQueryParam?: string;
  /** Connect-UI copy for api_key entry, e.g. "Acme API key". */
  connectLabel?: string;
  description?: string;
  /** Risk for tools without read-only/destructive annotations. Default "medium". */
  riskLevel?: "low" | "medium" | "high" | "critical";
  /** Set false to keep the entry but skip loading it. Default true. */
  enabled?: boolean;
}

export interface InstanceConfig {
  version: 1;
  auth?: { allowedEmailDomains?: string[]; sso?: { teams?: SsoTeamMapping } };
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
  mcpServers?: McpServerDecl[];
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
  "mcpServers",
]);

const MCP_SERVER_AUTH_MODES = new Set<string>(["none", "oauth", "api_key", "bearer"]);

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

/** Rejects a value that is blank once trimmed, mirroring `trimmedOr` in `auth/config.ts`. */
function assertNonEmptyString(value: unknown, fieldPath: string, path: string): string {
  const raw = assertString(value, fieldPath, path).trim();
  if (raw.length === 0) {
    err(`${path}: ${fieldPath} must not be empty. Set a value, or remove the key to use the default.`);
  }
  return raw;
}

/**
 * Validates `auth.sso.teams`.
 *
 * Every rule here rejects config that would be silently inert or silently
 * unsafe at run time, which no log line makes visible to an operator.
 */
function validateSsoTeams(value: unknown, path: string): SsoTeamMapping {
  const obj = assertRecord(value, "auth.sso.teams", path);
  const result: SsoTeamMapping = {};

  for (const [key, v] of Object.entries(obj)) {
    if (key === "claim") {
      result.claim = assertNonEmptyString(v, "auth.sso.teams.claim", path);
    } else if (key === "assertedClaim") {
      result.assertedClaim = assertNonEmptyString(v, "auth.sso.teams.assertedClaim", path);
    } else if (key === "adminSubGroup") {
      const sub = assertNonEmptyString(v, "auth.sso.teams.adminSubGroup", path);
      // A sub-group name that contains "/" makes the path ambiguous: a
      // top-level group literally named "platform/admins" reports the same
      // path as the "admins" sub-group of "platform", and no rule in the sync
      // can separate the two. This file owns one half of that, so it refuses.
      if (sub.includes("/")) {
        err(
          `${path}: auth.sso.teams.adminSubGroup must not contain "/", got ${JSON.stringify(sub)}. Use a plain sub-group name such as "admins".`,
        );
      }
      result.adminSubGroup = sub;
    } else if (key === "groups") {
      const raw = assertStringArray(v, "auth.sso.teams.groups", path);
      result.groups = raw.map((entry, i) => {
        const group = entry.trim();
        // The sync mirrors a top-level group and its admin sub-group only, so
        // a deeper path listed here would mirror nothing and say nothing.
        const segments = group.split("/").filter((segment) => segment.length > 0);
        if (!group.startsWith("/") || segments.length !== 1) {
          err(
            `${path}: auth.sso.teams.groups[${i}] must be a top-level group path such as "/platform", got ${JSON.stringify(entry)}. Valet mirrors a top-level group and its admin sub-group only.`,
          );
        }
        return `/${segments[0]}`;
      });
    } else {
      err(`${path}: unknown key "auth.sso.teams.${key}". Remove it or check for a typo.`);
    }
  }

  // The sync tells "in no groups" from "no mapper configured" by reading one
  // claim when the other is absent. One name for both collapses that test,
  // and an absent group claim would then empty every user's teams.
  if (result.claim !== undefined && result.claim === result.assertedClaim) {
    err(
      `${path}: auth.sso.teams.claim and auth.sso.teams.assertedClaim are both ${JSON.stringify(result.claim)}. Give them different claim names; the second one proves the group mapper ran.`,
    );
  }

  return result;
}

function validateSso(value: unknown, path: string): { teams?: SsoTeamMapping } {
  const obj = assertRecord(value, "auth.sso", path);
  const result: { teams?: SsoTeamMapping } = {};
  for (const [key, v] of Object.entries(obj)) {
    if (key === "teams") {
      result.teams = validateSsoTeams(v, path);
    } else {
      err(`${path}: unknown key "auth.sso.${key}". Remove it or check for a typo.`);
    }
  }
  return result;
}

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
    } else if (key === "sso") {
      result.sso = validateSso(v, path);
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

function validateMcpServers(value: unknown, path: string): McpServerDecl[] {
  const arr = assertArray(value, "mcpServers", path);
  const entries = arr.map((item, i) => {
    const obj = assertRecord(item, `mcpServers[${i}]`, path);
    const entry: Partial<McpServerDecl> = {};

    for (const [key, v] of Object.entries(obj)) {
      if (key === "name") {
        const name = assertNonEmptyString(v, `mcpServers[${i}].name`, path);
        // The name becomes the action service, so it must survive as the
        // `<service>.<tool>` id prefix the policy engine and catalog use.
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
          err(
            `${path}: mcpServers[${i}].name must be a lowercase slug (letters, digits, "-", "_"), got ${JSON.stringify(name)}.`,
          );
        }
        entry.name = name;
      } else if (key === "displayName") {
        entry.displayName = assertNonEmptyString(v, `mcpServers[${i}].displayName`, path);
      } else if (key === "url") {
        const raw = assertNonEmptyString(v, `mcpServers[${i}].url`, path);
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          err(`${path}: mcpServers[${i}].url must be a valid URL, got ${JSON.stringify(raw)}.`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          err(
            `${path}: mcpServers[${i}].url must use http or https, got ${JSON.stringify(raw)}.`,
          );
        }
        entry.url = raw;
      } else if (key === "auth") {
        const authVal = assertString(v, `mcpServers[${i}].auth`, path);
        if (!MCP_SERVER_AUTH_MODES.has(authVal)) {
          err(
            `${path}: mcpServers[${i}].auth got "${authVal}", allowed values are none, oauth, api_key, bearer.`,
          );
        }
        entry.auth = authVal as McpServerDecl["auth"];
      } else if (key === "tokenEnv") {
        entry.tokenEnv = assertNonEmptyString(v, `mcpServers[${i}].tokenEnv`, path);
      } else if (key === "authQueryParam") {
        entry.authQueryParam = assertNonEmptyString(v, `mcpServers[${i}].authQueryParam`, path);
      } else if (key === "connectLabel") {
        entry.connectLabel = assertString(v, `mcpServers[${i}].connectLabel`, path);
      } else if (key === "description") {
        entry.description = assertString(v, `mcpServers[${i}].description`, path);
      } else if (key === "riskLevel") {
        const riskVal = assertString(v, `mcpServers[${i}].riskLevel`, path);
        if (!TOOL_POLICY_RISK_LEVELS.has(riskVal)) {
          err(
            `${path}: mcpServers[${i}].riskLevel got "${riskVal}", allowed values are low, medium, high, critical.`,
          );
        }
        entry.riskLevel = riskVal as McpServerDecl["riskLevel"];
      } else if (key === "enabled") {
        entry.enabled = assertBoolean(v, `mcpServers[${i}].enabled`, path);
      } else {
        err(`${path}: unknown key "mcpServers[${i}].${key}". Remove it or check for a typo.`);
      }
    }

    if (entry.name === undefined) err(`${path}: mcpServers[${i}].name is required.`);
    if (entry.url === undefined) err(`${path}: mcpServers[${i}].url is required.`);
    if (entry.auth === undefined) {
      err(
        `${path}: mcpServers[${i}].auth is required. Set one of none, oauth, api_key, bearer.`,
      );
    }

    // The file never holds secrets: `bearer` points at an env var, and only
    // `bearer` reads one — a tokenEnv on any other mode would be silently
    // inert, so it refuses.
    if (entry.auth === "bearer" && entry.tokenEnv === undefined) {
      err(
        `${path}: mcpServers[${i}].tokenEnv is required when auth is "bearer". Name the env var that holds the token.`,
      );
    }
    if (entry.auth !== "bearer" && entry.tokenEnv !== undefined) {
      err(
        `${path}: mcpServers[${i}].tokenEnv is only valid when auth is "bearer". Remove it, or set auth: bearer.`,
      );
    }
    // authQueryParam rewrites how a credential is SENT, so it needs a
    // credential to send: none has no credential, and oauth tokens are
    // Authorization-header bearer tokens by contract.
    if (entry.authQueryParam !== undefined && entry.auth !== "api_key" && entry.auth !== "bearer") {
      err(
        `${path}: mcpServers[${i}].authQueryParam is only valid when auth is "api_key" or "bearer". Remove it.`,
      );
    }
    if (entry.connectLabel !== undefined && entry.auth !== "api_key") {
      err(
        `${path}: mcpServers[${i}].connectLabel is only valid when auth is "api_key" (the manual connect UI). Remove it.`,
      );
    }

    return entry as McpServerDecl;
  });

  // A repeated name would collide on the action service (assemblePlugins
  // throws at boot) — report it here with both indices instead.
  const seen = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i]!.name;
    const prior = seen.get(name);
    if (prior !== undefined) {
      err(
        `${path}: mcpServers[${prior}] and mcpServers[${i}] both use the name ${JSON.stringify(name)}. Rename one.`,
      );
    }
    seen.set(name, i);
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
  if ("mcpServers" in raw) cfg.mcpServers = validateMcpServers(raw["mcpServers"], path);

  assertNoTeamGroupOverlap(cfg, path);

  return cfg;
}

/**
 * Rejects a config where a declared team and a mirrored group ask for the
 * same team name. Cross-section, so it runs here rather than inside
 * `validateAuth`: it needs `teams` and `auth` both built.
 *
 * The two would otherwise race across restarts — whichever source created
 * the row first would hold the name, and the loser would be skipped or would
 * fail boot. Catching it in the file turns an ordering accident into an
 * error the operator sees before anything is written.
 *
 * The comparison ignores case although `teams_org_name` does not. That is
 * the point: team `Platform` and group `/platform` do NOT collide in
 * Postgres, so they would produce two separate rows that read as one team in
 * the list. Changing the index instead would be a migration plus a behavior
 * change for teams that already exist.
 *
 * This check is the earliest of three, not the only one. It reports the
 * clash before anything is written, and it needs `groups` to be declared —
 * without that list, the file cannot know which groups the provider sends.
 * The reconciler (`config-reconcile.ts`) and the login sync
 * (`team-sync.ts`) fold the case again against the rows that actually
 * exist, which is what covers a deployment that mirrors every group.
 */
function assertNoTeamGroupOverlap(cfg: InstanceConfig, path: string): void {
  const groups = cfg.auth?.sso?.teams?.groups;
  if (!groups || !cfg.teams) return;

  const declared = new Map<string, string>();
  for (const team of cfg.teams) declared.set(team.name.trim().toLowerCase(), team.name);

  for (const group of groups) {
    const teamName = group.replace(/^\//, "");
    const clash = declared.get(teamName.toLowerCase());
    if (clash !== undefined) {
      err(
        `${path}: teams[].name "${clash}" and auth.sso.teams.groups "${group}" both name team "${teamName}". Rename the team, or remove the group from the list.`,
      );
    }
  }
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

/** The team mapping after env and file are reconciled. Every field resolved. */
export interface ResolvedSsoTeamMapping {
  claim: string;
  assertedClaim: string;
  adminSubGroup: string;
  groups?: string[];
}

/** One env variable and the file key that replaces it. */
interface MappingField {
  envVar: string;
  configKey: string;
  declared: string | undefined;
  envParsed: string;
}

/**
 * Both-set guard + merge for the three `auth.sso.teams` claim names.
 *
 * Per field, not per section: the three variables are independent, and an
 * operator may reasonably set only `AUTH_OIDC_TEAM_ADMIN_GROUP`. Same
 * precedence as `resolveAllowedEmailDomains` — both set fails boot, the file
 * wins when it declares the field, else the env-parsed value (which already
 * carries `auth/config.ts`'s defaults).
 *
 * `groups` has no env sibling, so it passes through unguarded.
 */
export function resolveSsoTeamMapping(
  cfg: InstanceConfig | null,
  env: NodeJS.ProcessEnv,
  envParsed: ResolvedSsoTeamMapping,
): ResolvedSsoTeamMapping {
  const configPath = env["VALET_CONFIG"];
  const declared = cfg?.auth?.sso?.teams;

  const fields: MappingField[] = [
    {
      envVar: "AUTH_OIDC_TEAM_CLAIM",
      configKey: "auth.sso.teams.claim",
      declared: declared?.claim,
      envParsed: envParsed.claim,
    },
    {
      envVar: "AUTH_OIDC_TEAM_ASSERTED_CLAIM",
      configKey: "auth.sso.teams.assertedClaim",
      declared: declared?.assertedClaim,
      envParsed: envParsed.assertedClaim,
    },
    {
      envVar: "AUTH_OIDC_TEAM_ADMIN_GROUP",
      configKey: "auth.sso.teams.adminSubGroup",
      declared: declared?.adminSubGroup,
      envParsed: envParsed.adminSubGroup,
    },
  ];

  const resolved: string[] = fields.map((field) => {
    if (Boolean(env[field.envVar]) && field.declared !== undefined) {
      err(`${field.envVar} is set and ${configPath} declares ${field.configKey}. Remove one.`);
    }
    return field.declared ?? field.envParsed;
  });

  const result: ResolvedSsoTeamMapping = {
    claim: resolved[0]!,
    assertedClaim: resolved[1]!,
    adminSubGroup: resolved[2]!,
  };
  if (declared?.groups !== undefined) result.groups = declared.groups;
  return result;
}
