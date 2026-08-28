import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { PERSONALITY_INJECT_CAP } from "@valet/api/wire";
import type {
  AssistantBehavior,
  AssistantIntegrationEntry,
  AssistantIntegrationsBehavior,
  AssistantSkillsBehavior,
  AssistantSummary,
  PluginSummary,
  TeamSummary,
} from "@valet/api/wire";
import { useAssistants, usePatchAssistant, useArchiveAssistant } from "~/api/assistants";
import { usePlugins } from "~/api/integrations";
import { useAllSkills } from "~/api/skills";
import { useMe, useTeams } from "~/api/settings";
import { assistantLabel, canAdministerOwner } from "~/components/session/assistant-rail";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { RadioCard } from "~/components/settings/radio-card";
import { ServiceIcon } from "~/components/service-icon";
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorRow,
  Input,
  LoadingRow,
  Textarea,
} from "~/components/primitives";
import { errorText } from "~/lib/error-text";

export const Route = createFileRoute("/assistants/$assistantId")({
  component: AssistantEditorPage,
});

// ── pure helpers (exported for tests) ────────────────────────────────────

/** One row per ActionPlugin routing service, across every plugin. `icon` is
 * the brand-mark slug `ServiceIcon` resolves (the same
 * `services[0]?.iconSlug ?? name` fallback the integrations page uses). */
export function integrationOptions(
  plugins: PluginSummary[] | undefined,
): { service: string; label: string; icon: string; actions: { id: string; name: string }[] }[] {
  if (!plugins) return [];
  return plugins.flatMap((p) =>
    (p.actionServices ?? [])
      .filter((s) => s.actions.length > 0 || s.dynamic === true)
      .map((s) => ({
        service: s.service,
        label: p.displayName ?? p.name,
        icon: p.services[0]?.iconSlug ?? p.name,
        actions: s.actions.map((a) => ({ id: a.id, name: a.name })),
      })),
  );
}

/** The rail's administer rule for one assistant — the SAME predicate the
 * rail's menus use (`canAdministerOwner`), so the two surfaces cannot
 * disagree. The API still 404s a non-admin write — this only decides
 * read-only rendering. */
export function canEditAssistant(
  assistant: AssistantSummary,
  teams: TeamSummary[] | undefined,
  me: { id: string; orgRole: "admin" | "member" } | undefined,
): boolean {
  return canAdministerOwner(assistant.owner, me, teams);
}

/** The shared page frame — the same shell every settings surface uses, so
 * the editor never renders full-bleed. */
function PageShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6 py-10 pb-24">{children}</div>;
}

// ── page component ────────────────────────────────────────────────────────

export function AssistantEditorPage() {
  const { assistantId } = useParams({ strict: false });
  const assistantsQ = useAssistants();
  const pluginsQ = usePlugins();
  const meQ = useMe();
  const teamsQ = useTeams();

  const assistant = assistantsQ.data?.assistants.find((a) => a.id === assistantId);

  // A settled failure must not render as an eternal spinner: with the app's
  // retry policy the query stops on error with `data` undefined, so a gate
  // on data alone never resolves. Error first, then loading.
  const loadError = assistantsQ.error ?? meQ.error ?? teamsQ.error;
  if (loadError != null) {
    return (
      <PageShell>
        <div className="space-y-3">
          <ErrorRow>Could not load this assistant: {errorText(loadError)}</ErrorRow>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void assistantsQ.refetch?.();
              void meQ.refetch?.();
              void teamsQ.refetch?.();
            }}
          >
            Retry
          </Button>
        </div>
      </PageShell>
    );
  }

  const resolved =
    assistantsQ.data !== undefined &&
    meQ.data !== undefined &&
    teamsQ.data !== undefined;

  if (!resolved) {
    return (
      <PageShell>
        <LoadingRow />
      </PageShell>
    );
  }

  if (!assistant) {
    return (
      <PageShell>
        <div className="text-sm text-muted">
          This assistant does not exist or you cannot view it.{" "}
          <Link to="/chat" className="underline hover:text-ink">
            Open /chat and pick one from the sidebar.
          </Link>
        </div>
      </PageShell>
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
    // key on the assistant id: the router reuses this component across a
    // param change (one editor URL to another), so without a remount the
    // form's useState would keep assistant A's edits and Save would write
    // them onto B. The key forces a fresh form per assistant. Same-id data
    // updates do NOT remount — the form's sync effect covers those.
    <PageShell>
      <AssistantEditorForm
        key={assistant.id}
        assistant={assistant}
        canEdit={canEdit}
        integrationOpts={integrationOpts}
        owningTeamName={owningTeam?.name}
        pluginsResolved={pluginsQ.data !== undefined}
        pluginsError={pluginsQ.error}
        onRetryPlugins={() => {
          void pluginsQ.refetch?.();
        }}
      />
    </PageShell>
  );
}

