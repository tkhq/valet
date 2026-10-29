/** The model and reasoning a new thread starts with (`GET /api/sessions/:id/thread-defaults`). */
import { useQuery } from "@tanstack/react-query";
import type { ThreadDefaultsResponse } from "@valet/api/wire";
import { sameModelSpec } from "~/lib/models";
import { api } from "./client";

export const qkThreadDefaults = {
  all: ["thread-defaults"] as const,
  session: (sessionId: string) => ["thread-defaults", sessionId] as const,
};

export function useThreadDefaults(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: qkThreadDefaults.session(sessionId),
    queryFn: () => api.getThreadDefaults(sessionId),
    enabled,
  });
}

/**
 * The default fields a save would change so new threads match this thread,
 * or undefined when it would change nothing. A field the assistant carries
 * outranks the defaults, so a save never offers it.
 */
export function defaultSaveBody(
  defaults: ThreadDefaultsResponse,
  current: { model?: string; reasoning?: string | null },
): { defaultModel?: string; defaultReasoning?: string } | undefined {
  const body: { defaultModel?: string; defaultReasoning?: string } = {};
  if (defaults.scope && current.model && !sameModelSpec(current.model, defaults.model)) body.defaultModel = current.model;
  if (defaults.reasoningScope && current.reasoning && current.reasoning !== defaults.reasoning) body.defaultReasoning = current.reasoning;
  return body.defaultModel !== undefined || body.defaultReasoning !== undefined ? body : undefined;
}

/**
 * The fields where this thread differs from what new threads get, while the
 * assistant's own setting for that field outranks the defaults. No save can
 * change those fields for new threads.
 */
export function carriedFields(
  defaults: ThreadDefaultsResponse,
  current: { model?: string; reasoning?: string | null },
): ("model" | "reasoning")[] {
  const fields: ("model" | "reasoning")[] = [];
  if (!defaults.scope && current.model && !sameModelSpec(current.model, defaults.model)) fields.push("model");
  if (!defaults.reasoningScope && current.reasoning && current.reasoning !== defaults.reasoning) fields.push("reasoning");
  return fields;
}
