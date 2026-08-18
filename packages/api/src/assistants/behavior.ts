/**
 * Per-assistant behavior config (`docs/specs/2026-08-18-assistant-editor-design.md`).
 *
 * Pure functions only — the routes validate with `validateAssistantBehavior`,
 * the host parses stored JSON with `parseAssistantBehavior` and applies it
 * with `applyBehaviorToPlugins`/`filterSkillSources`. Null behavior always
 * means "everything", which is what every pre-config assistant row has.
 *
 * Attachment is capability shaping, not a security boundary: action policies
 * and approval gates stay the enforcement layer. That is why
 * `parseAssistantBehavior` fails OPEN (logged) on JSON that does not parse —
 * a bug here must not stop the assistant from waking.
 */
import type { ActionPlugin, PluginAction, SkillSource, ValetPlugin } from "@valet/engine";
import type {
  AssistantBehavior,
  AssistantIntegrationEntry,
  AssistantIntegrationsBehavior,
  AssistantSkillsBehavior,
} from "../wire/types.js";

/** Corrective validation error for a PATCH/POST body value, or null when
 * `input` is a structurally valid AssistantBehavior. */
export function validateAssistantBehavior(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "behavior must be an object with optional 'skills' and 'integrations'.";
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "skills" && key !== "integrations") {
      return `behavior.${key} is not a recognized field. Send 'skills' and/or 'integrations'.`;
    }
  }
  if (record.skills !== undefined) {
    const err = validateSkills(record.skills);
    if (err) return err;
  }
  if (record.integrations !== undefined) {
    const err = validateIntegrations(record.integrations);
    if (err) return err;
  }
  return null;
}

function validateSkills(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return "behavior.skills must be { mode: 'all' } or { mode: 'allowlist', names: [...] }.";
  }
  const record = input as Record<string, unknown>;
  if (record.mode === "all") return null;
  if (record.mode !== "allowlist") return "behavior.skills.mode must be 'all' or 'allowlist'.";
  if (!Array.isArray(record.names) || record.names.some((n) => typeof n !== "string")) {
    return "behavior.skills.names must be an array of skill names.";
  }
  return null;
}

function validateIntegrations(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return "behavior.integrations must be { mode: 'all' } or { mode: 'allowlist', entries: [...] }.";
  }
  const record = input as Record<string, unknown>;
  if (record.mode === "all") return null;
  if (record.mode !== "allowlist") {
    return "behavior.integrations.mode must be 'all' or 'allowlist'.";
  }
  if (!Array.isArray(record.entries)) {
    return "behavior.integrations.entries must be an array of { service, excludeActions? }.";
  }
  for (const entry of record.entries) {
    if (typeof entry !== "object" || entry === null) {
      return "behavior.integrations.entries must be an array of { service, excludeActions? }.";
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.service !== "string" || e.service.length === 0) {
      return "behavior.integrations.entries[].service must be a service id, e.g. 'github'.";
    }
    if (
      e.excludeActions !== undefined &&
      (!Array.isArray(e.excludeActions) || e.excludeActions.some((a) => typeof a !== "string"))
    ) {
      return "behavior.integrations.entries[].excludeActions must be an array of action ids, e.g. 'github.create_issue'.";
    }
  }
  return null;
}

/** The stored `assistants.behavior` text, parsed. Fails OPEN (logged, null =
 * everything): PATCH validates before writing, so unparseable JSON is a bug,
 * and a bug here must not stop the assistant from waking. */
export function parseAssistantBehavior(
  raw: string | null,
  assistantId: string,
): AssistantBehavior | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const err = validateAssistantBehavior(parsed);
    if (err) throw new Error(err);
    return parsed as AssistantBehavior;
  } catch (err) {
    console.warn(
      `assistants: behavior JSON on ${assistantId} is invalid (${String(err)}); ` +
        `applying no restriction`,
    );
    return null;
  }
}

export function serializeAssistantBehavior(
  behavior: AssistantBehavior | null | undefined,
): string | null {
  if (behavior === null || behavior === undefined) return null;
  return JSON.stringify(behavior);
}

/** Fully-qualified action id, the plugin-catalog convention the plugins
 * route also applies (`routes/plugins.ts`). */
function fqActionId(service: string, id: string): string {
  return id.includes(".") ? id : `${service}.${id}`;
}

/**
 * The plugin set one assistant's session builds from. Filters each plugin's
 * ActionPlugins by the integrations config (allowlisted services only, then
 * excluded action ids dropped — statically declared AND dynamically resolved,
 * via a `resolveActions` wrapper) and each plugin's skills by the skills
 * config. Never drops a whole plugin object: a plugin whose service is not
 * allowlisted keeps its skills, because the skills config governs those.
 */
export function applyBehaviorToPlugins(
  plugins: ValetPlugin[],
  behavior: AssistantBehavior | null,
): ValetPlugin[] {
  if (behavior === null) return plugins;
  const integrations = behavior.integrations;
  const skillNames = allowedSkillNames(behavior.skills);
  if ((integrations === undefined || integrations.mode === "all") && skillNames === null) {
    return plugins;
  }

  return plugins.map((plugin) => ({
    ...plugin,
    actions: filterActionPlugins(plugin.actions ?? [], integrations),
    skills: skillNames === null ? plugin.skills : (plugin.skills ?? []).filter((s) => skillNames.has(s.name)),
  }));
}

function filterActionPlugins(
  actionPlugins: ActionPlugin[],
  integrations: AssistantIntegrationsBehavior | undefined,
): ActionPlugin[] {
  if (integrations === undefined || integrations.mode === "all") return actionPlugins;
  const bySvc = new Map<string, AssistantIntegrationEntry>(
    integrations.entries.map((e) => [e.service, e]),
  );
  const kept: ActionPlugin[] = [];
  for (const actionPlugin of actionPlugins) {
    const entry = bySvc.get(actionPlugin.service);
    if (entry === undefined) continue;
    const excluded = new Set(entry.excludeActions ?? []);
    const keepAction = (a: PluginAction) => !excluded.has(fqActionId(actionPlugin.service, a.id));
    const wrapped: ActionPlugin = {
      ...actionPlugin,
      actions: actionPlugin.actions.filter(keepAction),
      ...(actionPlugin.resolveActions
        ? {
            resolveActions: async (ctx: Parameters<NonNullable<ActionPlugin["resolveActions"]>>[0]) =>
              (await actionPlugin.resolveActions!(ctx)).filter(keepAction),
          }
        : {}),
    };
    kept.push(wrapped);
  }
  return kept;
}

function allowedSkillNames(skills: AssistantSkillsBehavior | undefined): Set<string> | null {
  if (skills === undefined || skills.mode === "all") return null;
  return new Set(skills.names);
}

/** Stored skills, filtered by the skills allowlist. Plugin skills go through
 * `applyBehaviorToPlugins`; this handles the `listSkillSourcesFor` half. */
export function filterSkillSources(
  skills: SkillSource[],
  behavior: AssistantBehavior | null,
): SkillSource[] {
  const names = behavior === null ? null : allowedSkillNames(behavior.skills);
  if (names === null) return skills;
  return skills.filter((s) => names.has(s.name));
}
