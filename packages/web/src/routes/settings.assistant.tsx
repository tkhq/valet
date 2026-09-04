import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { ModelCombobox } from "~/components/settings/model-combobox";
import { ReasoningSelect } from "~/components/settings/reasoning-select";
import { IdentityFields } from "~/components/assistant/identity-fields";
import { Spinner } from "~/components/primitives";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { useMe, usePatchMe } from "~/api/settings";

/**
 * `/settings/assistant` — You · Assistant. Name + personality (shared
 * `IdentityFields`, same component/mutation the dashboard's identity header
 * uses) plus the default-model typeahead (now tier-first, Task 15) over
 * `GET /api/models` + `PATCH /api/me`, and the default-reasoning select
 * over `GET /api/org/reasoning` + `PATCH /api/me`.
 */
export const Route = createFileRoute("/settings/assistant")({
  component: AssistantPage,
});

export function AssistantPage() {
  const infoQ = useOrchestratorInfo();
  const meQ = useMe();
  const patchMe = usePatchMe();

  return (
    <Section title="Assistant" description="Your assistant's name and personality, and the default model for sessions you start.">
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
        hint="New sessions you start use this model or size. Existing sessions keep theirs. Switch the model per thread in the chat header. Shared team assistants do not use it."
      >
        <ModelCombobox
          value={meQ.data?.defaultModel ?? null}
          onSelect={(id) => patchMe.mutate({ defaultModel: id })}
          onClear={() => patchMe.mutate({ defaultModel: null })}
          emptyLabel="Team or organization default"
        />
      </FieldRow>

      <FieldRow
        label="Default reasoning"
        hint="New sessions you start use this reasoning level. Existing sessions keep theirs."
      >
        <ReasoningSelect
          value={meQ.data?.defaultReasoning ?? null}
          onChange={(defaultReasoning) => patchMe.mutate({ defaultReasoning })}
          emptyLabel="Team or organization default"
        />
      </FieldRow>

      <FieldRow
        label="New thread behavior"
        hint="Choose whether a new thread keeps the current model and thinking or uses your configured defaults."
      >
        <select
          aria-label="New thread behavior"
          value={meQ.data?.newThreadBehavior ?? "keep_current"}
          onChange={(event) => {
            const newThreadBehavior = event.target.value;
            if (newThreadBehavior === "keep_current" || newThreadBehavior === "use_defaults") {
              patchMe.mutate({ newThreadBehavior });
            }
          }}
          className="h-9 w-full rounded border border-[--border] bg-[--bg] px-2 text-sm text-[--fg]"
        >
          <option value="keep_current">Keep current settings</option>
          <option value="use_defaults">Use configured defaults</option>
        </select>
      </FieldRow>
    </Section>
  );
}
