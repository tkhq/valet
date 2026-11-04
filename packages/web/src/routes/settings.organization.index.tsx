import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Spinner,
  Switch,
} from "~/components/primitives";
import { useOrg, usePatchOrg, usePatchOrgSettings } from "~/api/settings";
import { useResetTutorialForEveryone } from "~/api/tutorial";

/**
 * `/settings/organization` (index) — Organization · General. Org name +
 * Save (dirty-gated); the read-only id row; the disable-gate control,
 * which confirms before flipping `features.organizations` off (spec: the
 * confirm copy must state that nothing is deleted — teams and members stay
 * dormant, not removed) and then returns the caller to their own settings.
 * An admin can also show the tour to every member again, after a confirm.
 */
export const Route = createFileRoute("/settings/organization/")({
  component: OrganizationGeneralPage,
});

export function OrganizationGeneralPage() {
  const orgQ = useOrg();
  const patchOrg = usePatchOrg();
  const patchOrgSettings = usePatchOrgSettings();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [confirmDisable, setConfirmDisable] = useState(false);
  const resetTour = useResetTutorialForEveryone();
  const [confirmTour, setConfirmTour] = useState(false);
  const [tourReset, setTourReset] = useState(false);

  useEffect(() => {
    if (orgQ.data) setName(orgQ.data.name);
  }, [orgQ.data?.name]);

  const dirty = !!orgQ.data && name !== orgQ.data.name;

  function save() {
    if (!dirty) return;
    patchOrg.mutate({ name });
  }

  async function disable() {
    await patchOrg.mutateAsync({ features: { organizations: false } });
    setConfirmDisable(false);
    navigate({ to: "/settings/profile" });
  }

  return (
    <Section title="General" description="Your organization's name and features.">
      {orgQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {orgQ.error && <div className="py-4 text-sm text-danger-500">Failed to load organization.</div>}

      {orgQ.data && (
        <>
          <FieldRow label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Organization name"
              aria-label="Organization name"
            />
          </FieldRow>
          <FieldRow label="Organization ID">
            <Input value={orgQ.data.id} readOnly disabled aria-label="Organization ID" />
          </FieldRow>

          <div className="flex items-center gap-3 py-4">
            <Button type="button" onClick={save} disabled={!dirty || patchOrg.isPending}>
              {patchOrg.isPending ? "Saving…" : "Save"}
            </Button>
            {patchOrg.error && !confirmDisable && (
              <p className="text-xs text-danger-500">{patchOrg.error.message}</p>
            )}
          </div>

          <FieldRow
            label="Public artifact links"
            hint={
              orgQ.data.callerRole === "admin"
                ? "Off: every shared document link requires a logged-in member of your org, and existing public links go back to requiring login. On: members can widen an individual link to anyone who has it — no login."
                : "Off: every shared document link requires a logged-in member of your org. Only an org admin can change this."
            }
          >
            <div className="flex items-center gap-3">
              <Switch
                checked={orgQ.data.allowPublicArtifacts}
                disabled={patchOrgSettings.isPending || orgQ.data.callerRole !== "admin"}
                onCheckedChange={(next) => patchOrgSettings.mutate({ allowPublicArtifacts: next })}
                aria-label="Allow public artifact links"
              />
              {patchOrgSettings.error && (
                <p className="text-xs text-danger-500">{patchOrgSettings.error.message}</p>
              )}
            </div>
          </FieldRow>

          {orgQ.data.callerRole === "admin" && (
            <FieldRow
              label="Tour"
              hint={tourReset
                ? "Done. Each member sees the tour the next time they open Valet."
                : "Each member sees the tour again the next time they open Valet. Their data does not change."}
            >
              <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmTour(true)}>
                Show the tour to everyone again
              </Button>
            </FieldRow>
          )}

          <FieldRow
            label="Organization features"
            hint="Hides member roles and teams for everyone in your organization."
          >
            <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmDisable(true)}>
              Turn off organization features
            </Button>
          </FieldRow>
        </>
      )}

      <ConfirmDialog
        open={confirmTour}
        onOpenChange={setConfirmTour}
        title="Show the tour to everyone again?"
        description="Each member of your organization sees the tour the next time they open Valet."
        confirmLabel="Show the tour"
        pendingLabel="Saving…"
        confirmVariant="primary"
        pending={resetTour.isPending}
        error={resetTour.error ? `Could not save. ${resetTour.error.message} Try again.` : undefined}
        onConfirm={() => resetTour.mutate(undefined, { onSuccess: () => { setConfirmTour(false); setTourReset(true); } })}
      />

      <Dialog open={confirmDisable} onOpenChange={setConfirmDisable}>
        <DialogContent
          title="Turn off organization features?"
          description="This hides Organization settings for everyone in your org. Nothing is deleted — your teams and member roles stay exactly as they are, and you can turn this back on any time."
        >
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setConfirmDisable(false)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={patchOrg.isPending} onClick={disable}>
              {patchOrg.isPending ? "Turning off…" : "Turn off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
