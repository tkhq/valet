/**
 * The two optional prompt templates an assistant line may carry: a
 * standing instruction, and the event message the assistant reads. An
 * empty field is left off the stored target, so an empty pair sends the
 * default event message.
 */
export interface PromptFieldsValue {
  systemPrompt: string;
  userPromptTemplate: string;
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
