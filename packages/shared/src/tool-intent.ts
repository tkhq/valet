/** Sandbox primitives stay unchanged to avoid repeated tokens on high-volume I/O. */
export const INTENT_EXEMPT_TOOLS = ["bash", "shell", "read", "write", "edit", "read_file", "write_file", "edit_file", "list_files", "search_files"] as const;
export const TOOL_INTENT_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  pattern: "\\S",
  description: "State in one sentence, in plain words, what you are trying to accomplish and why you need this tool. Do not include secrets. Required; 1 to 500 characters.",
} as const;
export const TOOL_INTENT_ERROR = "Add intent: one sentence about your goal and why you need this tool. Use 1 to 500 characters.";

export function requiresToolIntent(name: string): boolean {
  return !INTENT_EXEMPT_TOOLS.some(exempt => exempt === name);
}

/** Validation and stripping happen together, before policy, gates, or execution. */
export function stripToolIntent(name: string, args: Record<string, unknown>): { args: Record<string, unknown>; intent: string | null } {
  const { intent, ...rest } = args;
  if (!requiresToolIntent(name)) return { args: rest, intent: null };
  if (typeof intent !== "string") throw new Error(TOOL_INTENT_ERROR);
  const trimmed = intent.trim();
  if (trimmed.length < TOOL_INTENT_SCHEMA.minLength || trimmed.length > TOOL_INTENT_SCHEMA.maxLength) throw new Error(TOOL_INTENT_ERROR);
  return { args: rest, intent: trimmed };
}

/** Adds the same JSON Schema contract without coupling shared to a schema library. */
export function withToolIntentSchema<T extends { properties?: Record<string, unknown>; required?: string[] }>(name: string, schema: T): T {
  if (!requiresToolIntent(name)) return schema;
  return { ...schema, properties: { ...schema.properties, intent: TOOL_INTENT_SCHEMA }, required: [...new Set([...(schema.required ?? []), "intent"])] };
}

export interface ToolUsageFact {
  id: string;
  orgId: string;
  userId: string;
  sessionId: string;
  threadId: string;
  name: string;
  intent: string | null;
  outcome: "ok" | "error" | "denied";
  errorCode: string | null;
  durationMs: number;
  createdAt: number;
  ownerType: "user" | "team";
  ownerId: string;
}
