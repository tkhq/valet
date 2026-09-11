import { useProxySettings } from "~/api/proxy-usage";
import { useTeams } from "~/api/settings";
import { Section } from "~/components/settings/section";
import { TeamApiKeysSection } from "~/components/settings/api-keys-section";
import { ModeSnippets } from "~/components/usage/OnboardingPanel";

/** Mounted by team ID so key reveals and pending callbacks cannot cross scopes. */
export function TeamProxySettings({ teamId }: { teamId: string }) {
  const teamsQ = useTeams();
  const settingsQ = useProxySettings();
  if (teamsQ.error || settingsQ.error) {
    return <p role="alert">Could not load team proxy settings. Reload this page to try again.</p>;
  }
  if (!teamsQ.data || !settingsQ.data) {
    return <p role="status">Loading team proxy settings…</p>;
  }
  const team = teamsQ.data.teams.find((candidate) => candidate.id === teamId);
  if (!team) {
    return <p role="alert">This team is unavailable. Select another workspace.</p>;
  }
  const { enabled, mode } = settingsQ.data;
  return (
    <div className="min-w-0 max-w-full space-y-8">
      <Section title={`${team.name} proxy`} description="Route Claude Code, Codex, and SDK requests through a shared team API key.">
        <div className="space-y-2 rounded-md bg-ink-wash p-4 text-sm leading-relaxed">
          <p className="font-medium text-ink">Gateway: {enabled ? "On" : "Off"} · {mode === "centralized" ? "Centralized" : "Pass-through"} mode</p>
          <p className="text-sm text-muted">Managed by your organization admins.</p>
          {!enabled && <p className="text-sm text-muted">Ask an organization admin to enable the gateway before you send requests.</p>}
        </div>
      </Section>
      <Section title="Team API keys">
        <TeamApiKeysSection key={teamId} teamId={teamId} />
      </Section>
      <Section title="Configure your tool" description="Replace TEAM_API_KEY with the shared key from your team admin. Requests and spend belong to this team.">
        <div className="min-w-0 max-w-full overflow-hidden pt-4">
          {mode === "passthrough" && <p className="mb-4 text-sm text-muted">Your organization requires a provider key alongside the team key. Use an approved provider key. Its provider account is billed.</p>}
          <ModeSnippets apiKey={{ key: "TEAM_API_KEY" }} mode={mode} team />
        </div>
      </Section>
    </div>
  );
}
