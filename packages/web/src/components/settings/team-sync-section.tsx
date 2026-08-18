import { useState } from "react";
import { ConfirmDialog, Switch } from "~/components/primitives";
import { useOrg, usePatchOrg } from "~/api/settings";
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
 * Two limits the control cannot see, both boot-time: the group allowlist
 * (`auth.sso.teams.groups`) lives in the instance config file, and a
 * deployment whose file declares `org.features.ssoTeamSync` overwrites this
 * write at its next restart (`services/config-reconcile.ts`). The api
 * prints one boot line for each; the hint below names the file so the
 * operator knows where the rest of the configuration lives.
 */
export function TeamSyncSection() {
  const orgQ = useOrg();
  const authConfigQ = useAuthConfig();
  const patchOrg = usePatchOrg();
  const [confirmOn, setConfirmOn] = useState(false);

  if (orgQ.data?.callerRole !== "admin") return null;
  if (!authConfigQ.data?.sso) return null;

  const enabled = orgQ.data.features.ssoTeamSync === true;

  async function apply(next: boolean) {
    await patchOrg.mutateAsync({ features: { ssoTeamSync: next } });
    setConfirmOn(false);
  }

  return (
    <div className="border-b border-line py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Team sync</p>
          <p className="mt-0.5 text-xs text-muted">
            Mirror identity provider groups into teams at each single sign-on login. Name the
            groups to mirror under auth.sso.teams.groups in the instance config.
          </p>
        </div>
        <Switch
          aria-label="Team sync"
          checked={enabled}
          disabled={patchOrg.isPending}
          onCheckedChange={(next) => {
            if (next) setConfirmOn(true);
            else void apply(false);
          }}
        />
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
        onConfirm={() => void apply(true)}
      />
    </div>
  );
}
