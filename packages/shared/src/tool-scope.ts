/** Task capability limits. Existing authorization and approval policies still apply. */
export interface ToolScope {
  tools?: string[];
  actions?: string[];
}

export const TOOL_SCOPE_KEY = "toolScope";
/** Last started task ceiling, retained after queue history is pruned. */
export const CONTINUATION_TOOL_SCOPE_KEY = "continuationToolScope";
export const INHERIT_TOOL_SCOPE_KEY = "inheritToolScope";
/** Marks a workflow task that nobody watches. The engine does not offer it tools that wait for a person. */
export const UNATTENDED_WORKFLOW_KEY = "unattendedWorkflow";
const TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
const ACTION_NAME = /^[a-zA-Z0-9_-]+\.(?:[a-zA-Z0-9_.-]+|\*)$/;

/** Invalid persisted scope data must never remove a restriction. */
function parseToolScope(value: unknown): ToolScope | undefined | false {
  if (value === undefined) return undefined;
  const denied = false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return denied;
  if (Object.keys(value).some((key) => key !== "tools" && key !== "actions")) return denied;
  const read = (key: "tools" | "actions", pattern: RegExp): string[] | undefined | false => {
    const input: unknown = key === "tools"
      ? ("tools" in value ? value.tools : undefined)
      : ("actions" in value ? value.actions : undefined);
    if (input === undefined) return undefined;
    if (!Array.isArray(input) || input.length > 200) return false;
    const result: string[] = [];
    for (const item of input) {
      if (typeof item !== "string" || item.length > 200 || !pattern.test(item)) return false;
      result.push(item);
    }
    return [...new Set(result)];
  };
  const tools = read("tools", TOOL_NAME);
  const actions = read("actions", ACTION_NAME);
  if (tools === false || actions === false) return denied;
  return { ...(tools ? { tools } : {}), ...(actions ? { actions } : {}) };
}

function includesAction(pattern: string, action: string): boolean {
  return pattern === action || (pattern.endsWith(".*") && action.startsWith(pattern.slice(0, -1)));
}

export function actionInScope(scope: ToolScope | undefined, action: string): boolean {
  return scope?.actions === undefined || scope.actions.some((pattern) => includesAction(pattern, action));
}

export function toolInScope(scope: ToolScope | undefined, tool: string): boolean {
  return scope?.tools === undefined || scope.tools.includes(tool);
}

/** Every layer can only narrow the preceding layer. */
export function intersectToolScopes(...scopes: (ToolScope | undefined)[]): ToolScope | undefined {
  let tools: string[] | undefined;
  let actions: string[] | undefined;
  for (const scope of scopes) {
    if (scope?.tools !== undefined) tools = tools === undefined ? [...scope.tools] : tools.filter((tool) => scope.tools?.includes(tool));
    if (scope?.actions !== undefined) {
      const next = scope.actions;
      actions = actions === undefined ? [...next] : [...new Set(actions.flatMap((left) =>
        next.flatMap((right) => includesAction(left, right) ? [right] : includesAction(right, left) ? [left] : [])))];
    }
  }
  return tools === undefined && actions === undefined ? undefined : {
    ...(tools !== undefined ? { tools } : {}), ...(actions !== undefined ? { actions } : {}),
  };
}

export function scopeRefusal(name: string): string {
  return `${name} is outside this task's tool scope. Select the needed focus, or ask the parent to delegate a new task.`;
}

export function readToolScope(value: unknown): ToolScope | undefined {
  const parsed = parseToolScope(value);
  return parsed === false ? { tools: [], actions: [] } : parsed;
}

/** A session-wide autonomous continuation has no single originating thread. */
export function continuationToolScope(metadata: Record<string, unknown> | undefined, threads: readonly { metadata?: Record<string, unknown> }[]): ToolScope | undefined {
  return intersectToolScopes(readToolScope(metadata?.[TOOL_SCOPE_KEY]),
    ...threads.flatMap((thread) => [readToolScope(thread.metadata?.[CONTINUATION_TOOL_SCOPE_KEY]), readToolScope(thread.metadata?.[TOOL_SCOPE_KEY])]));
}

export function isToolScope(value: unknown): value is ToolScope {
  return value !== undefined && parseToolScope(value) !== false;
}
