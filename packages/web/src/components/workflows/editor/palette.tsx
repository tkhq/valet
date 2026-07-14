/**
 * Left rail of "add node" buttons — one per addable node type
 * (`ADDABLE_NODE_TYPES` from `editor-model.ts`, i.e. every `DagNodeType`
 * except `trigger`: a workflow has exactly one trigger, created with the
 * definition, never added from the palette). Plan decision 10.
 */
import { ADDABLE_NODE_TYPES, NODE_META, type AddableDagNodeType } from "../editor-model";

export interface PaletteProps {
  onAdd: (type: AddableDagNodeType) => void;
}

export function Palette({ onAdd }: PaletteProps) {
  return (
    <div
      aria-label="Add node"
      className="flex w-40 shrink-0 flex-col gap-1 border-r border-line bg-paper p-2"
    >
      {ADDABLE_NODE_TYPES.map((type) => {
        const meta = NODE_META[type];
        return (
          <button
            key={type}
            type="button"
            title={meta.description}
            onClick={() => onAdd(type)}
            className="rounded border border-line px-2 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-ink-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
          >
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
