import { useNavigate } from "@tanstack/react-router";
import { Button, Card, CardBody } from "~/components/primitives";
import { usePatchOrg } from "~/api/settings";

/**
 * The one deliberately-boxed element on the You side (spec, "Visual
 * direction": "the enable-organizations card is the one intentionally-boxed
 * element on the user side — it's an invitation, not a setting"). Rendered
 * at the bottom of `/settings/profile` when the caller is an org admin and
 * the `organizations` feature gate is off.
 */
export function EnableOrgCard() {
  const navigate = useNavigate();
  const patchOrg = usePatchOrg();

  async function enable() {
    await patchOrg.mutateAsync({ features: { organizations: true } });
    navigate({ to: "/settings/organization" });
  }

  return (
    <Card className="border-moss/30 bg-moss-wash">
      <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <div className="text-sm font-medium text-ink">
            Working with a team? Enable organizations
          </div>
          <p className="text-xs text-muted">
            Turns on member roles and teams for everyone in your organization.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={enable}
          disabled={patchOrg.isPending}
        >
          {patchOrg.isPending ? "Enabling…" : "Enable"}
        </Button>
      </CardBody>
      {patchOrg.error && (
        <CardBody className="pt-0 text-xs text-danger-500">{patchOrg.error.message}</CardBody>
      )}
    </Card>
  );
}
