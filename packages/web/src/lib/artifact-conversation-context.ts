const ARTIFACT_CONTEXT_SUFFIXES = [
  { marker: "\n\n[valet-artifact-context]: # ", prefix: "Current artifact context: " },
  { marker: "\n\n[valet-artifact-edit-context]: # ", prefix: "Saved artifact edit context: " },
];

/** Remove only Valet's valid trailing artifact context from user-facing text. */
export function stripArtifactConversationContext(text: string): string {
  for (const { marker, prefix } of ARTIFACT_CONTEXT_SUFFIXES) {
    const start = text.lastIndexOf(marker);
    if (start < 0) continue;
    try {
      const context: unknown = JSON.parse(text.slice(start + marker.length));
      if (typeof context === "string" && context.startsWith(prefix)) return text.slice(0, start);
    } catch {
      continue;
    }
  }
  return text;
}