// ── inner form (split out to avoid top-level hook-order issues) ───────────

function AssistantEditorForm({
  assistant,
  canEdit,
  integrationOpts,
  owningTeamName,
  pluginsResolved,
  pluginsError,
  onRetryPlugins,
}: {
  assistant: AssistantSummary;
  canEdit: boolean;
  integrationOpts: {
    service: string;
    label: string;
    icon: string;
    actions: { id: string; name: string }[];
  }[];
  owningTeamName: string | undefined;
  pluginsResolved: boolean;
  pluginsError?: Error | null;
  onRetryPlugins?: () => void;
}) {
  // One mutation instance per section. usePatchAssistant is a thin
  // useMutation wrapper, so a separate instance per Save control is cheap —
  // and it keeps each section's pending and error state under its OWN control
  // instead of surfacing every section's error under Identity.
  const identityPatch = usePatchAssistant();
  const skillsPatch = usePatchAssistant();
  const integrationsPatch = usePatchAssistant();
  const managePatch = usePatchAssistant();
  const archive = useArchiveAssistant();
  const navigate = useNavigate();

  // Per-section drafts, initialized from the server value. Each section's
  // Save sends only its own draft, so one section's unsaved edits can never
  // ride along on another section's PATCH.
  const [name, setName] = useState(assistant.name ?? "");
  const [personality, setPersonality] = useState(assistant.personality ?? "");
  const [skillsDraft, setSkillsDraft] = useState<AssistantSkillsBehavior>(
    () => assistant.behavior?.skills ?? { mode: "all" },
  );
  const [integrationsDraft, setIntegrationsDraft] = useState<AssistantIntegrationsBehavior>(
    () => assistant.behavior?.integrations ?? { mode: "all" },
  );

  // Mount-time state from props (CLAUDE.md): the `assistant` prop updates in
  // place for the SAME id — the rail's Rename dialog, another admin's PATCH
  // arriving via refetch, or our own save's cache write-back. Untouched
  // sections follow the server; a section the user has edited keeps their
  // draft (the touched ref wins) until its save resets the flag.
  const identityTouched = useRef(false);
  const skillsTouched = useRef(false);
  const integrationsTouched = useRef(false);
  useEffect(() => {
    if (!identityTouched.current) {
      setName(assistant.name ?? "");
      setPersonality(assistant.personality ?? "");
    }
    // Functional updates that return `prev` when nothing changed, so a
    // refetch that carries the same config does not force a render with a
    // fresh-but-equal object.
    if (!skillsTouched.current) {
      setSkillsDraft((prev) => {
        const next = assistant.behavior?.skills ?? { mode: "all" as const };
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    }
    if (!integrationsTouched.current) {
      setIntegrationsDraft((prev) => {
        const next = assistant.behavior?.integrations ?? { mode: "all" as const };
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    }
  }, [assistant]);

  const skillsMode = skillsDraft.mode;
  const allowedSkillNames: string[] = skillsDraft.mode === "allowlist" ? skillsDraft.names : [];
  const integrationsMode = integrationsDraft.mode;
  const allowedEntries: AssistantIntegrationEntry[] =
    integrationsDraft.mode === "allowlist" ? integrationsDraft.entries : [];

  // Skills catalog queries — owner-scoped when the assistant has a team
  // owner. Both page to exhaustion (useAllSkills): the server caps one page
  // at 24, and an allowlisted name that lived on page 2 rendered as a
  // "(not found)" chip and could be destroyed. Reading the whole catalog is
  // the only safe basis for calling a name dangling. Fetched only when the
  // allowlist UI can show it — in "all" mode (the common case) the paging
  // loops never run.
  const ownerQuery =
    assistant.owner.type === "team"
      ? { ownerType: "team" as const, ownerId: assistant.owner.id }
      : {};
  const wantCatalog = skillsMode === "allowlist";
  const skillsQ = useAllSkills(ownerQuery, { enabled: wantCatalog });
  const pluginSkillsQ = useAllSkills({}, { enabled: wantCatalog });

  const skillsError = skillsQ.error ?? pluginSkillsQ.error;
  const skillsResolved = skillsQ.data !== undefined && pluginSkillsQ.data !== undefined;

  // The catalog is whole only when BOTH queries reached their final page. A
  // name is classified as dangling only against a whole catalog (below).
  const catalogComplete =
    skillsQ.data?.complete === true && pluginSkillsQ.data?.complete === true;

  const catalogSkillNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of skillsQ.data?.skills ?? []) names.add(s.name);
    for (const s of pluginSkillsQ.data?.skills ?? []) {
      if (s.origin === "plugin") names.add(s.name);
    }
    return names;
  }, [skillsQ.data, pluginSkillsQ.data]);

  // Archive dialog state.
  const [archiveOpen, setArchiveOpen] = useState(false);

  // ── save handlers ────────────────────────────────────────────────────

  // Only fields that DIFFER from the server row go on the wire. Sending an
  // untouched blank personality as null would EXPLICITLY CLEAR it — and for
  // an assistant whose persona still lives in the legacy memory file (column
  // null, textarea blank), a rename-only save would silently destroy that
  // persona. Diffing also makes an emptied field an intentional clear (null)
  // without turning every save into one.
  const trimmedName = name.trim();
  const trimmedPersonality = personality.trim();
  const nameChanged = trimmedName !== (assistant.name ?? "");
  const personalityChanged = trimmedPersonality !== (assistant.personality ?? "");
  const identityDirty = nameChanged || personalityChanged;

  function saveIdentity() {
    if (!identityDirty) return;
    identityPatch.mutate(
      {
        id: assistant.id,
        body: {
          ...(nameChanged ? { name: trimmedName === "" ? null : trimmedName } : {}),
          ...(personalityChanged
            ? { personality: trimmedPersonality === "" ? null : trimmedPersonality }
            : {}),
        },
      },
      {
        onSuccess: () => {
          identityTouched.current = false;
        },
      },
    );
  }

  // Each section's Save builds its PATCH body from the cached server row
  // (`assistant.behavior`) plus only its OWN draft. usePatchAssistant writes
  // every PATCH response back into that cache synchronously, so a save
  // issued after another section's response reads that save's result. Two
  // behavior saves IN FLIGHT at once would still last-write-wins (both
  // spread the same pre-save row and the server replaces the whole column),
  // so `behaviorSaving` below disables BOTH Save buttons while either
  // mutation is pending. A concurrent PATCH from another client is still
  // last-write-wins.
  const behaviorSaving = skillsPatch.isPending || integrationsPatch.isPending;

  function saveSkills() {
    const newBehavior: AssistantBehavior = { ...assistant.behavior, skills: skillsDraft };
    skillsPatch.mutate(
      { id: assistant.id, body: { behavior: newBehavior } },
      {
        onSuccess: () => {
          skillsTouched.current = false;
        },
      },
    );
  }

  function saveIntegrations() {
    const newBehavior: AssistantBehavior = {
      ...assistant.behavior,
      integrations: integrationsDraft,
    };
    integrationsPatch.mutate(
      { id: assistant.id, body: { behavior: newBehavior } },
      {
        onSuccess: () => {
          integrationsTouched.current = false;
        },
      },
    );
  }

  function editName(value: string) {
    identityTouched.current = true;
    setName(value);
  }

  function editPersonality(value: string) {
    identityTouched.current = true;
    setPersonality(value);
  }

  function setSkillsMode(mode: "all" | "allowlist") {
    skillsTouched.current = true;
    setSkillsDraft(mode === "all" ? { mode: "all" } : { mode: "allowlist", names: allowedSkillNames });
  }

  function toggleSkill(skillName: string, checked: boolean) {
    skillsTouched.current = true;
    setSkillsDraft((prev) => {
      const names = prev.mode === "allowlist" ? prev.names : [];
      return {
        mode: "allowlist",
        names: checked ? [...names, skillName] : names.filter((n) => n !== skillName),
      };
    });
  }

  function removeSkill(skillName: string) {
    toggleSkill(skillName, false);
  }

  function setIntegrationsMode(mode: "all" | "allowlist") {
    integrationsTouched.current = true;
    setIntegrationsDraft(
      mode === "all" ? { mode: "all" } : { mode: "allowlist", entries: allowedEntries },
    );
  }

  function toggleIntegration(service: string, checked: boolean) {
    integrationsTouched.current = true;
    setIntegrationsDraft((prev) => {
      const entries = prev.mode === "allowlist" ? prev.entries : [];
      if (checked) {
        if (entries.find((e) => e.service === service)) return prev;
        return { mode: "allowlist", entries: [...entries, { service }] };
      }
      return { mode: "allowlist", entries: entries.filter((e) => e.service !== service) };
    });
  }

  function toggleExcludeAction(service: string, actionId: string, exclude: boolean) {
    integrationsTouched.current = true;
    setIntegrationsDraft((prev) => {
      const entries = prev.mode === "allowlist" ? prev.entries : [];
      return {
        mode: "allowlist",
        entries: entries.map((e) => {
          if (e.service !== service) return e;
          const current = e.excludeActions ?? [];
          const next = exclude ? [...current, actionId] : current.filter((id) => id !== actionId);
          return { ...e, excludeActions: next.length > 0 ? next : undefined };
        }),
      };
    });
  }

  // Dangling skill names (in allowlist, not in catalog). Only classified
  // against a WHOLE catalog — a partial catalog would flag a real name that
  // lives on a later page as "(not found)" and invite its removal.
  const danglingNames = catalogComplete
    ? allowedSkillNames.filter((n) => !catalogSkillNames.has(n))
    : [];

  const label = assistantLabel(assistant);
  const displayName = name.trim() || label;

  // The wake sentence — the LITERAL persona prefix the engine injects into
  // this assistant's systemPrompt (assistants/persona.ts), live from the
  // unsaved fields so an edit shows its consequence before Save.
  const previewName = name.trim();
  const previewPersonality = personality.trim();

  return (
    <div className="space-y-12">
      {/* ── Masthead ─────────────────────────────────────────────────── */}
      <header className="space-y-5">
        <div className="flex items-start gap-4">
          <div
            aria-hidden
            className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-moss-wash font-display text-xl font-semibold text-moss"
          >
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-display text-2xl text-ink">{displayName}</h1>
              {assistant.isDefault && <Badge variant="accent">Default</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {assistant.owner.type === "user"
                ? "This assistant stays in your personal workspace."
                : `This assistant belongs to ${owningTeamName ?? "this team"}. Everyone on the team can use it.`}
            </p>
          </div>
        </div>

        {/* The persona sentence, exactly as the next wake injects it. */}
        <figure className="border-l-2 border-moss pl-4">
          <figcaption className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            Wakes with
          </figcaption>
          {previewName ? (
            <p className="mt-1 text-sm leading-relaxed text-ink">
              “You are {previewName}.{previewPersonality ? ` ${previewPersonality}` : ""}”
            </p>
          ) : (
            <p className="mt-1 text-sm leading-relaxed text-muted">
              No persona yet. Name this assistant and it wakes with “You are {"{name}"}.”
            </p>
          )}
        </figure>

        {!canEdit && (
          <div className="rounded border border-line bg-ink-wash px-3 py-2 text-sm text-muted">
            Only team admins can edit this assistant.
          </div>
        )}
      </header>

      {/* ── 1. Identity ──────────────────────────────────────────────── */}
      <Section
        title="Identity"
        description="Name and personality shown in the sidebar and at the top of each conversation."
      >
        <FieldRow label="Name">
          <Input
            aria-label="Name"
            value={name}
            onChange={(e) => editName(e.target.value)}
            disabled={!canEdit}
            placeholder="Assistant name"
          />
        </FieldRow>
        <FieldRow
          label="Personality"
          hint="How the assistant speaks and approaches problems. Leave blank for the neutral default."
        >
          <Textarea
            aria-label="Personality"
            value={personality}
            onChange={(e) => editPersonality(e.target.value)}
            disabled={!canEdit}
            rows={4}
            // The server cap: the API 400s a longer value, so the field stops
            // the overflow up front. One constant, imported from the wire.
            maxLength={PERSONALITY_INJECT_CAP}
            placeholder="Warm and direct. Prefers checklists over prose."
          />
          {personality.length > PERSONALITY_INJECT_CAP - 100 && (
            <p className="mt-1 text-right text-xs text-muted">
              {personality.length}/{PERSONALITY_INJECT_CAP}
            </p>
          )}
        </FieldRow>
        <div className="flex items-center gap-3 py-4">
          <Button
            type="button"
            onClick={saveIdentity}
            disabled={!canEdit || identityPatch.isPending || !identityDirty}
            aria-label="Save identity"
          >
            {identityPatch.isPending ? "Saving…" : "Save identity"}
          </Button>
          {identityPatch.error != null && (
            <p className="text-xs text-danger-500">{errorText(identityPatch.error)}</p>
          )}
        </div>
      </Section>

      {/* ── 2. Skills ────────────────────────────────────────────────── */}
      <Section
        title="Skills"
        description="Which skills this assistant can use. Skills extend what the assistant knows how to do."
      >
        <div className="space-y-4 py-4">
          <div role="radiogroup" aria-label="Skill access" className="grid gap-2 sm:grid-cols-2">
            <RadioCard
              title="All skills"
              ariaLabel="All skills"
              description="Everything in the catalog, including skills added later."
              selected={skillsMode === "all"}
              onSelect={() => setSkillsMode("all")}
              disabled={!canEdit}
            />
            <RadioCard
              title="Only these skills"
              ariaLabel="Only these skills"
              description="A fixed set. New skills stay off until you add them."
              selected={skillsMode === "allowlist"}
              onSelect={() => setSkillsMode("allowlist")}
              disabled={!canEdit}
            />
          </div>

          {skillsMode === "allowlist" &&
            (skillsError != null ? (
              <div className="space-y-2">
                <ErrorRow>Could not load the skill catalog: {errorText(skillsError)}</ErrorRow>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    void skillsQ.refetch?.();
                    void pluginSkillsQ.refetch?.();
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : !skillsResolved ? (
              <LoadingRow label="Loading skills…" />
            ) : (
              <div className="space-y-3">
                {/* Dangling names (not in catalog) */}
                {danglingNames.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {danglingNames.map((n) => (
                      // Wash + fg tokens, not a `warning-500/xx` slash class:
                      // no warning scale exists, so those emit no rule at all
                      // (the opacity-modifier trap, theme.css).
                      <span
                        key={n}
                        className="inline-flex items-center gap-1 rounded-full bg-warning-wash px-2.5 py-1 text-xs text-warning-fg"
                      >
                        {n}
                        <span className="text-[10px] opacity-70">(not found)</span>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => removeSkill(n)}
                            aria-label={`Remove ${n}`}
                            className="ml-0.5 rounded text-warning-fg hover:opacity-70"
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                {/* Catalog skills */}
                {catalogSkillNames.size === 0 ? (
                  <p className="text-xs text-muted">No skills available for this assistant.</p>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-line">
                    <div className="border-b border-line px-3 py-2 text-xs text-muted">
                      {allowedSkillNames.length} of {catalogSkillNames.size} skills allowed
                    </div>
                    <div className="max-h-64 overflow-y-auto p-1">
                      {[...catalogSkillNames].map((skillName) => (
                        <label
                          key={skillName}
                          className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-ink hover:bg-ink-wash"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0 accent-moss"
                            checked={allowedSkillNames.includes(skillName)}
                            onChange={(e) => toggleSkill(skillName, e.target.checked)}
                            disabled={!canEdit}
                            aria-label={skillName}
                          />
                          <span className="truncate">{skillName}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={saveSkills}
              disabled={!canEdit || behaviorSaving}
              aria-label="Save skills"
            >
              {skillsPatch.isPending ? "Saving…" : "Save skills"}
            </Button>
            {skillsPatch.error != null && (
              <p className="text-xs text-danger-500">{errorText(skillsPatch.error)}</p>
            )}
          </div>
        </div>
      </Section>

      {/* ── 3. Integrations ──────────────────────────────────────────── */}
      <Section
        title="Integrations"
        description="Which integrations this assistant can use. An integration is a connected service like GitHub."
      >
        {pluginsError != null ? (
          <div className="space-y-2 py-4">
            <ErrorRow>Could not load integrations: {errorText(pluginsError)}</ErrorRow>
            <Button type="button" variant="secondary" onClick={onRetryPlugins}>
              Retry
            </Button>
          </div>
        ) : !pluginsResolved ? (
          <LoadingRow label="Loading integrations…" className="py-4" />
        ) : (
          <div className="space-y-4 py-4">
            <div
              role="radiogroup"
              aria-label="Integration access"
              className="grid gap-2 sm:grid-cols-2"
            >
              <RadioCard
                title="All integrations"
                ariaLabel="All integrations"
                description="Every connected service, including ones connected later."
                selected={integrationsMode === "all"}
                onSelect={() => setIntegrationsMode("all")}
                disabled={!canEdit}
              />
              <RadioCard
                title="Only these integrations"
                ariaLabel="Only these integrations"
                description="A fixed set, with per-action excludes inside each service."
                selected={integrationsMode === "allowlist"}
                onSelect={() => setIntegrationsMode("allowlist")}
                disabled={!canEdit}
              />
            </div>

            {integrationsMode === "allowlist" &&
              (integrationOpts.length === 0 ? (
                <p className="text-xs text-muted">No integrations configured.</p>
              ) : (
                <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                  {integrationOpts.map((opt) => {
                    const entry = allowedEntries.find((e) => e.service === opt.service);
                    const isChecked = entry !== undefined;
                    return (
                      <div key={opt.service} className="px-3 py-2.5">
                        <label className="flex cursor-pointer items-center gap-3">
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0 accent-moss"
                            checked={isChecked}
                            onChange={(e) => toggleIntegration(opt.service, e.target.checked)}
                            disabled={!canEdit}
                            aria-label={opt.label}
                          />
                          <ServiceIcon slug={opt.icon} label={opt.label} size="sm" tone="quiet" />
                          <span className="text-sm font-medium text-ink">{opt.label}</span>
                        </label>
                        {isChecked && opt.actions.length > 0 && (
                          <div className="mt-2 space-y-0.5 pl-16">
                            {opt.actions.map((action) => {
                              const excluded = (entry?.excludeActions ?? []).includes(action.id);
                              return (
                                <label
                                  key={action.id}
                                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-muted hover:bg-ink-wash hover:text-ink"
                                >
                                  <input
                                    type="checkbox"
                                    className="h-3.5 w-3.5 shrink-0 accent-moss"
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
                </div>
              ))}

            <div className="flex items-center gap-3">
              <Button
                type="button"
                onClick={saveIntegrations}
                disabled={!canEdit || behaviorSaving}
                aria-label="Save integrations"
              >
                {integrationsPatch.isPending ? "Saving…" : "Save integrations"}
              </Button>
              {integrationsPatch.error != null && (
                <p className="text-xs text-danger-500">{errorText(integrationsPatch.error)}</p>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* ── 4. Manage ────────────────────────────────────────────────── */}
      <Section title="Manage" description="Promote or remove this assistant.">
        <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">Default assistant</div>
            <p className="mt-0.5 text-xs text-muted">
              Automations that target this workspace open the default.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {assistant.isDefault ? (
              <Badge variant="accent">This is the default</Badge>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => managePatch.mutate({ id: assistant.id, body: { isDefault: true } })}
                disabled={!canEdit || managePatch.isPending}
              >
                Make default
              </Button>
            )}
            {managePatch.error != null && (
              <p className="text-xs text-danger-500">{errorText(managePatch.error)}</p>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">Archive</div>
            <p className="mt-0.5 text-xs text-muted">
              The assistant leaves the sidebar. The threads it holds are kept.
            </p>
          </div>
          {assistant.isDefault ? (
            <p className="text-xs text-muted">Make another assistant the default first.</p>
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
