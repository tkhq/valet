import { useMemo } from "react";
import { displayName } from "~/components/integrations/display-name";
import { Badge, cardClass } from "~/components/primitives";
import { cn } from "~/lib/cn";
import type { WorkflowDefinition } from "../editor-model";
import { NODE_ICON } from "./node-icon";
import { buildSteps, modelLabel } from "./steps-model";

/**
 * The workflow as numbered steps, the editor's default view. Most workflows
 * are written by Valet, so the first job of this page is letting a person
 * check what each step does. Selecting a step opens its form beside the list.
 */
export function StepsView({ definition, gateByNodeId, errorNodeIds, selectedNodeId, onSelect }: {
  definition: WorkflowDefinition;
  gateByNodeId: ReadonlyMap<string, "require_approval" | "deny">;
  errorNodeIds: ReadonlySet<string>;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const steps = useMemo(() => buildSteps(definition, { service: displayName, model: modelLabel }), [definition]);
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <ol aria-label="Workflow steps" className={cn(cardClass, "mx-auto max-w-3xl divide-y divide-line px-0")}>
        {steps.map((step) => {
          const Icon = NODE_ICON[step.node.type];
          const gate = gateByNodeId.get(step.node.id);
          return (
            <li key={step.node.id}>
              <button
                type="button"
                onClick={() => onSelect(step.node.id)}
                aria-current={selectedNodeId === step.node.id ? "step" : undefined}
                className={cn("flex w-full gap-3 px-5 py-3 text-left hover:bg-ink-wash", selectedNodeId === step.node.id && "bg-moss-wash")}
              >
                <span className="w-5 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted">{step.number}</span>
                <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{step.title}</span>
                    {gate === "require_approval" && <Badge variant="warning">Needs approval</Badge>}
                    {gate === "deny" && <Badge variant="danger">Blocked by a policy</Badge>}
                    {errorNodeIds.has(step.node.id) && <Badge variant="danger">Needs a fix</Badge>}
                  </span>
                  <span className="block text-sm text-muted">{step.summary}</span>
                  {step.reads.length > 0 && <span className="block text-xs text-muted">Reads {step.reads.join(", ")}</span>}
                  {step.next.length > 0 && <span className="block text-xs text-muted">{step.next.join(" · ")}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
