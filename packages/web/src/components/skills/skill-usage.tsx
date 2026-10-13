import type { PluginSkillSummary, SkillSummary } from "@valet/api/wire";
import { usePlugins } from "~/api/integrations";
import { useMyToolPermissions } from "~/api/policies";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { useWorkspaceAssistant } from "~/components/layout/workspace-assistant";
import { displayName } from "~/components/integrations/display-name";
import { IntegrationList } from "~/components/integrations/integration-card";
import { IntegrationRow } from "~/components/integrations/integration-row";
import { pluginTools } from "~/components/integrations/tool-permissions";
import { Button } from "~/components/primitives";

/** Installation supplies instructions. Connection health belongs to the active workspace. */
export function SkillUsage({ skill }: { skill: SkillSummary }) {
  const assistant = useWorkspaceAssistant();
  const shadowed = skill.origin !== "plugin" && skill.shadowed;
  return <section aria-label="Using this skill" className="mt-6 space-y-3 rounded-lg border border-line p-4 text-sm">
    <h2 className="font-medium text-ink">Using this skill</h2>
    <p className="text-muted">Installed skills supply instructions. They do not connect accounts or grant access.</p>
    {skill.origin === "plugin" ? <PluginConnections skill={skill} /> :
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

/**
 * The integrations a plugin skill uses, as Integrations rows that open the
 * integration's panel. Skill metadata declares no tools, so the list is the
 * reverse of a panel's Related skills: every plugin that ships this skill.
 * The rows carry your own tool summary only in the personal workspace.
 */
function PluginConnections({ skill }: { skill: PluginSkillSummary }) {
  const scope = useWorkspaceScope();
  const plugins = usePlugins(scope.teamId);
  const tools = useMyToolPermissions();
  const related = (plugins.data?.plugins ?? []).filter((plugin) =>
    plugin.name === skill.plugin || plugin.skills?.some((entry) => entry.name === skill.name));
  return <div className="space-y-2">
    <p className="text-muted">Source: {displayName(skill.plugin)} plugin. Plugin authors manage these instructions.</p>
    <h3 className="font-medium text-ink">Integrations this skill uses</h3>
    <p className="text-xs text-muted">For the current {scope.teamId ? "team" : "personal"} workspace. The task determines which connections you need.</p>
    {plugins.isLoading ? <p className="text-muted">Checking connections…</p> : plugins.error || related.length === 0 ?
      <p className="text-muted">Connection status is unavailable. Open Integrations to check access.</p> :
      <IntegrationList label="Integrations this skill uses">
        {related.map((plugin) => <IntegrationRow key={plugin.name} plugin={plugin} search={{}}
          tools={!scope.teamId && tools.data ? pluginTools(plugin, tools.data.tools) : undefined} />)}
      </IntegrationList>}
  </div>;
}
