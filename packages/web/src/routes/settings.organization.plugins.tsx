import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type {
  OrgPluginWire,
  PluginEntitlementModeWire,
  TeamSummary,
} from "@valet/api/wire";
import { Section } from "~/components/settings/section";
import { Badge, Checkbox, RadioCard, Spinner } from "~/components/primitives";
import { useOrg, useOrgPlugins, usePatchOrgPlugin, useTeams } from "~/api/settings";

/**
 * `/settings/organization/plugins` — Organization · Plugins
 * (plugin-entitlements design). One block per gateable plugin: off / all
 * users / specific teams, with a team picker under "specific teams". Org
 * admin edits; a member sees the current state read-only. A plugin the
 * deployment turned off (`instanceEnabled: false`) renders disabled with an
 * "Unavailable on this deployment" badge — an admin cannot enable it.
 *
 * The nested route inherits `OrgRouteGuard` from `settings.organization.tsx`,
 * so it is already gated on org-mode + admin (a non-admin never reaches it
 * from the rail, but the read is member-safe if they do).
 */
export const Route = createFileRoute("/settings/organization/plugins")({
  component: OrganizationPluginsPage,
});

const MODES: ReadonlyArray<{ id: PluginEntitlementModeWire; label: string; blurb: string }> = [
  { id: "off", label: "Off", blurb: "No one in your org can use this plugin." },
  { id: "all", label: "All users", blurb: "Every member of your org can use it." },
  { id: "teams", label: "Specific teams", blurb: "Only members of the teams you pick." },
];

export function OrganizationPluginsPage() {
  const orgQ = useOrg();
  const pluginsQ = useOrgPlugins();
  const teamsQ = useTeams();

  const isAdmin = orgQ.data?.callerRole === "admin";
  const teams = teamsQ.data?.teams ?? [];

  return (
    <Section
      title="Plugins"
      description="Choose who in your organization can use each plugin."
    >
      {pluginsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {pluginsQ.error && (
        <div className="py-4 text-sm text-danger-500">Failed to load plugins.</div>
      )}

      {pluginsQ.data && pluginsQ.data.plugins.length === 0 && (
        <div className="py-4 text-sm text-muted">
          No gateable plugins are loaded on this deployment.
        </div>
      )}

      {pluginsQ.data?.plugins.map((plugin) => (
        <PluginRow key={plugin.name} plugin={plugin} teams={teams} canEdit={!!isAdmin} />
      ))}
    </Section>
  );
}

function PluginRow({
  plugin,
  teams,
  canEdit,
}: {
  plugin: OrgPluginWire;
  teams: TeamSummary[];
  canEdit: boolean;
}) {
  const patch = usePatchOrgPlugin();

  // Local edit state, synced from the server entitlement. `userTouched` keeps
  // an in-flight local edit from being clobbered when the query refetches
  // (mount-time-state-from-props rule). Team ids are held in a Set, keyed by
  // team id everywhere — never by list index.
  const [mode, setMode] = useState<PluginEntitlementModeWire>(plugin.entitlement.mode);
  const [teamIds, setTeamIds] = useState<Set<string>>(
    () => new Set(plugin.entitlement.teamIds),
  );
  const userTouched = useRef(false);

  useEffect(() => {
    if (userTouched.current) return;
    setMode(plugin.entitlement.mode);
    setTeamIds(new Set(plugin.entitlement.teamIds));
  }, [plugin.entitlement.mode, plugin.entitlement.teamIds]);

  const disabled = !canEdit || !plugin.instanceEnabled || patch.isPending;

  function save(nextMode: PluginEntitlementModeWire, nextTeamIds: Set<string>) {
    userTouched.current = true;
    patch.mutate(
      { name: plugin.name, body: { mode: nextMode, teamIds: [...nextTeamIds] } },
      {
        // Let the invalidated queries win again after a settled write, so a
        // change from another admin or a server correction re-syncs here.
        onSettled: () => {
          userTouched.current = false;
        },
      },
    );
  }

  function chooseMode(next: PluginEntitlementModeWire) {
    if (next === mode) return;
    setMode(next);
    save(next, teamIds);
  }

  function toggleTeam(teamId: string, checked: boolean) {
    const next = new Set(teamIds);
    if (checked) next.add(teamId);
    else next.delete(teamId);
    setTeamIds(next);
    save(mode, next);
  }

  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">{plugin.label}</span>
            {!plugin.instanceEnabled && (
              <Badge variant="neutral">Unavailable on this deployment</Badge>
            )}
          </div>
          {plugin.description && (
            <p className="mt-0.5 text-xs text-muted">{plugin.description}</p>
          )}
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={`${plugin.label} access`}
        className="grid gap-2 sm:grid-cols-3"
      >
        {MODES.map((m) => (
          <RadioCard
            key={m.id}
            title={m.label}
            description={m.blurb}
            ariaLabel={m.label}
            selected={m.id === mode}
            disabled={disabled}
            onSelect={() => chooseMode(m.id)}
          />
        ))}
      </div>

      {mode === "teams" && (
        <div className="rounded-md border border-line p-3">
          {teams.length === 0 ? (
            <p className="text-xs text-muted">
              Create a team first in Settings → Teams.
            </p>
          ) : (
            <ul className="grid gap-2">
              {teams.map((team) => {
                const checkboxId = `plugin-${plugin.name}-team-${team.id}`;
                return (
                  <li key={team.id} className="flex items-center gap-2">
                    <Checkbox
                      id={checkboxId}
                      checked={teamIds.has(team.id)}
                      disabled={disabled}
                      onCheckedChange={(v) => toggleTeam(team.id, v)}
                      aria-label={team.name}
                    />
                    <label
                      htmlFor={checkboxId}
                      className="text-sm text-ink select-none"
                    >
                      {team.name}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {patch.error && (
        <p className="text-xs text-danger-500">{patch.error.message}</p>
      )}
    </div>
  );
}
