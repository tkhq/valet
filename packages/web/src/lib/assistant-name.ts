import type { AssistantSummary } from "@valet/api/wire";

/** Display names never substitute the owning team's name for the assistant. */
export function orchestratorName(name: string | null | undefined): string {
  return name?.trim() || "Default Orchestrator";
}

export function assistantLabel(assistant: Pick<AssistantSummary, "name" | "isDefault">): string {
  return assistant.isDefault
    ? orchestratorName(assistant.name)
    : assistant.name?.trim() || "Untitled assistant";
}
