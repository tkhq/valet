import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useMe, useModelTiers, usePatchMe, useOrg } from "~/api/settings";
import { FieldRow } from "~/components/settings/field-row";
import { ModelCombobox } from "~/components/settings/model-combobox";
import { ReasoningSelect } from "~/components/settings/reasoning-select";
import { Section } from "~/components/settings/section";
import { fallbackLabel } from "~/lib/model-tiers";

/** Personal defaults for new threads. Rendered on Preferences; the old path
 * redirects there. */
export const Route = createFileRoute("/settings/threads")({
  component: () => <Navigate to="/settings/preferences" replace />,
});

export function ThreadDefaultsPage() {
  const meQ = useMe();
  const patchMe = usePatchMe();
  const org = useOrg();
  const tiersQ = useModelTiers();
  const defaultSource = org.data?.features.organizations ? "Organization default" : "Valet default";

  return (
    <Section title="Thread defaults" description="Defaults for new conversations in your personal space.">
      <FieldRow
        label="Default model"
        hint={`Choose a model for new personal threads, or use the ${defaultSource.toLowerCase()}. Existing threads keep their settings.`}
      >
        <ModelCombobox
          value={meQ.data?.defaultModel ?? null}
          onSelect={(id) => patchMe.mutate({ defaultModel: id })}
          onClear={() => patchMe.mutate({ defaultModel: null })}
          emptyLabel={fallbackLabel(defaultSource, tiersQ.data)}
        />
      </FieldRow>

      <FieldRow
        label="Default reasoning"
        hint={`Choose a reasoning level for new personal threads, or use the ${defaultSource.toLowerCase()}. Existing threads keep their settings.`}
      >
        <ReasoningSelect
          value={meQ.data?.defaultReasoning ?? null}
          onChange={(defaultReasoning) => patchMe.mutate({ defaultReasoning })}
          emptyLabel={defaultSource}
        />
      </FieldRow>

    </Section>
  );
}
