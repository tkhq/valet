import { Type } from "typebox";
import { type ToolDef } from "@valet/engine";
import { type ToolScope } from "@valet/shared";

const READS = ["list_workflows", "get_workflow", "get_permissions", "get_run", "get_node_result", "get_node_transcript", "get_node_diagnostics", "list_runs", "list_triggers", "list_schedules", "list_event_types", "get_webhook", "preview_workflow", "validate_definition",
  // Only shows the person an approval card, so every focus may ask for it.
  "allow_permissions"];
const REPAIRS = ["save_workflow", "patch_workflow", "update_model", "add_aggregate", "propose_trigger", "propose_schedule", "create_trigger", "update_trigger", "delete_trigger", "create_schedule", "update_schedule", "delete_schedule", "create_webhook", "delete_webhook"];
const RUNS = ["start_run", "retry_run", "cancel_run", "resolve_approval"];
const ORIGIN_REPLIES = ["slack.reply_to_origin", "slack.react_to_origin", "slack.reply_file_to_origin", "telegram.reply_to_origin"];
const TOOLS = ["focus_tools", "list_tools", "call_tool", "skill", "ask_question", "ask_approval", "switch_model", "thread_read", "task", "child_read", "child_status", "mem_read", "mem_search"];
export type WorkflowFocus = "diagnose" | "repair" | "validate" | "general";

export function workflowToolFocus(phase: WorkflowFocus, actions: string[] = [], tools: string[] = []): ToolScope | undefined {
  if (phase === "general") return undefined;
  const workflowActions = phase === "repair" ? [...READS, ...REPAIRS] : phase === "validate" ? [...READS, ...RUNS] : READS;
  return { tools: [...TOOLS, ...(phase === "validate" ? tools : [])], actions: [...workflowActions.map((id) => `workflows.${id}`), ...ORIGIN_REPLIES, ...(phase === "validate" ? actions : [])] };
}

export function buildToolFocusTool(): ToolDef {
  const parameters = Type.Object({
      tools: Type.Optional(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }), { maxItems: 30 })),
      phase: Type.Union([Type.Literal("diagnose"), Type.Literal("repair"), Type.Literal("validate"), Type.Literal("general")]),
      actions: Type.Optional(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_-]+\\.[a-zA-Z0-9_.-]+$" }), { maxItems: 100 })),
    });
  const tool: ToolDef<typeof parameters> = {
    name: "focus_tools",
    description: "Focus this thread's tools for workflow diagnosis, repair, or validation. Start troubleshooting with diagnose. Select repair before editing. Select validate only for an authorized test; include each integration action the run needs. General clears focus for another task. Inherited limits and approval policies always apply. Other threads keep their own focus, and a child task gets your limits, not this focus.",
    parameters,
    riskLevel: "low",
    protectedFromPruning: true,
    execute: async (args, ctx) => {
      const phase = args.phase;
      if (phase !== "diagnose" && phase !== "repair" && phase !== "validate" && phase !== "general") return { text: "Choose diagnose, repair, validate, or general.", ok: false };
      const tools = args.tools ?? [];
      const actions = Array.isArray(args.actions) ? args.actions.filter((item): item is string => typeof item === "string") : [];
      if (!ctx.setToolFocus) return { text: "This session cannot focus tools. Use list_tools with a narrow service or query.", ok: false };
      await ctx.setToolFocus(workflowToolFocus(phase, actions, tools));
      return { text: JSON.stringify({ phase, scope: ctx.toolScope ?? null, next: "The next model call sees these tools. If a needed action is excluded, select the appropriate focus. An inherited limit requires a new task from the parent." }) };
    },
  };
  return tool;
}
