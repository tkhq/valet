/**
 * The ValetPlugin manifest — the single seam between plugin packages and
 * hosts (spec: docs/specs/2026-07-13-plugin-system-v2-design.md). Composes
 * only engine-owned types; the engine gains no dependencies.
 *
 * Entry-point convention: a plugin package declares
 * `"valet": { "plugin": "./dist/plugin.js" }` in package.json; that
 * module's default export is a ValetPlugin, or a
 * `() => ValetPlugin | Promise<ValetPlugin>` factory. The marker's presence
 * is the whole contract — a package without it is not a plugin.
 *
 * No `transports` field yet: the v2 ChannelTransport contract lands with
 * the first channel plugin (Telegram, Phase 7) and the field is added then.
 */
import type { ActionPlugin } from "./plugin-catalog.js";
import type { RiskLevel, SignalContent, SkillSource, RoleSpec } from "./types.js";

export interface CredentialDeclaration {
  /** Service the credential is stored under. Defaults to the plugin name. */
  service?: string;
  type: "oauth2" | "api_key" | "bot_token" | "service_account";
  /** OAuth scopes, for oauth2 declarations. */
  scopes?: string[];
  /** Keys the plugin's actions read off the resolved Credential (e.g. ["accessToken"]). */
  configKeys: string[];
  /** Human copy for connect UI. */
  connectLabel?: string;
}

/** A webhook event that passed signature verification. */
export interface VerifiedEvent {
  eventType: string;
  deliveryId: string;
  payload: unknown;
}

export interface TriggerDef {
  /** e.g. "github.pull_request" */
  id: string;
  service: string;
  description: string;
  /**
   * Signature verification over the exact raw request bytes, BEFORE any
   * parsing. Return null to reject. May be async (HMAC via node/web crypto).
   */
  verify(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): VerifiedEvent | null | Promise<VerifiedEvent | null>;
  /** Normalize a verified event into an admissible signal. */
  toSignal(event: VerifiedEvent): {
    signal: SignalContent;
    dispatchId: string;
    conversationKey?: string;
  };
}

export interface ValetPlugin {
  /** Plugin id, e.g. "github". Unique across loaded plugins. */
  name: string;
  version: string;
  description?: string;
  actions?: ActionPlugin[];
  triggers?: TriggerDef[];
  skills?: SkillSource[];
  roles?: RoleSpec[];
  credentials?: CredentialDeclaration[];
}

