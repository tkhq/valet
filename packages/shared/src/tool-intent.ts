export const TOOL_INTENT_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  pattern: "\\S",
  description: "State in one sentence, in plain words, what you are trying to accomplish and why you need this tool. Do not include secrets. Required; 1 to 500 characters.",
} as const;
export const TOOL_INTENT_ERROR = "Add intent: one sentence about your goal and why you need this tool. Use 1 to 500 characters.";

export interface IntentTool {
  /** Exempt only actual sandbox primitives. Broker tools use their existing summary. */
  intent?: "exempt" | "summary" | "passthrough";
  parameters?: { type?: unknown; properties?: Record<string, unknown> };
}

/** An action's own intent parameter must never become telemetry metadata. */
export function requiresToolIntent(tool: IntentTool): boolean {
  return tool.intent === undefined && tool.parameters?.type === "object" && !Object.hasOwn(tool.parameters.properties ?? {}, "intent");
}

export function parseToolIntent(value: unknown): string {
  if (typeof value !== "string") throw new Error(TOOL_INTENT_ERROR);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 500) throw new Error(TOOL_INTENT_ERROR);
  return trimmed;
}

/** Validation and stripping happen together, before policy, gates, or execution. */
export function stripToolIntent(tool: IntentTool, args: Record<string, unknown>): { args: Record<string, unknown>; intent: string | null } {
  if (tool.intent === "summary") return { args, intent: parseToolIntent(args.summary) };
  if (!requiresToolIntent(tool)) return { args, intent: null };
  const { intent, ...rest } = args;
  return { args: rest, intent: parseToolIntent(intent) };
}

/** Called once at publication, using the original action schema to detect collisions. */
export function withToolIntentSchema<T extends { type?: unknown; properties?: Record<string, unknown>; required?: string[] }>(tool: IntentTool, schema: T): T {
  if (!requiresToolIntent(tool)) return schema;
  return { ...schema, properties: { ...schema.properties, intent: TOOL_INTENT_SCHEMA }, required: [...new Set([...(schema.required ?? []), "intent"])] };
}

export interface ToolUsageFact {
  id: string;
  orgId: string;
  userId: string | null;
  sessionId: string;
  threadId: string;
  name: string;
  intent: string | null;
  outcome: "ok" | "error" | "denied" | "pending-approval";
  errorCode: string | null;
  durationMs: number;
  createdAt: number;
  ownerType: "user" | "team";
  ownerId: string;
}
