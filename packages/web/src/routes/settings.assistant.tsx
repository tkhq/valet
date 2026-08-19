import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { ModelCombobox } from "~/components/settings/model-combobox";
import { UserModelPreferencesSection } from "~/components/settings/user-model-preferences-section";
import { IdentityFields } from "~/components/assistant/identity-fields";
import { Spinner } from "~/components/primitives";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { useMe, usePatchMe } from "~/api/settings";

/**
 * `/settings/assistant` — You · Assistant. Name + personality (shared
 * `IdentityFields`, same component/mutation the dashboard's identity header
 * uses) plus the default-model typeahead over `GET /api/models` +
 * `PATCH /api/me`.
 */
export const Route = createFileRoute("/settings/assistant")({
  component: AssistantPage,
});

export function AssistantPage() {
  const infoQ = useOrchestratorInfo();
  const meQ = useMe();
  const patchMe = usePatchMe();

  return (
    <Section title="Assistant" description="Your assistant's name, personality, and default model.">
      {infoQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {infoQ.error && (
        <div className="py-4 text-sm text-danger-500">Failed to load your assistant.</div>
      )}
      {infoQ.data && (
        <div className="py-4">
          <IdentityFields
            variant="settings"
            hideHeading
            initialName={infoQ.data.name}
            initialPersonality={infoQ.data.personality}
          />
        </div>
      )}

      <FieldRow
        label="Default model"
        hint="New conversations start on this model. You can still switch per thread in the chat header. If you clear this field, Valet uses the fallback list below."
      >
        <ModelCombobox
          value={meQ.data?.defaultModel ?? null}
          onSelect={(id) => patchMe.mutate({ defaultModel: id })}
          onClear={() => patchMe.mutate({ defaultModel: null })}
        />
      </FieldRow>

      <div className="border-t border-line pt-4">
        <UserModelPreferencesSection />
      </div>
    </Section>
  );
}
