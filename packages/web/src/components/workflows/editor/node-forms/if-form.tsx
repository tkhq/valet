import { allowedIfOperations, type IfCondition, type IfDataType, type IfNode } from "@valet/workflow";
import { Button } from "~/components/primitives";
import { LabeledInput, SelectField } from "../fields";

const IF_DATA_TYPES: IfDataType[] = ["string", "number", "date", "boolean", "array", "object"];

function stringifyPrimitive(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseConditionRight(value: string, dataType: IfCondition["dataType"]): unknown {
  if (dataType === "number") return Number(value);
  if (dataType === "boolean") return value === "true";
  if (dataType === "array" || dataType === "object") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export function IfForm({ node, onChange }: { node: IfNode; onChange: (patch: Record<string, unknown>) => void }) {
  function updateCondition(index: number, patch: Partial<IfCondition>) {
    const conditions = node.conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition));
    onChange({ conditions });
  }

  function removeCondition(index: number) {
    onChange({ conditions: node.conditions.filter((_, i) => i !== index) });
  }

  function addCondition() {
    onChange({
      conditions: [...node.conditions, { left: "", dataType: "string", operation: "equals", right: "" }],
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="Combinator"
        value={node.combinator ?? "and"}
        onChange={(value) => onChange({ combinator: value })}
        options={[
          { value: "and", label: "AND — every condition" },
          { value: "or", label: "OR — any condition" },
        ]}
      />
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Conditions</span>
      {node.conditions.length === 0 && <p className="text-xs text-muted">No conditions — routes to false.</p>}
      {node.conditions.map((condition, index) => (
        <div key={index} className="flex flex-col gap-1 rounded border border-line p-2">
          <LabeledInput
            label="Left (template expression)"
            value={condition.left}
            onChange={(value) => updateCondition(index, { left: value })}
          />
          <SelectField
            label="Data type"
            value={condition.dataType}
            onChange={(value) =>
              // Safe narrowing: `value` always comes from `IF_DATA_TYPES`, the
              // exhaustive `IfDataType` list this select's `options` were built from.
              updateCondition(index, { dataType: value as IfCondition["dataType"], operation: "exists" })
            }
            options={IF_DATA_TYPES.map((type) => ({ value: type, label: type }))}
          />
          <SelectField
            label="Operation"
            value={condition.operation}
            onChange={(value) => updateCondition(index, { operation: value })}
            options={allowedIfOperations(condition.dataType).map((op) => ({ value: op, label: op }))}
          />
          <LabeledInput
            label="Right"
            value={stringifyPrimitive(condition.right)}
            onChange={(value) => updateCondition(index, { right: parseConditionRight(value, condition.dataType) })}
          />
          <Button variant="ghost" size="sm" onClick={() => removeCondition(index)}>
            Remove condition
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={addCondition}>
        Add condition
      </Button>
    </div>
  );
}
