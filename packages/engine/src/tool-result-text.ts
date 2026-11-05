/** Read the same tool text during live persistence and transcript reconstruction. */
export function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  if ("text" in result && typeof result.text === "string") return result.text;
  if ("content" in result && Array.isArray(result.content)) {
    return result.content.filter((block): block is { type: "text"; text: string } =>
      !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      .map(block => block.text).join("");
  }
  return JSON.stringify(result) ?? "";
}

/** A failure can carry both an interruption reason and a durable operation receipt. */
export function failedToolResultText(part: { error?: string; result?: unknown }): string {
  const result = toolResultText(part.result);
  if (part.error) return result && result !== part.error ? `${part.error}\n${result}` : part.error;
  return result || "tool call failed";
}
