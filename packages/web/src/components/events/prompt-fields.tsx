/**
 * The two optional prompt templates an assistant-targeted automation may
 * carry: a standing instruction, and the event message the assistant reads.
 * Shared by the creation wizard's Then step and the edit dialog, so one rule
 * reads the same in both places.
 *
 * Both fields are empty by default. An empty pair delivers the default event
 * message, which is what every rule written before these fields does. The
 * server validates the variables against the events the rule selects and
 * answers a named refusal, so this form does not repeat that check.
 */
import { Label, Textarea } from "~/components/primitives";

export interface PromptFieldsValue {
  systemPrompt: string;
  userPromptTemplate: string;
}

/** The stored target's templates as form state. Absent reads as empty. */
export function promptFieldsFrom(target: {
  systemPrompt?: string;
  userPromptTemplate?: string;
}): PromptFieldsValue {
  return {
    systemPrompt: target.systemPrompt ?? "",
    userPromptTemplate: target.userPromptTemplate ?? "",
  };
}

/** The form state as target fields. An empty field is left off the target. */
export function promptFieldsToTarget(value: PromptFieldsValue): {
  systemPrompt?: string;
  userPromptTemplate?: string;
} {
  const systemPrompt = value.systemPrompt.trim();
  const userPromptTemplate = value.userPromptTemplate.trim();
  return {
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    ...(userPromptTemplate.length > 0 ? { userPromptTemplate } : {}),
  };
}

export function PromptFields({
  idPrefix,
  value,
  onChange,
}: {
  /** Prefix for the field ids, so two forms on one page stay distinct. */
  idPrefix: string;
  value: PromptFieldsValue;
  onChange: (next: PromptFieldsValue) => void;
}) {
  return (
    <div className="space-y-2 pt-2">
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-system-prompt`}>Instructions for the assistant (optional)</Label>
        <Textarea
          id={`${idPrefix}-system-prompt`}
          rows={2}
          value={value.systemPrompt}
          onChange={(e) => onChange({ ...value, systemPrompt: e.target.value })}
          placeholder="Triage this pull request. Answer in one sentence."
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-user-prompt`}>Event message (optional)</Label>
        <Textarea
          id={`${idPrefix}-user-prompt`}
          rows={2}
          value={value.userPromptTemplate}
          onChange={(e) => onChange({ ...value, userPromptTemplate: e.target.value })}
          placeholder="{{payload.sender}} opened {{payload.repo}}: {{event.summary}}"
        />
      </div>
      <p className="text-xs text-muted">
        Leave both empty to send the default event message. In either field you can use{" "}
        <code>{"{{event.key}}"}</code>, <code>{"{{event.summary}}"}</code>,{" "}
        <code>{"{{event.body}}"}</code>, <code>{"{{refs.name}}"}</code>, and{" "}
        <code>{"{{payload.field}}"}</code> for a filter field your events declare.
      </p>
    </div>
  );
}
