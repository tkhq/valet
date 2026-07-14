/**
 * Node inspector (plan decision 10): dispatches to a per-type form. Every
 * form calls `onChange` with a `Record<string, unknown>` patch — the same
 * shape `updateNode` in `editor-model.ts` expects (id/type are pinned
 * there, so a form can never smuggle a type change through).
 *
 * The foreach form is the one exception: it renders the SAME per-type
 * form components for its nested `body`, and turns a body-level patch
 * into a whole-body replacement patched onto the parent (`{ body: {...} }`)
 * — see `ForeachBodyForm` below.
 */
import {
  allowedIfOperations,
  type ApprovalNode,
  type ForeachBodyNode,
  type ForeachNode,
  type IfCondition,
  type IfDataType,
  type IfNode,
  type LlmNode,
  type OrchestratorNode,
  type SessionNode,
  type SetNode,
  type StopNode,
  type ToolNode,
  type TriggerNode,
  type WaitNode,
  type WorkflowNode,
} from "@valet/workflow";
import { Button } from "~/components/primitives";
import { JsonTextarea, LabeledInput, LabeledTextarea, NumberField, SelectField } from "./fields";

export interface InspectorProps {
  node: WorkflowNode;
  onChange: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}

export function Inspector({ node, onChange, onRemove, onDuplicate }: InspectorProps) {
  return (
    <div className="flex h-full flex-col" data-testid="inspector">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">{node.type}</span>
        <div className="flex gap-1">
          {node.type !== "trigger" && (
            <Button variant="ghost" size="sm" onClick={onDuplicate}>
              Duplicate
            </Button>
          )}
          {node.type !== "trigger" && (
            <Button variant="danger" size="sm" onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <NodeForm key={node.id} node={node} onChange={onChange} />
      </div>
    </div>
  );
}

/** `key={node.id}` at the call site remounts this on node-selection change, so every
 * form's local state (JsonTextarea buffers, etc.) resets instead of leaking across nodes. */
function NodeForm({ node, onChange }: { node: WorkflowNode; onChange: (patch: Record<string, unknown>) => void }) {
  switch (node.type) {
    case "trigger":
      return <TriggerForm node={node} />;
    case "set":
      return <SetForm node={node} onChange={onChange} />;
    case "if":
      return <IfForm node={node} onChange={onChange} />;
    case "wait":
      return <WaitForm node={node} onChange={onChange} />;
    case "approval":
      return <ApprovalForm node={node} onChange={onChange} />;
    case "session":
      return <SessionForm node={node} onChange={onChange} />;
    case "stop":
      return <StopForm node={node} onChange={onChange} />;
    case "foreach":
      return <ForeachForm node={node} onChange={onChange} />;
    case "llm":
      return <LlmForm node={node} onChange={onChange} />;
    case "orchestrator":
      return <OrchestratorForm node={node} onChange={onChange} />;
    case "tool":
      return <ToolForm node={node} onChange={onChange} />;
  }
}

// ─── trigger (read-only) ──────────────────────────────────────────────────

function TriggerForm({ node }: { node: TriggerNode }) {
  return (
    <p className="text-sm text-muted">
      The trigger is where the workflow starts. It receives the run's input data and cannot be
      removed or reconfigured here.
      {node.dataSchema && Object.keys(node.dataSchema).length > 0 && (
        <span className="mt-2 block text-xs">
          Declared inputs: {Object.keys(node.dataSchema).join(", ")}
        </span>
      )}
    </p>
  );
}

// ─── set ──────────────────────────────────────────────────────────────────

/** `values` is `unknown` on the wire — here it's edited as a flat key/value template row list. */
function SetForm({ node, onChange }: { node: SetNode; onChange: (patch: Record<string, unknown>) => void }) {
  const values = asRecord(node.values);
  const entries = Object.entries(values);

  function commit(next: Record<string, unknown>) {
    onChange({ values: next });
  }

  function updateEntry(index: number, key: string, value: string) {
    const next = Object.fromEntries(entries.map(([k, v], i) => (i === index ? [key, value] : [k, v])));
    commit(next);
  }

  function removeEntry(index: number) {
    const next = Object.fromEntries(entries.filter((_, i) => i !== index));
    commit(next);
  }

  function addEntry() {
    commit({ ...values, "": "" });
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Values</span>
      {entries.length === 0 && <p className="text-xs text-muted">No values configured.</p>}
      {entries.map(([key, value], index) => (
        <div key={index} className="flex items-start gap-1">
          <LabeledInput label="Key" value={key} onChange={(next) => updateEntry(index, next, String(value ?? ""))} />
          <LabeledInput
            label="Value (template)"
            value={String(value ?? "")}
            onChange={(next) => updateEntry(index, key, next)}
          />
          <Button variant="ghost" size="sm" className="mt-5" onClick={() => removeEntry(index)}>
            &times;
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={addEntry}>
        Add value
      </Button>
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ─── if ───────────────────────────────────────────────────────────────────

const IF_DATA_TYPES: IfDataType[] = ["string", "number", "date", "boolean", "array", "object"];

function IfForm({ node, onChange }: { node: IfNode; onChange: (patch: Record<string, unknown>) => void }) {
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

// ─── wait ─────────────────────────────────────────────────────────────────

function WaitForm({ node, onChange }: { node: WaitNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <LabeledInput
      label="Duration (e.g. 5m, 1h, 30s)"
      value={node.duration}
      onChange={(value) => onChange({ duration: value })}
    />
  );
}

// ─── approval ─────────────────────────────────────────────────────────────

function ApprovalForm({ node, onChange }: { node: ApprovalNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledTextarea label="Prompt" value={node.prompt} onChange={(value) => onChange({ prompt: value })} />
      <LabeledInput label="Summary" value={node.summary ?? ""} onChange={(value) => onChange({ summary: value || undefined })} />
      <JsonTextarea label="Details (JSON)" value={node.details} onChange={(value) => onChange({ details: value })} />
      <LabeledInput
        label="Timeout (e.g. 1h, 1d)"
        value={node.timeout ?? ""}
        onChange={(value) => onChange({ timeout: value || undefined })}
      />
      <SelectField
        label="On deny"
        value={node.onDeny ?? "fail"}
        onChange={(value) => onChange({ onDeny: value })}
        options={[
          { value: "fail", label: "Fail the run" },
          { value: "skip", label: "Skip downstream" },
        ]}
      />
    </div>
  );
}

// ─── session ──────────────────────────────────────────────────────────────

function SessionForm({ node, onChange }: { node: SessionNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledTextarea label="Prompt" value={node.prompt} onChange={(value) => onChange({ prompt: value })} />
      <LabeledInput label="Title" value={node.title ?? ""} onChange={(value) => onChange({ title: value || undefined })} />
      <LabeledInput label="Model" value={node.model ?? ""} onChange={(value) => onChange({ model: value || undefined })} />
      <JsonTextarea
        label="Output schema (JSON)"
        value={node.outputSchema}
        onChange={(value) => onChange({ outputSchema: value })}
      />
      <SelectField
        label="Wait mode"
        value={node.wait?.mode ?? "none"}
        onChange={(value) => onChange({ wait: { mode: value } })}
        options={[
          { value: "none", label: "None — don't wait" },
          { value: "until_idle", label: "Until idle" },
        ]}
      />
    </div>
  );
}

// ─── stop ─────────────────────────────────────────────────────────────────

function StopForm({ node, onChange }: { node: StopNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="Outcome"
        value={node.outcome ?? "success"}
        onChange={(value) => onChange({ outcome: value })}
        options={[
          { value: "success", label: "Success" },
          { value: "failure", label: "Failure" },
        ]}
      />
      <LabeledTextarea label="Message" value={node.message ?? ""} onChange={(value) => onChange({ message: value || undefined })} />
      <JsonTextarea label="Output (JSON)" value={node.output} onChange={(value) => onChange({ output: value })} />
    </div>
  );
}

// ─── llm ──────────────────────────────────────────────────────────────────

function LlmForm({ node, onChange }: { node: LlmNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledInput label="Model" value={node.model} onChange={(value) => onChange({ model: value })} />
      <LabeledTextarea label="System" value={node.system ?? ""} onChange={(value) => onChange({ system: value || undefined })} />
      <LabeledTextarea label="Prompt" value={node.prompt} onChange={(value) => onChange({ prompt: value })} />
      <JsonTextarea
        label="Output schema (JSON)"
        value={node.outputSchema}
        onChange={(value) => onChange({ outputSchema: value })}
      />
      <NumberField
        label="Temperature"
        value={node.temperature}
        onChange={(value) => onChange({ temperature: value })}
        min={0}
        max={2}
        step={0.1}
      />
      <NumberField
        label="Max output tokens"
        value={node.maxOutputTokens}
        onChange={(value) => onChange({ maxOutputTokens: value })}
        min={1}
      />
    </div>
  );
}

// ─── orchestrator ─────────────────────────────────────────────────────────

function OrchestratorForm({ node, onChange }: { node: OrchestratorNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledTextarea label="Prompt" value={node.prompt} onChange={(value) => onChange({ prompt: value })} />
      <JsonTextarea
        label="Output schema (JSON)"
        value={node.outputSchema}
        onChange={(value) => onChange({ outputSchema: value })}
      />
      <SelectField
        label="Wait mode"
        value={node.wait?.mode ?? "none"}
        onChange={(value) => onChange({ wait: { mode: value } })}
        options={[
          { value: "none", label: "None — don't wait" },
          { value: "until_idle", label: "Until idle" },
        ]}
      />
    </div>
  );
}

// ─── tool ─────────────────────────────────────────────────────────────────

function ToolForm({ node, onChange }: { node: ToolNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledInput label="Service" value={node.service} onChange={(value) => onChange({ service: value })} />
      <LabeledInput label="Action" value={node.action} onChange={(value) => onChange({ action: value })} />
      <JsonTextarea
        label="Params (JSON)"
        value={node.params}
        onChange={(value) => onChange({ params: value && typeof value === "object" ? value : {} })}
      />
      <LabeledInput label="Summary" value={node.summary ?? ""} onChange={(value) => onChange({ summary: value || undefined })} />
    </div>
  );
}

// ─── foreach (+ nested body sub-form) ──────────────────────────────────────

const FOREACH_BODY_TYPES: ForeachBodyNode["type"][] = ["llm", "tool", "set", "orchestrator", "session"];

function ForeachForm({ node, onChange }: { node: ForeachNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledInput
        label="Items (template expression, must resolve to an array)"
        value={node.items}
        onChange={(value) => onChange({ items: value })}
      />
      <LabeledInput
        label="Item alias (default: item)"
        value={node.itemAlias ?? ""}
        onChange={(value) => onChange({ itemAlias: value || undefined })}
      />
      <LabeledInput
        label="Index alias (default: index)"
        value={node.indexAlias ?? ""}
        onChange={(value) => onChange({ indexAlias: value || undefined })}
      />
      <NumberField label="Max items" value={node.maxItems} onChange={(value) => onChange({ maxItems: value })} min={1} />
      <NumberField
        label="Concurrency"
        value={node.concurrency}
        onChange={(value) => onChange({ concurrency: value })}
        min={1}
        max={10}
      />
      <SelectField
        label="On item error"
        value={node.onItemError ?? "fail"}
        onChange={(value) => onChange({ onItemError: value })}
        options={[
          { value: "fail", label: "Fail the loop" },
          { value: "skip", label: "Skip the item" },
          { value: "collect", label: "Collect the error" },
        ]}
      />

      <div className="rounded border border-line p-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Body</span>
        <ForeachBodyForm
          body={node.body}
          onChange={(body) => onChange({ body })}
        />
      </div>
    </div>
  );
}

/**
 * Reuses the same per-type forms as the top-level dispatch (`NodeForm`)
 * for the foreach body — a body-level field patch is merged into the
 * current body and the WHOLE resulting body object is sent up as a single
 * `{ body }` patch on the parent foreach node.
 */
function ForeachBodyForm({ body, onChange }: { body: ForeachBodyNode; onChange: (body: ForeachBodyNode) => void }) {
  function changeBodyType(type: ForeachBodyNode["type"]) {
    if (type === body.type) return;
    onChange(defaultForeachBody(type, body.id));
  }

  function patchBody(patch: Record<string, unknown>) {
    onChange({ ...body, ...patch, id: body.id, type: body.type } as ForeachBodyNode);
  }

  return (
    <div className="mt-2 flex flex-col gap-3">
      <SelectField
        label="Body type"
        value={body.type}
        // Safe narrowing: `value` always comes from `FOREACH_BODY_TYPES`, the
        // exhaustive body-type list this select's `options` were built from.
        onChange={(value) => changeBodyType(value as ForeachBodyNode["type"])}
        options={FOREACH_BODY_TYPES.map((type) => ({ value: type, label: type }))}
      />
      <BodyNodeForm key={`${body.id}:${body.type}`} node={body} onChange={patchBody} />
    </div>
  );
}

function BodyNodeForm({ node, onChange }: { node: ForeachBodyNode; onChange: (patch: Record<string, unknown>) => void }) {
  switch (node.type) {
    case "llm":
      return <LlmForm node={node} onChange={onChange} />;
    case "tool":
      return <ToolForm node={node} onChange={onChange} />;
    case "set":
      return <SetForm node={node} onChange={onChange} />;
    case "orchestrator":
      return <OrchestratorForm node={node} onChange={onChange} />;
    case "session":
      return <SessionForm node={node} onChange={onChange} />;
  }
}

function defaultForeachBody(type: ForeachBodyNode["type"], id: string): ForeachBodyNode {
  switch (type) {
    case "llm":
      return { id, type: "llm", model: "", prompt: "" };
    case "tool":
      return { id, type: "tool", service: "", action: "", params: {} };
    case "set":
      return { id, type: "set", values: {} };
    case "orchestrator":
      return { id, type: "orchestrator", prompt: "" };
    case "session":
      return { id, type: "session", mode: "start", prompt: "" };
  }
}
