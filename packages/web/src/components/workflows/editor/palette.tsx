/**
 * Left rail of "add node" buttons — one per addable node type
 * (`ADDABLE_NODE_TYPES` from `editor-model.ts`, i.e. every `DagNodeType`
 * except `trigger`: a workflow has exactly one trigger, created with the
 * definition, never added from the palette). Plan decision 10.
 */
import { ADDABLE_NODE_TYPES, NODE_META, type AddableDagNodeType } from "../editor-model";
import { NODE_ICON } from "./node-icon";

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
        // The same mark the node carries on the canvas, so pressing a
        // button and finding the card it made is one step, not a search.
        const Icon = NODE_ICON[type];
        return (
          <button
            key={type}
            type="button"
            title={meta.description}
            onClick={() => onAdd(type)}
            className="flex items-center gap-2 rounded border border-line px-2 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-ink-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