export interface PluginValidationIssue {
  path: string;
  message: string;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const CREDENTIAL_TYPES = ["oauth2", "api_key", "bot_token", "service_account"] as const;

/**
 * Structural validation of an unknown value as a ValetPlugin. Hand-rolled
 * rather than a TypeBox schema because manifests carry functions (execute,
 * verify, toSignal, resolveActions), which JSON Schema cannot express.
 * Collects every issue instead of failing fast so quarantine logs are
 * actionable in one pass.
 */
export function validateValetPlugin(
  value: unknown,
): { ok: true; plugin: ValetPlugin } | { ok: false; issues: PluginValidationIssue[] } {
  const issues: PluginValidationIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: "", message: "manifest must be an object" }] };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.name !== "string" || !NAME_RE.test(v.name)) {
    issues.push({ path: "name", message: "required string matching /^[a-z][a-z0-9-]*$/" });
  }
  if (typeof v.version !== "string" || v.version.length === 0) {
    issues.push({ path: "version", message: "required non-empty string" });
  }
  if (v.description !== undefined && typeof v.description !== "string") {
    issues.push({ path: "description", message: "must be a string when present" });
  }

  checkArray(v.actions, "actions", issues, (p, path) => {
    const plugin = asRecord(p, path, issues);
    if (!plugin) return;
    if (typeof plugin.service !== "string" || plugin.service.length === 0) {
      issues.push({ path: `${path}.service`, message: "required non-empty string" });
    }
    if (plugin.resolveActions !== undefined && typeof plugin.resolveActions !== "function") {
      issues.push({ path: `${path}.resolveActions`, message: "must be a function when present" });
    }
    if (!Array.isArray(plugin.actions)) {
      issues.push({ path: `${path}.actions`, message: "required array" });
      return;
    }
    plugin.actions.forEach((a, i) => {
      const action = asRecord(a, `${path}.actions[${i}]`, issues);
      if (!action) return;
      for (const key of ["id", "name", "description"] as const) {
        if (typeof action[key] !== "string" || action[key].length === 0) {
          issues.push({ path: `${path}.actions[${i}].${key}`, message: "required non-empty string" });
        }
      }
      if (!RISK_LEVELS.includes(action.riskLevel as RiskLevel)) {
        issues.push({ path: `${path}.actions[${i}].riskLevel`, message: `must be one of ${RISK_LEVELS.join("|")}` });
      }
      if (typeof action.parameters !== "object" || action.parameters === null) {
        issues.push({ path: `${path}.actions[${i}].parameters`, message: "required schema object" });
      }
      if (typeof action.execute !== "function") {
        issues.push({ path: `${path}.actions[${i}].execute`, message: "required function" });
      }
    });
  });

  checkArray(v.triggers, "triggers", issues, (t, path) => {
    const trigger = asRecord(t, path, issues);
    if (!trigger) return;
    for (const key of ["id", "service", "description"] as const) {
      if (typeof trigger[key] !== "string" || trigger[key].length === 0) {
        issues.push({ path: `${path}.${key}`, message: "required non-empty string" });
      }
    }
    for (const key of ["verify", "toSignal"] as const) {
      if (typeof trigger[key] !== "function") {
        issues.push({ path: `${path}.${key}`, message: "required function" });
      }
    }
  });

  checkArray(v.skills, "skills", issues, (s, path) => {
    const skill = asRecord(s, path, issues);
    if (!skill) return;
    if (typeof skill.name !== "string" || skill.name.length === 0) {
      issues.push({ path: `${path}.name`, message: "required non-empty string" });
    }
    if (typeof skill.content !== "string") {
      issues.push({ path: `${path}.content`, message: "required string" });
    }
  });

  checkArray(v.roles, "roles", issues, (r, path) => {
    const role = asRecord(r, path, issues);
    if (!role) return;
    if (typeof role.name !== "string" || role.name.length === 0) {
      issues.push({ path: `${path}.name`, message: "required non-empty string" });
    }
    if (typeof role.content !== "string") {
      issues.push({ path: `${path}.content`, message: "required string" });
    }
  });

  checkArray(v.credentials, "credentials", issues, (c, path) => {
    const cred = asRecord(c, path, issues);
    if (!cred) return;
    if (!CREDENTIAL_TYPES.includes(cred.type as (typeof CREDENTIAL_TYPES)[number])) {
      issues.push({ path: `${path}.type`, message: `must be one of ${CREDENTIAL_TYPES.join("|")}` });
    }
    if (!Array.isArray(cred.configKeys) || cred.configKeys.some((k) => typeof k !== "string")) {
      issues.push({ path: `${path}.configKeys`, message: "required string array" });
    }
    if (cred.service !== undefined && typeof cred.service !== "string") {
      issues.push({ path: `${path}.service`, message: "must be a string when present" });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plugin: value as ValetPlugin };
}

function checkArray(
  value: unknown,
  field: string,
  issues: PluginValidationIssue[],
  each: (item: unknown, path: string) => void,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path: field, message: "must be an array when present" });
    return;
  }
  value.forEach((item, i) => each(item, `${field}[${i}]`));
}

function asRecord(
  value: unknown,
  path: string,
  issues: PluginValidationIssue[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    issues.push({ path, message: "must be an object" });
    return null;
  }
  return value as Record<string, unknown>;
}
