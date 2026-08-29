/**
 * Plugin entitlements — the org-scope half of the plugin feature-flag rail
 * (docs/specs/2026-08-29-plugin-entitlements-design.md).
 *
 * An org admin sets, per plugin, one of three modes:
 *  - `off`   — nobody in the org may use the plugin.
 *  - `all`   — every member of the org may use it. This is the DEFAULT when an
 *              org has no entry for a plugin, so an instance-loaded plugin is
 *              on for everyone until an admin narrows it.
 *  - `teams` — only members of the listed teams may use it.
 *
 * The instance (deployment) switch is a separate layer: a plugin absent from
 * the loaded set is off for the whole instance, regardless of this value.
 * Effective access = instance-loaded AND the org mode admits the user.
 */
export type PluginEntitlementMode = 'off' | 'all' | 'teams';

export interface PluginEntitlement {
  mode: PluginEntitlementMode;
  /** Team ids for `teams` mode. Ignored (and normally empty) for `off`/`all`. */
  teamIds: string[];
}
