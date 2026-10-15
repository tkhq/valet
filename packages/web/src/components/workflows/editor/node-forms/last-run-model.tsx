import type { ModelInfo } from "@valet/api/wire";
import { useModels } from "~/api/settings";
import { Button } from "~/components/primitives";

/**
 * The catalog id of a model that a run recorded. A run records the
 * provider's own id (`claude-sonnet-4-5`), and a step names a catalog id
 * (`anthropic/claude-sonnet-4-5`). Gives nothing unless exactly one catalog
 * model matches and it is approved. The match count includes unapproved
 * models: when two providers expose the same id, the run does not say which
 * one it called, so the step must not pin either.
 */
function catalogModelId(catalog: ModelInfo[], recorded: string): string | undefined {
  const matches = catalog.filter((model) => model.id === recorded || model.id.endsWith(`/${recorded}`));
  return matches.length === 1 && matches[0].approved ? matches[0].id : undefined;
}

/**
 * The model a step called in the workflow's last run. A step on a size tier
 * or the default follows the platform when it remaps them. Pinning writes the
 * concrete model into the step, so the step keeps it.
 */
export function LastRunModel({ models, value, onPin }: {
  models?: string[];
  value?: string;
  onPin: (model: string) => void;
}) {
  const catalog = useModels().data?.models ?? [];
  if (!models?.length) return null;
  const pin = models.length === 1 ? catalogModelId(catalog, models[0]) : undefined;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
      Last run used {models.join(", ")}.
      {pin && pin !== value && <Button size="sm" variant="ghost" onClick={() => onPin(pin)}>Pin this model</Button>}
    </p>
  );
}
