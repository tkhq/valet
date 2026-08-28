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
import { qualifiedActionId } from "../plugins/action-id.js";
import type {
  AssistantBehavior,
  AssistantIntegrationEntry,
  AssistantIntegrationsBehavior,
  AssistantSkillsBehavior,
} from "../wire/types.js";

/** Size caps for a stored behavior config. The blob is echoed inside every
 * `GET /api/assistants` response the rail, chat route and session header
 * fetch, so an unbounded value taxes every client on every list. The caps sit
 * far past any real config (the skill catalog itself is bounded at 10k). */
export const BEHAVIOR_MAX_SKILL_NAMES = 500;
export const BEHAVIOR_MAX_INTEGRATION_ENTRIES = 100;
export const BEHAVIOR_MAX_EXCLUDE_ACTIONS = 200;
const MAX_ID_CHARS = 200;

/** Corrective validation error for a PATCH/POST body value, or null when
 * `input` is a structurally valid AssistantBehavior. Rejects unknown keys at
 * every level: a stored config is echoed to every client and re-sent by the
 * editor's save handlers, so junk admitted once is persisted forever. */
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

function unknownKey(record: Record<string, unknown>, known: readonly string[]): string | null {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) return key;
  }
  return null;
}

function validateSkills(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return "behavior.skills must be { mode: 'all' } or { mode: 'allowlist', names: [...] }.";
  }
  const record = input as Record<string, unknown>;
  const junk = unknownKey(record, ["mode", "names"]);
  if (junk) {
    return `behavior.skills.${junk} is not a recognized field. Send 'mode' and, for an allowlist, 'names'.`;
  }
  if (record.mode === "all") {
    if (record.names !== undefined) {
      return "behavior.skills.names only applies to mode 'allowlist'. Remove it, or set mode: 'allowlist'.";
    }
    return null;
  }
  if (record.mode !== "allowlist") return "behavior.skills.mode must be 'all' or 'allowlist'.";
  if (!Array.isArray(record.names) || record.names.some((n) => typeof n !== "string")) {
    return "behavior.skills.names must be an array of skill names.";
  }
  if (record.names.length > BEHAVIOR_MAX_SKILL_NAMES) {
    return `behavior.skills.names is limited to ${BEHAVIOR_MAX_SKILL_NAMES} entries. Remove some, or set mode: 'all'.`;
  }
  if (record.names.some((n) => (n as string).length > MAX_ID_CHARS)) {
    return `behavior.skills.names entries are limited to ${MAX_ID_CHARS} characters each.`;
  }
  return null;
}

