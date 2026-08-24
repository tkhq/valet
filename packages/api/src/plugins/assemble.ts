/**
 * Plugin assembly (plugin-system-v2 plan Task 4).
 *
 * `assemblePlugins` flattens loader outputs (bundled registry, node_modules
 * scan, test overrides — one array per source, in priority order) into the
 * final plugin set a session/host uses. Loaders can legitimately return the
 * same plugin twice (e.g. a workspace plugin symlinked into node_modules AND
 * present in the bundled registry) — the earlier source wins, silently.
 * What must never collide is two DIFFERENT plugins claiming the same action
 * service; that's a real configuration error and throws loudly with both
 * plugin names named.
 *
 * `pluginSessionExtras` turns an assembled plugin set — plus the caller's
 * stored skills — into the pieces a session needs (tools/skills/roles). See
 * its own doc comment for the per-call cache-freshness constraint. It also
 * builds the `skill` tool (`plugins/skill-tool.ts`) so the assembled skills
 * reach the model.
 *
 * One skill name reaches the model, so a repeated name needs a rule. There
 * are two, and they differ on purpose:
 *
 *   - Two PLUGINS shipping one skill name THROWS. We ship the plugins, so a
 *     repeated name is a build-time bug and must be loud.
 *   - A STORED skill that repeats a name is SHADOWED, never thrown. Stored
 *     skills are user-supplied, and every session builder in
 *     `engine/host.ts` calls this function with no try/catch, so a throw
 *     would stop that person from starting any session at all. The shadowed
 *     entries come back in `shadowedSkills` so `/api/skills` can say what
 *     happened instead of dropping them in silence.
 */
import { pluginCatalogTools, type ActionPlugin, type ValetPlugin } from "@valet/engine";
import type { PinnedActionSpec, RoleSpec, SkillSource, ToolDef } from "@valet/engine";
import { buildSkillTool, SKILL_TOOL_NAME, type SkillToolOpts } from "./skill-tool.js";

export interface AssembledPlugins {
  plugins: ValetPlugin[];
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
}

/**
 * Flattens loader outputs (in priority order — earlier sources win) into
 * one deduped plugin set, plus a service→plugin index for Task 6's
 * ActionInvoker.
 *
 * Dedupe rule: a plugin `name` seen more than once (whether within one
 * source or across sources) keeps only the FIRST occurrence — this is
 * expected when a workspace plugin is discoverable via more than one
 * loader, so it is not an error.
 *
 * Collision rule: two DIFFERENT plugin names that each declare an
 * `ActionPlugin` for the same `service` IS an error (ambiguous routing for
 * that service's credentials and catalog entries) — throws naming both
 * plugins.
 *
 * Within a single source, two plugins sharing a `name` is a hard error (the
 * loader that produced them is broken); across sources it's the expected
 * dedupe case above and is not an error.
 */
export function assemblePlugins(sources: ValetPlugin[][]): AssembledPlugins {
  const plugins: ValetPlugin[] = [];
  const seenNames = new Set<string>();
  const actionPluginByService = new Map<
    string,
    { plugin: ValetPlugin; actionPlugin: ActionPlugin }
  >();

  for (const source of sources) {
    const seenInSource = new Set<string>();
    for (const plugin of source) {
      if (seenInSource.has(plugin.name)) {
        throw new Error(`duplicate plugin name "${plugin.name}" within a single plugin source`);
      }
      seenInSource.add(plugin.name);

      if (seenNames.has(plugin.name)) continue;
      seenNames.add(plugin.name);
      plugins.push(plugin);

      for (const actionPlugin of plugin.actions ?? []) {
        const existing = actionPluginByService.get(actionPlugin.service);
        if (existing && existing.plugin.name !== plugin.name) {
          throw new Error(
            `plugin service collision: "${actionPlugin.service}" is claimed by both ` +
              `"${existing.plugin.name}" and "${plugin.name}"`,
          );
        }
        actionPluginByService.set(actionPlugin.service, { plugin, actionPlugin });
      }
    }
  }

  return { plugins, actionPluginByService };
}

export interface PluginSessionExtras {
  tools: ToolDef[];
  skills: SkillSource[];
  roles: RoleSpec[];
  /** The `extraSkills` entries a name already in the set kept out. Empty for
   * a plugin-only call. `/api/skills` reports these rows as shadowed, so a
   * person can see why a skill they wrote never reaches a session. */
  shadowedSkills: SkillSource[];
}

/**
 * Splits `candidates` into the ones that keep their name and the ones a
 * name already in use shadows. `taken` holds the names that win; within
 * `candidates`, the first of a repeated name wins.
 *
 * Generic over anything with a `name` so the `/api/skills` listing marks
 * exactly the rows a session build drops, from one definition of the rule.
 */
export function partitionByName<T extends { name: string }>(
  taken: Iterable<string>,
  candidates: T[],
): { kept: T[]; shadowed: T[] } {
  const seen = new Set(taken);
  const kept: T[] = [];
  const shadowed: T[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.name)) {
      shadowed.push(candidate);
      continue;
    }
    seen.add(candidate.name);
    kept.push(candidate);
  }
  return { kept, shadowed };
}

