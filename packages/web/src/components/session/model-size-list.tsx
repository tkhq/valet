import { Check } from "lucide-react";
import type { SizeTier } from "~/lib/model-tiers";

export interface ModelSizeChoice {
  id: SizeTier;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function ModelSizeList({ choices, selectedId, onSelect }: {
  choices: readonly ModelSizeChoice[];
  selectedId?: string;
  onSelect: (id: SizeTier) => void;
}) {
  return (
    <div role="group" aria-label="Model sizes" className="divide-y divide-line overflow-hidden rounded-2xl bg-ink-wash">
      {choices.map(choice => (
        <button
          key={choice.id}
          type="button"
          data-row-kind="tier"
          aria-pressed={selectedId === choice.id}
          disabled={choice.disabled}
          onClick={() => onSelect(choice.id)}
          className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left text-ink transition-colors hover:bg-moss-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-moss disabled:opacity-50"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-base font-medium">{choice.label}</span>
            {choice.description && <span className="mt-0.5 block break-words text-sm text-muted">{choice.description}</span>}
          </span>
          {selectedId === choice.id && <Check aria-hidden="true" className="h-5 w-5 shrink-0 text-moss" />}
        </button>
      ))}
    </div>
  );
}
