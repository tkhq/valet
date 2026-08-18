import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import type {
  AssistantBehavior,
  AssistantIntegrationEntry,
  AssistantSummary,
  PluginSummary,
  TeamSummary,
} from "@valet/api/wire";
import { useAssistants, usePatchAssistant, useArchiveAssistant } from "~/api/assistants";
import { usePlugins } from "~/api/integrations";
import { useSkills } from "~/api/skills";
import { useMe, useTeams } from "~/api/settings";
import { assistantLabel } from "~/components/session/assistant-rail";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import {
  Button,
  ConfirmDialog,
  Input,
  Spinner,
} from "~/components/primitives";
import { errorText } from "~/lib/error-text";

export const Route = createFileRoute("/assistants/$assistantId")({
  component: AssistantEditorPage,
});

// ── pure helpers (exported for tests) ────────────────────────────────────

/** One row per ActionPlugin routing service, across every plugin. */
export function integrationOptions(
  plugins: PluginSummary[] | undefined,
): { service: string; label: string; actions: { id: string; name: string }[] }[] {
  if (!plugins) return [];
  return plugins.flatMap((p) =>
    (p.actionServices ?? [])
      .filter((s) => s.actions.length > 0 || s.dynamic === true)
      .map((s) => ({
        service: s.service,
        label: p.displayName ?? p.name,
        actions: s.actions.map((a) => ({ id: a.id, name: a.name })),
      })),
  );
}

/** The rail's administer rule, restated for one assistant: yours always;
 * a team's needs team admin or org admin. The API still 404s a non-admin
 * write — this only decides read-only rendering. */
export function canEditAssistant(
  assistant: AssistantSummary,
  teams: TeamSummary[] | undefined,
  me: { id: string; orgRole: "admin" | "member" } | undefined,
): boolean {
  if (assistant.owner.type === "user") return true;
  if (me?.orgRole === "admin") return true;
  const team = teams?.find((t) => t.id === assistant.owner.id);
  return team?.callerRole === "admin";
}

// ── page component ────────────────────────────────────────────────────────

export function AssistantEditorPage() {
  const { assistantId } = useParams({ strict: false }) as { assistantId: string };
  const assistantsQ = useAssistants();
  const pluginsQ = usePlugins();
  const meQ = useMe();
  const teamsQ = useTeams();

  const assistant = assistantsQ.data?.assistants.find((a) => a.id === assistantId);

  // Loading gate — all four queries must resolve before rendering.
  const resolved =
    assistantsQ.data !== undefined &&
    meQ.data !== undefined &&
    teamsQ.data !== undefined;

  if (!resolved) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted">
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  if (!assistant) {
    return (
      <div className="py-8 text-sm text-muted">
        This assistant does not exist or you cannot view it.{" "}
        <Link to="/chat" className="underline hover:text-ink">
          Open /chat and pick one from the sidebar.
        </Link>
      </div>
    );
  }

  const canEdit = canEditAssistant(assistant, teamsQ.data?.teams, meQ.data);
  const plugins = pluginsQ.data?.plugins;
  const integrationOpts = integrationOptions(plugins);
  const owningTeam =
    assistant.owner.type === "team"
      ? (teamsQ.data?.teams ?? []).find((t) => t.id === assistant.owner.id)
      : undefined;

  return (
    <AssistantEditorForm
      assistant={assistant}
      canEdit={canEdit}
      integrationOpts={integrationOpts}
      owningTeamName={owningTeam?.name}
      pluginsResolved={pluginsQ.data !== undefined}
    />
  );
}

// ── inner form (split out to avoid top-level hook-order issues) ───────────