function validateIntegrations(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return "behavior.integrations must be { mode: 'all' } or { mode: 'allowlist', entries: [...] }.";
  }
  const record = input as Record<string, unknown>;
  const junk = unknownKey(record, ["mode", "entries"]);
  if (junk) {
    return `behavior.integrations.${junk} is not a recognized field. Send 'mode' and, for an allowlist, 'entries'.`;
  }
  if (record.mode === "all") {
    if (record.entries !== undefined) {
      return "behavior.integrations.entries only applies to mode 'allowlist'. Remove it, or set mode: 'allowlist'.";
    }
    return null;
  }
  if (record.mode !== "allowlist") {
    return "behavior.integrations.mode must be 'all' or 'allowlist'.";
  }
  if (!Array.isArray(record.entries)) {
    return "behavior.integrations.entries must be an array of { service, excludeActions? }.";
  }
  if (record.entries.length > BEHAVIOR_MAX_INTEGRATION_ENTRIES) {
    return `behavior.integrations.entries is limited to ${BEHAVIOR_MAX_INTEGRATION_ENTRIES} entries. Remove some, or set mode: 'all'.`;
  }
  for (const entry of record.entries) {
    if (typeof entry !== "object" || entry === null) {
      return "behavior.integrations.entries must be an array of { service, excludeActions? }.";
    }
    const e = entry as Record<string, unknown>;
    const entryJunk = unknownKey(e, ["service", "excludeActions"]);
    if (entryJunk) {
      return `behavior.integrations.entries[].${entryJunk} is not a recognized field. Send 'service' and optionally 'excludeActions'.`;
    }
    if (typeof e.service !== "string" || e.service.length === 0 || e.service.length > MAX_ID_CHARS) {
      return "behavior.integrations.entries[].service must be a service id, e.g. 'github'.";
    }
    if (
      e.excludeActions !== undefined &&
      (!Array.isArray(e.excludeActions) ||
        e.excludeActions.some((a) => typeof a !== "string" || (a as string).length > MAX_ID_CHARS))
    ) {
      return "behavior.integrations.entries[].excludeActions must be an array of action ids, e.g. 'github.create_issue'.";
    }
    if (Array.isArray(e.excludeActions) && e.excludeActions.length > BEHAVIOR_MAX_EXCLUDE_ACTIONS) {
      return `behavior.integrations.entries[].excludeActions is limited to ${BEHAVIOR_MAX_EXCLUDE_ACTIONS} entries.`;
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

/** Stores the NORMALIZED config, never the raw request object: validation
 * rejects unknown keys, and normalization rebuilds the known fields anyway,
 * so a value that slips past both can still never reach the column. */
export function serializeAssistantBehavior(
  behavior: AssistantBehavior | null | undefined,
): string | null {
  if (behavior === null || behavior === undefined) return null;
  return JSON.stringify(normalizeAssistantBehavior(behavior));
}

/** Rebuilds a behavior config from its known fields only, with stable key
 * order — so equal configs serialize to equal strings (the PATCH route's
 * changed-value check compares the serialized columns). */
export function normalizeAssistantBehavior(behavior: AssistantBehavior): AssistantBehavior {
  const out: AssistantBehavior = {};
  if (behavior.skills !== undefined) {
    out.skills =
      behavior.skills.mode === "all"
        ? { mode: "all" }
        : { mode: "allowlist", names: [...behavior.skills.names] };
  }
  if (behavior.integrations !== undefined) {
    out.integrations =
      behavior.integrations.mode === "all"
        ? { mode: "all" }
        : {
            mode: "allowlist",
            entries: behavior.integrations.entries.map((e) => ({
              service: e.service,
              ...(e.excludeActions !== undefined && e.excludeActions.length > 0
                ? { excludeActions: [...e.excludeActions] }
                : {}),
            })),
          };
  }
  return out;
}

/**
 * The plugin set one assistant's session builds from. Filters each plugin's
 * ActionPlugins by the integrations config (allowlisted services only, then
 * excluded action ids dropped — statically declared AND dynamically resolved,
 * via a `resolveActions` wrapper) and each plugin's skills by the skills
 * config. Never drops a whole plugin object: a plugin whose service is not
 * allowlisted keeps its skills, because the skills config governs those.
 *
 * `pinnedActionIds` are never gated (assistant-editor design, "Never gated"):
 * a pin is substrate the host itself injects — `workflows.patch_workflow`
 * exists so the workflow editor panel saves instead of describing — so the
 * filter keeps a pinned action even when its service is not allowlisted, and
 * `excludeActions` cannot name it away.
 */
export function applyBehaviorToPlugins(
  plugins: ValetPlugin[],
  behavior: AssistantBehavior | null,
  pinnedActionIds: ReadonlySet<string> = new Set(),
): ValetPlugin[] {
  if (behavior === null) return plugins;
  const integrations = behavior.integrations;
  const skillNames = allowedSkillNames(behavior.skills);
  if ((integrations === undefined || integrations.mode === "all") && skillNames === null) {
    return plugins;
  }

  return plugins.map((plugin) => ({
    ...plugin,
    actions: filterActionPlugins(plugin.actions ?? [], integrations, pinnedActionIds),
    skills: skillNames === null ? plugin.skills : (plugin.skills ?? []).filter((s) => skillNames.has(s.name)),
  }));
}

function filterActionPlugins(
  actionPlugins: ActionPlugin[],
  integrations: AssistantIntegrationsBehavior | undefined,
  pinned: ReadonlySet<string>,
): ActionPlugin[] {
  if (integrations === undefined || integrations.mode === "all") return actionPlugins;
  const bySvc = new Map<string, AssistantIntegrationEntry>(
    integrations.entries.map((e) => [e.service, e]),
  );
  const kept: ActionPlugin[] = [];
  for (const actionPlugin of actionPlugins) {
    const entry = bySvc.get(actionPlugin.service);
    const excluded = new Set(entry?.excludeActions ?? []);
    const keepAction = (a: PluginAction) => {
      const fqid = qualifiedActionId(actionPlugin.service, a);
      if (pinned.has(fqid)) return true;
      if (entry === undefined) return false;
      return !excluded.has(fqid);
    };
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
    // A non-allowlisted plugin survives only for the pinned actions it
    // carries; with none, it leaves the catalog entirely.
    if (entry === undefined && wrapped.actions.length === 0) continue;
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
