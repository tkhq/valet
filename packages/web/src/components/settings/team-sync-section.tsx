import { useState } from "react";
import { Button, ConfirmDialog, Input, Switch } from "~/components/primitives";
import { useOrg, usePatchOrg, useTeams } from "~/api/settings";
import { useAuthConfig } from "~/api/auth-config";

/**
 * The Settings control over `features.ssoTeamSync` — whether the identity
 * provider's groups become teams at each single-sign-on login. The boot
 * warnings in `services/team-sync.ts` tell the operator to flip this "in
 * Settings"; this section is that control.
 *
 * It renders only where the write can land: `PATCH /api/org` is org-admin
 * only, and without an OIDC provider no group claim ever arrives, so the
 * switch would change nothing a reader can see. Hidden beats disabled here
 * for the same reason the teams panel hides rather than disables
 * (`teams-panel.tsx`): a control the reader cannot act on needs an
 * explanation the row has no room for.
 *
 * Turning ON confirms first. The gate is read at each login, so the flip
 * itself deletes nothing — but membership of every mirrored team then
 * follows the identity provider again, and members added by hand while the
 * sync was off are removed at their next sign-in. That consequence belongs
 * to the person who confirms it. Turning OFF applies directly: no member
 * and no team is removed, and the mirrored teams unlock for manual edits.
 *
 * Below the master switch sits one switch per group: the org's
 * `ssoTeamGroups` allowlist (`PATCH /api/org`), unioned with the groups
 * that already have a mirror, so a dormant mirror — a team whose group
 * left the list — stays visible as an off row instead of vanishing. Only
 * a listed group syncs; per-group edits apply at each member's next
 * sign-in, no restart.
 *
 * One limit the control cannot see: a `valet.yaml` that declares
 * `org.features.ssoTeamSync` or `auth.sso.teams.groups` overwrites the
 * matching write at its next restart (`services/config-reconcile.ts`).
 * The api prints one boot line naming the file when that happens.
 */
export function TeamSyncSection() {
  const orgQ = useOrg();
  const authConfigQ = useAuthConfig();
  const teamsQ = useTeams();
  const patchOrg = usePatchOrg();
  const [confirmOn, setConfirmOn] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);

  if (orgQ.data?.callerRole !== "admin") return null;
  if (!authConfigQ.data?.sso) return null;

  const enabled = orgQ.data.features.ssoTeamSync === true;
  const groups = orgQ.data.ssoTeamGroups;

  // The rows are the union of the allowlist and the groups that already
  // have a mirror (`origin: "idp"` rows carry the group path in
  // `externalId`). The union is what makes a DORMANT mirror visible: its
  // group left the list, so the list alone would not show it, yet its row
  // on this page is the one thing that explains why the team below stopped
  // tracking its group.
  const mirrorPaths = (teamsQ.data?.teams ?? [])
    .filter((team) => team.origin === "idp" && team.externalId !== null)
    .map((team) => team.externalId as string);
  const knownPaths = [...new Set([...groups, ...mirrorPaths])];

  async function apply(body: { features?: { ssoTeamSync: boolean }; ssoTeamGroups?: string[] }) {
    try {
      await patchOrg.mutateAsync(body);
      setConfirmOn(false);
    } catch {
      // react-query stores the failure, and the row (or the still-open
      // dialog) renders `patchOrg.error`. This catch only keeps the
      // rejection from escaping the `void apply(...)` call sites below.
    }
  }

  function setGroup(path: string, on: boolean) {
    const next = on ? [...groups, path] : groups.filter((entry) => entry !== path);
    void apply({ ssoTeamGroups: next });
  }

  function addGroup() {
    const trimmed = newPath.trim();
    if (!/^\/[^/]+$/.test(trimmed)) {
      setPathError('Enter a top-level group path such as "/platform".');
      return;
    }
    if (groups.includes(trimmed)) {
      // Not a silent no-op: the reader typed a path and nothing on screen
      // would explain why nothing happened.
      setPathError(`${trimmed} is already listed.`);
      return;
    }
    setPathError(null);
    setNewPath("");
    void apply({ ssoTeamGroups: [...groups, trimmed] });
  }

  return (
    <div className="border-b border-line py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Team sync</p>
          <p className="mt-0.5 text-xs text-muted">
            Mirror identity provider groups into teams at each single sign-on login. Only the
            groups listed below sync.
          </p>
        </div>
        <Switch
          aria-label="Team sync"
          checked={enabled}
          disabled={patchOrg.isPending}
          onCheckedChange={(next) => {
            if (next) setConfirmOn(true);
            else void apply({ features: { ssoTeamSync: false } });
          }}
        />
      </div>

      <div className="mt-3 space-y-2">
        {knownPaths.map((path) => {
          const on = groups.includes(path);
          return (
            <div key={path} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <code className="text-xs">{path}</code>
                {!on && mirrorPaths.includes(path) && (
                  <span className="text-xs text-muted">
                    sync off — the team keeps its members, and nothing updates them
                  </span>
                )}
              </div>
              <Switch
                aria-label={`Sync ${path}`}
                checked={on}
                disabled={patchOrg.isPending}
                onCheckedChange={(next) => setGroup(path, next)}
              />
            </div>
          );
        })}

        <div className="flex items-center gap-2 pt-1">
          <Input
            aria-label="Group path"
            placeholder="/platform"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addGroup();
            }}
            className="max-w-56"
          />
          <Button type="button" variant="secondary" size="sm" onClick={addGroup} disabled={patchOrg.isPending}>
            Add group
          </Button>
        </div>
        {pathError && <p className="text-xs text-danger-500">{pathError}</p>}
      </div>

      {patchOrg.error && !confirmOn && (
        <p className="mt-2 text-xs text-danger-500">{patchOrg.error.message}</p>
      )}

      <ConfirmDialog
        open={confirmOn}
        onOpenChange={setConfirmOn}
        title="Turn on team sync?"
        description="At each member's next sign-in, their teams follow their identity provider groups. Members added to a mirrored team by hand are removed at their next sign-in, and mirrored teams lock against manual edits."
        confirmLabel="Turn on"
        pendingLabel="Turning on…"
        pending={patchOrg.isPending}
        error={patchOrg.error?.message}
        onConfirm={() => void apply({ features: { ssoTeamSync: true } })}
      />
    </div>
  );
}