/**
 * The skill set a session sees: every plugin skill, then the stored skills
 * whose names no plugin skill already holds (first of a repeated stored name
 * wins). This is `pluginSessionExtras`'s skill rule, exported on its own so
 * the host's `skillsProvider` (the refresh path behind
 * `Session.refreshCommandRegistry()`) re-reads stored skills without
 * rebuilding the plugin tool catalog on every refresh.
 */
export function mergedSkillSources(
  plugins: ValetPlugin[],
  extraSkills: SkillSource[],
): { skills: SkillSource[]; shadowed: SkillSource[] } {
  const pluginSkills = collectSkills(plugins);
  const { kept, shadowed } = partitionByName(
    pluginSkills.map((s) => s.name),
    extraSkills,
  );
  return { skills: [...pluginSkills, ...kept], shadowed };
}

/**
 * Builds the session-facing extras (tools/skills/roles) from an assembled
 * plugin set.
 *
 * IMPORTANT: this builds a FRESH `pluginCatalogTools({ plugins })` result on
 * every call — never hoist/cache the returned `tools` array in module
 * scope. `pluginCatalogTools`'s dynamic-action-resolution TTL cache
 * (`resolveActions`) lives on the `Catalog` instance it returns, i.e. it is
 * per-call/per-session state. Caching the tools array across sessions would
 * leak one session's dynamically-resolved actions (and their TTL clock)
 * into every other session sharing the plugin set.
 *
 * `pins` names the actions the host also wants as direct, model-visible
 * tools (see `plugins/pinned-actions.ts` for why any action gets one). A
 * pin the catalog refuses is logged, never thrown: the action stays
 * reachable through `list_tools`/`call_tool`, and this function runs on
 * every session build with no try/catch above it.
 */
export function pluginSessionExtras(
  plugins: ValetPlugin[],
  extraSkills: SkillSource[] = [],
  pins: readonly PinnedActionSpec[] = [],
  skillToolOpts?: SkillToolOpts,
): PluginSessionExtras {
  const actionPlugins = plugins.flatMap((p) => withCredentialRequirement(p));
  const tools =
    actionPlugins.length > 0
      ? pluginCatalogTools({
          plugins: actionPlugins,
          pins,
          // The `skill` tool is appended below, after the catalog has
          // already chosen its pinned names — so the catalog has to be told
          // that name is taken.
          reservedToolNames: [SKILL_TOOL_NAME],
          onPinRejected: warnPinRejected,
        })
      : [];
  const { skills, shadowed } = mergedSkillSources(plugins, extraSkills);
  const roles = plugins.flatMap((p) => p.roles ?? []);

  // The `skill` tool is what makes these skills reachable — without it the
  // markdown is inert. Appended after the catalog tools so `list_tools`/
  // `call_tool` keep their positions.
  const skillTool = buildSkillTool(skills, skillToolOpts);
  if (skillTool) tools.push(skillTool);

  return { tools, skills, roles, shadowedSkills: shadowed };
}

/**
 * Pin ids already reported, so one bad host constant does not print a
 * warning for every session build in the process. The set holds ids only —
 * it caches no catalog state, so the freshness rule above still holds.
 */
const warnedPins = new Set<string>();

function warnPinRejected(actionId: string, reason: string): void {
  if (warnedPins.has(actionId)) return;
  warnedPins.add(actionId);
  console.warn(`plugin pin "${actionId}" refused: ${reason}`);
}

/**
 * Concatenates every plugin's skills, and rejects a duplicate name.
 *
 * A skill name is a lookup key: `Session.skills` indexes by it and the
 * `skill` tool resolves by it. Two skills with one name means one of them
 * is unreachable, which is a configuration error of the same kind as the
 * action-service collision above — so it throws, naming both plugins.
 */
function collectSkills(plugins: ValetPlugin[]): SkillSource[] {
  const skills: SkillSource[] = [];
  const ownerByName = new Map<string, string>();

  for (const plugin of plugins) {
    for (const skill of plugin.skills ?? []) {
      const owner = ownerByName.get(skill.name);
      if (owner !== undefined) {
        throw new Error(
          `plugin skill collision: "${skill.name}" is shipped by both ` +
            `"${owner}" and "${plugin.name}". Rename one of them.`,
        );
      }
      ownerByName.set(skill.name, plugin.name);
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * A plugin that declares a credential spec for a service is saying its
 * actions need that credential — infer `requiresCredential` so
 * `list_tools` hides the service's tools while unconnected (the catalog's
 * unfiltered-listing rule). An explicit `requiresCredential` on the
 * ActionPlugin wins either way; credential-less plugins (workflows) stay
 * unflagged and are never probed.
 *
 * A declaration that omits `service` names the PLUGIN's service (the
 * `decl.service ?? plugin.name` default every other consumer applies) —
 * without that fallback here, every such plugin (slack, google-*, linear)
 * silently lost the inference and `list_tools` listed their tools while
 * unconnected. Exported for its tests.
 */
export function withCredentialRequirement(plugin: ValetPlugin): ActionPlugin[] {
  const credentialServices = new Set(
    (plugin.credentials ?? []).map((c) => c.service ?? plugin.name),
  );
  return (plugin.actions ?? []).map((actionPlugin) => {
    if (actionPlugin.requiresCredential !== undefined) return actionPlugin;
    const credService = actionPlugin.credentialService ?? actionPlugin.service;
    if (!credentialServices.has(credService)) return actionPlugin;
    return { ...actionPlugin, requiresCredential: true };
  });
}
