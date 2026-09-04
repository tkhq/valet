/** Runtime facts for the outbound prompt. Selection tokens need not be wire model IDs. */
export interface RuntimeModelContext {
  assignedSelection: string;
  activeSelection: string;
  provider: string;
  modelId: string;
  temporaryOverride?: "switch_model" | "role model" | "submission model";
}

/** Append current facts without changing the stored prompt or inferring a model tier. */
export function appendRuntimeModelContext(prompt: string | undefined, context: RuntimeModelContext): string {
  const override = context.temporaryOverride
    ? `${context.temporaryOverride}; expires when this turn ends`
    : "none";
  const section = `## Runtime model

These runtime facts describe this model call. Use them instead of earlier model statements in the transcript.
Selections are configured tier tokens or model IDs. Do not infer a tier from a concrete model ID.
Assigned selection: ${context.assignedSelection}
Active selection: ${context.activeSelection}
Current provider: ${context.provider}
Current model: ${context.modelId}
Temporary override: ${override}`;
  return prompt ? `${prompt}\n\n${section}` : section;
}
