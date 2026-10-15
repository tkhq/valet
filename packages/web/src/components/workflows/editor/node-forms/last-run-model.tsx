/**
 * The models a step called in the workflow's last run. A step on a size tier
 * or the default follows the platform when it remaps them. A run records the
 * provider's own model id (`claude-sonnet-4-5`, `default`, or OpenRouter's
 * `openai/gpt-4.1`) and not the provider that served it. Different providers
 * can expose the same id, so the form shows the id and offers no pin. To keep
 * the model, the person picks it in the step's model field.
 */
export function LastRunModel({ models }: { models?: string[] }) {
  if (!models?.length) return null;
  return <p className="text-xs text-muted">Last run used {models.join(", ")}.</p>;
}