function AssistantEditorForm({
  assistant,
  canEdit,
  integrationOpts,
  owningTeamName,
  pluginsResolved,
}: {
  assistant: AssistantSummary;
  canEdit: boolean;
  integrationOpts: { service: string; label: string; actions: { id: string; name: string }[] }[];
  owningTeamName: string | undefined;
  pluginsResolved: boolean;
}) {
  const patch = usePatchAssistant();
  const archive = useArchiveAssistant();
  const navigate = useNavigate();

  // One behavior object in state, initialized from the server value.
  const [behavior, setBehavior] = useState<AssistantBehavior | null>(
    () => assistant.behavior ?? null,
  );

  // Identity section state.
  const [name, setName] = useState(assistant.name ?? "");
  const [personality, setPersonality] = useState(assistant.personality ?? "");

  // Skills section state.
  const skillsMode = behavior?.skills?.mode ?? "all";
  const allowedSkillNames: string[] =
    behavior?.skills?.mode === "allowlist" ? behavior.skills.names : [];

  // Integrations section state.
  const integrationsMode = behavior?.integrations?.mode ?? "all";
  const allowedEntries: AssistantIntegrationEntry[] =
    behavior?.integrations?.mode === "allowlist" ? behavior.integrations.entries : [];

  // Skills catalog query — owner-scoped when the assistant has a team owner.
  const ownerQuery =
    assistant.owner.type === "team"
      ? { ownerType: "team" as const, ownerId: assistant.owner.id }
      : {};
  const skillsQ = useSkills(ownerQuery);
  const pluginSkillsQ = useSkills();

  // Section-level gates: skills and integrations wait on their own catalogs.
  // The identity section renders immediately without waiting on slow catalogs.
  const skillsResolved =
    skillsQ.data !== undefined && pluginSkillsQ.data !== undefined;

  const catalogSkillNames = useMemo(() => {
    const all: string[] = [];
    for (const s of skillsQ.data?.skills ?? []) all.push(s.name);
    for (const s of pluginSkillsQ.data?.skills ?? []) {
      if (s.origin === "plugin" && !all.includes(s.name)) all.push(s.name);
    }
    return new Set(all);
  }, [skillsQ.data, pluginSkillsQ.data]);

  // Archive dialog state.
  const [archiveOpen, setArchiveOpen] = useState(false);

  // ── save handlers ────────────────────────────────────────────────────

  function saveIdentity() {
    patch.mutate(
      {
        id: assistant.id,
        body: {
          name: name.trim() || undefined,
          personality: personality.trim() ? personality.trim() : null,
        },
      },
      { onSuccess: () => {} },
    );
  }

  function saveSkills() {
    const newBehavior: AssistantBehavior = {
      ...behavior,
      skills:
        skillsMode === "all"
          ? { mode: "all" }
          : { mode: "allowlist", names: allowedSkillNames },
    };
    setBehavior(newBehavior);
    patch.mutate(
      { id: assistant.id, body: { behavior: newBehavior } },
      { onSuccess: () => {} },
    );
  }

  function saveIntegrations() {
    const newBehavior: AssistantBehavior = {
      ...behavior,
      integrations:
        integrationsMode === "all"
          ? { mode: "all" }
          : { mode: "allowlist", entries: allowedEntries },
    };
    setBehavior(newBehavior);
    patch.mutate(
      { id: assistant.id, body: { behavior: newBehavior } },
      { onSuccess: () => {} },
    );
  }

  function setSkillsMode(mode: "all" | "allowlist") {
    setBehavior((prev) => ({
      ...prev,
      skills: mode === "all" ? { mode: "all" } : { mode: "allowlist", names: allowedSkillNames },
    }));
  }

  function toggleSkill(skillName: string, checked: boolean) {
    const next = checked
      ? [...allowedSkillNames, skillName]
      : allowedSkillNames.filter((n) => n !== skillName);
    setBehavior((prev) => ({
      ...prev,
      skills: { mode: "allowlist", names: next },
    }));
  }

  function removeSkill(skillName: string) {
    toggleSkill(skillName, false);
  }

  function setIntegrationsMode(mode: "all" | "allowlist") {
    setBehavior((prev) => ({
      ...prev,
      integrations:
        mode === "all"
          ? { mode: "all" }
          : { mode: "allowlist", entries: allowedEntries },
    }));
  }

  function toggleIntegration(service: string, checked: boolean) {
    if (checked) {
      if (!allowedEntries.find((e) => e.service === service)) {
        setBehavior((prev) => ({
          ...prev,
          integrations: {
            mode: "allowlist",
            entries: [...allowedEntries, { service }],
          },
        }));
      }
    } else {
      setBehavior((prev) => ({
        ...prev,
        integrations: {
          mode: "allowlist",
          entries: allowedEntries.filter((e) => e.service !== service),
        },
      }));
    }
  }

  function toggleExcludeAction(service: string, actionId: string, exclude: boolean) {
    const entry = allowedEntries.find((e) => e.service === service);
    if (!entry) return;
    const current = entry.excludeActions ?? [];
    const next = exclude ? [...current, actionId] : current.filter((id) => id !== actionId);
    setBehavior((prev) => ({
      ...prev,
      integrations: {
        mode: "allowlist",
        entries: allowedEntries.map((e) =>
          e.service === service
            ? { ...e, excludeActions: next.length > 0 ? next : undefined }
            : e,
        ),
      },
    }));
  }

  // Dangling skill names (in allowlist, not in catalog).
  const danglingNames = allowedSkillNames.filter((n) => !catalogSkillNames.has(n));

  const label = assistantLabel(assistant);

  return (
    <div className="space-y-10 max-w-2xl">
      {/* Ownership clause */}
      <p className="text-sm text-muted">
        {assistant.owner.type === "user"
          ? "This assistant stays in your personal workspace."
          : `This assistant belongs to ${owningTeamName ?? "this team"}. Everyone on the team can use it.`}
      </p>

      {/* Read-only notice */}
      {!canEdit && (
        <div className="rounded border border-line bg-ink-wash/40 px-3 py-2 text-sm text-muted">
          Only team admins can edit this assistant.
        </div>
      )}

      {/* 1. Identity section */}
      <Section title="Identity" description="Name and personality shown in the sidebar and at the top of each conversation.">
        <FieldRow label="Name">
          <Input
            aria-label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canEdit}
            placeholder="Assistant name"
          />
        </FieldRow>
        <FieldRow label="Personality" hint="Describes how the assistant speaks and approaches problems. Leave blank to use the default.">
          <textarea
            aria-label="Personality"
            value={personality}
            onChange={(e) => setPersonality(e.target.value)}
            disabled={!canEdit}
            rows={4}
            placeholder="You are warm and direct."
            className="w-full rounded border bg-[--bg] text-[--fg] placeholder:text-muted border-[--border] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 focus-visible:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-sm resize-y leading-relaxed"
          />
        </FieldRow>
        <div className="py-4 flex items-center gap-3">
          <Button
            type="button"
            onClick={saveIdentity}
            disabled={!canEdit || patch.isPending}
            aria-label="Save identity"
          >
            {patch.isPending ? "Saving…" : "Save identity"}
          </Button>
          {patch.error != null && (
            <p className="text-xs text-danger-500">{errorText(patch.error)}</p>
          )}
        </div>
      </Section>

      {/* 2. Skills section */}
      <Section title="Skills" description="Which skills this assistant can use. Skills extend what the assistant knows how to do.">
        {!skillsResolved ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted">
            <Spinner size={14} /> Loading skills…
          </div>
        ) : (
        <div className="py-4 space-y-4">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="skills-mode"
                checked={skillsMode === "all"}
                onChange={() => setSkillsMode("all")}
                disabled={!canEdit}
                aria-label="All skills"
              />
              All skills
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="skills-mode"
                checked={skillsMode === "allowlist"}
                onChange={() => setSkillsMode("allowlist")}
                disabled={!canEdit}
                aria-label="Only these skills"
              />
              Only these skills
            </label>
          </div>

          {skillsMode === "allowlist" && (
            <div className="space-y-3 pl-2">
              {/* Dangling names (not in catalog) */}
              {danglingNames.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {danglingNames.map((n) => (
                    <span
                      key={n}
                      className="inline-flex items-center gap-1 rounded-full border border-warning-500/50 bg-warning-500/10 px-2.5 py-1 text-xs text-warning-700"
                    >
                      {n}
                      <span className="text-[10px] opacity-70">(not found)</span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => removeSkill(n)}
                          aria-label={`Remove ${n}`}
                          className="ml-0.5 rounded text-warning-600 hover:text-warning-800"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {/* Catalog skills */}
              <div className="space-y-1.5 max-h-60 overflow-y-auto">
                {[...catalogSkillNames].map((skillName) => (
                  <label key={skillName} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowedSkillNames.includes(skillName)}
                      onChange={(e) => toggleSkill(skillName, e.target.checked)}
                      disabled={!canEdit}
                      aria-label={skillName}
                    />
                    {skillName}
                  </label>
                ))}
                {catalogSkillNames.size === 0 && (
                  <p className="text-xs text-muted">No skills available for this assistant.</p>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={saveSkills}
              disabled={!canEdit || patch.isPending}
              aria-label="Save skills"
            >
              Save skills
            </Button>
          </div>
        </div>
        )}
      </Section>

      {/* 3. Integrations section */}
      <Section title="Integrations" description="Which integrations this assistant can use. An integration is a connected service like GitHub.">
        {!pluginsResolved ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted">
            <Spinner size={14} /> Loading integrations…
          </div>
        ) : (
        <div className="py-4 space-y-4">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="integrations-mode"
                checked={integrationsMode === "all"}
                onChange={() => setIntegrationsMode("all")}
                disabled={!canEdit}
                aria-label="All integrations"
              />
              All integrations
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="integrations-mode"
                checked={integrationsMode === "allowlist"}
                onChange={() => setIntegrationsMode("allowlist")}
                disabled={!canEdit}
                aria-label="Only these integrations"
              />
              Only these integrations
            </label>
          </div>

          {integrationsMode === "allowlist" && (
            <div className="space-y-3 pl-2">
              {integrationOpts.map((opt) => {
                const entry = allowedEntries.find((e) => e.service === opt.service);
                const isChecked = entry !== undefined;
                return (
                  <div key={opt.service} className="space-y-1">
                    <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => toggleIntegration(opt.service, e.target.checked)}
                        disabled={!canEdit}
                        aria-label={opt.label}
                      />
                      {opt.label}
                    </label>
                    {isChecked && opt.actions.length > 0 && (
                      <div className="pl-6 space-y-1">
                        {opt.actions.map((action) => {
                          const excluded = (entry?.excludeActions ?? []).includes(action.id);
                          return (
                            <label
                              key={action.id}
                              className="flex items-center gap-2 text-xs text-muted cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={excluded}
                                onChange={(e) =>
                                  toggleExcludeAction(opt.service, action.id, e.target.checked)
                                }
                                disabled={!canEdit}
                                aria-label={`Exclude ${action.name}`}
                              />
                              Exclude: {action.name}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {integrationOpts.length === 0 && (
                <p className="text-xs text-muted">No integrations configured.</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={saveIntegrations}
              disabled={!canEdit || patch.isPending}
              aria-label="Save integrations"
            >
              Save integrations
            </Button>
          </div>
        </div>
        )}
      </Section>

      {/* 4. Manage section */}
      <Section title="Manage" description="Promote or remove this assistant.">
        <div className="py-4 flex flex-wrap items-center gap-3">
          {!assistant.isDefault && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => patch.mutate({ id: assistant.id, body: { isDefault: true } })}
              disabled={!canEdit || patch.isPending}
            >
              Make default
            </Button>
          )}

          {assistant.isDefault ? (
            <div className="text-sm text-muted">
              <span className="opacity-50">Archive</span>
              <span className="ml-2 text-xs">Make another assistant the default first.</span>
            </div>
          ) : (
            <Button
              type="button"
              variant="secondary"
              className="text-danger-500 hover:text-danger-600"
              onClick={() => setArchiveOpen(true)}
              disabled={!canEdit}
            >
              Archive
            </Button>
          )}
        </div>
      </Section>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={(open) => setArchiveOpen(open)}
        title={`Archive ${label}?`}
        description="The assistant leaves the sidebar. The threads it holds are kept."
        confirmLabel="Archive assistant"
        pendingLabel="Archiving…"
        pending={archive.isPending}
        error={archive.error != null ? errorText(archive.error) : undefined}
        onConfirm={() =>
          archive.mutate(assistant.id, {
            onSuccess: () => {
              setArchiveOpen(false);
              navigate({ to: "/chat" });
            },
          })
        }
      />
    </div>
  );
}
