import { Link, createFileRoute } from "@tanstack/react-router";
import { useOrg } from "~/api/settings";
import { Section } from "~/components/settings/section";
import { ProxyGovernance } from "~/components/proxy/proxy-governance";

/**
 * `/settings/organization/proxy` — Organization · Proxy: enable/disable the
 * LLM recording gateway and choose the credential mode. Renders inside
 * `/settings/organization`'s OrgRouteGuard — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/proxy")({
  component: OrganizationProxyPage,
});

export function OrganizationProxyPage() {
  const orgQ = useOrg();

  const isAdmin = orgQ.data?.callerRole === "admin";

  return (
    <div className="space-y-10">
      <Section
        title="Proxy"
        description="Records external Claude Code and Codex traffic for spend tracking and observability."
      >
        <ProxyGovernance editable={isAdmin} />
      </Section>

      {/* Link to usage dashboard */}
      <p className="text-sm text-muted">
        <Link to="/usage" className="text-moss underline-offset-2 hover:underline">
          View recorded usage →
        </Link>
      </p>
    </div>
  );
}
