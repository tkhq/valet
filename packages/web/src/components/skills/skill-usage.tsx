import { Link } from "@tanstack/react-router";
import type { SkillSummary } from "@valet/api/wire";
import { usePlugins } from "~/api/integrations";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { useWorkspaceAssistant } from "~/components/layout/workspace-assistant";
import { healthBadge, serviceHealth } from "~/components/integrations/service-health";
import { displayName } from "~/components/integrations/display-name";
import { Button, textLinkClass } from "~/components/primitives";

/** Installation supplies instructions. Connection health belongs to the active workspace. */
export function SkillUsage({ skill }: { skill: SkillSummary }) {
  const assistant = useWorkspaceAssistant();
  const shadowed = skill.origin !== "plugin" && skill.shadowed;
  return <section aria-label="Using this skill" className="mt-6 space-y-3 rounded-lg border border-line p-4 text-sm">
    <h2 className="font-medium text-ink">Using this skill</h2>
    <p className="text-muted">Installed skills supply instructions. They do not connect accounts or grant access.</p>
    {skill.origin === "plugin" ? <PluginConnections pluginName={skill.plugin} /> :
      <div className="space-y-2 text-muted">
        <p>Source: {skill.origin === "repo" ? "Synced repository" : "Stored skill"}. Ownership: {skill.ownerType === "user" ? "Personal" : skill.ownerType === "team" ? "Team" : "Organization"}.</p>
        <p>Connection prerequisites are not declared for this skill. Check the playbook before you run it.</p>
      </div>}
    {skill.takesArgs && <p className="text-muted">This skill takes arguments. Include the values requested in the playbook.</p>}
    <Button size="sm" disabled={shadowed} onClick={() => assistant.open(`Use the "${skill.name}" skill to help me with [describe your task].`)}>Try in chat</Button>
    <p className="text-xs text-muted">Opens an editable draft in this workspace. Your existing draft stays unchanged. Nothing is sent until you send it.</p>
    {shadowed && <p className="text-muted">Rename this skill before trying it. Another skill uses this name.</p>}
  </section>;
}

function PluginConnections({ pluginName }: { pluginName: string }) {
  const scope = useWorkspaceScope();
  const plugins = usePlugins(scope.teamId);
  const plugin = plugins.data?.plugins.find((item) => item.name === pluginName);
  return <div className="space-y-2">
    <p className="text-muted">Source: {displayName(pluginName)} plugin. Plugin authors manage these instructions.</p>
    <h3 className="font-medium text-ink">Plugin connections</h3>
    <p className="text-xs text-muted">For the current {scope.teamId ? "team" : "personal"} workspace. The task determines which connections you need.</p>
    {plugins.isLoading ? <p className="text-muted">Checking connections…</p> : plugins.error || !plugin ?
      <p className="text-muted">Connection status is unavailable. Open Integrations to check access.</p> : plugin.services.length === 0 ?
        <p className="text-muted">This plugin declares no account connections. Check the playbook for other prerequisites.</p> :
        <ul className="space-y-1">{plugin.services.map((service) => <li key={service.service} className="text-muted">{displayName(service.service)}: {service.connect === "org" ? "Provided by your organization" : service.connect === "unconfigured" ? "Setup required" : healthBadge(serviceHealth(service))?.label ?? "Not connected"}</li>)}</ul>}
    <Link to="/integrations" className={textLinkClass}>Manage connections in Integrations</Link>
  </div>;
}
