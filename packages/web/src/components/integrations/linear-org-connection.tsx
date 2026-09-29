import { useOrg } from "~/api/settings";
import { useTriggerCatalog } from "~/api/workflows";
import { Badge, Button } from "~/components/primitives";

/** The organization owns the native Linear connection; MCP tool access stays separate. */
export function LinearOrgConnection() {
  const org = useOrg();
  const catalog = useTriggerCatalog();
  const readiness = catalog.data?.catalog.find(service => service.service === "linear")?.readiness;
  const admin = !org.error && org.data?.features.organizations && org.data.callerRole === "admin";
  return <div className="space-y-2 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span>Organization connection</span>
      {!catalog.error && readiness && <Badge variant={readiness.ready ? "success" : "neutral"}>{readiness.ready ? "Connected by your organization" : "Not connected"}</Badge>}
    </div>
    {catalog.error && <p className="text-xs text-muted">Could not check the Linear connection. <button className="underline" onClick={() => void catalog.refetch()}>Retry</button></p>}
    {admin ? <Button asChild size="sm"><a href="/settings/organization/linear">{readiness?.ready && !catalog.error ? "Manage Linear" : "Connect Linear"}</a></Button>
      : !readiness?.ready && <p className="text-xs text-muted">Ask an organization admin to connect Linear.</p>}
  </div>;
}
