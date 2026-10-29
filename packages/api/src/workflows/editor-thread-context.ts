import { workflowRunIdFromThreadKey } from "./run-conversations.js";

/** The editor conversation key for one viewer of one workflow. The route that
 * opens the conversation and the context resolver below both use it, so the
 * key shape cannot drift between them. */
export function workflowConversationKey(workflowId: string, userId: string): string {
  return `workflow:${workflowId}:${userId}`;
}

/** Conversation context is a hint, not a grant. Workflow tools enforce access.
 * Accepts the per-viewer key and the earlier `workflow:<id>` key. */
export function workflowEditorThreadContext(thread: { key: string }): string | undefined {
  const match = /^workflow:(wf_[A-Za-z0-9_-]+)(?::[A-Za-z0-9_.@-]+)?$/.exec(thread.key);
  if (!match) return undefined;
  return [
    `This conversation is the visual editor for workflow ${match[1]}. Read that workflow before answering questions or making changes.`,
    "If it still has a placeholder name such as \"Untitled workflow\" and only start and stop steps, the person is creating it: give it a name that says what it does, based on their request.",
    "This editor starts with diagnosis tools. Call focus_tools with repair before editing, or validate before an authorized test. Name the exact actions and native tools that the test needs. Load workflow-troubleshooting for failures or unexpected results.",
    "Before the first step, restate the plan in two or three lines: what starts it, what each step does, and where the result goes.",
    "If a gap would change the build, such as which event, channel, repo, or account to use, call ask_question once with the plan as `detail` and the likely answers as `options`.",
    "Otherwise, build it and list what you assumed.",
    "Use patch_workflow to build its steps incrementally so the person can review the canvas.",
    "Use propose_trigger or propose_schedule for automation so the person can review the saved configuration before enabling it.",
    "A save allows nothing. When the workflow is built and a save result lists needsApproval, call allow_permissions once, so the person allows those steps and their shared accounts in one card and runs never stop to ask.",
    "Do not run it or enable schedules or event subscriptions unless the person explicitly asks.",
    "If the person asks you to test it, first state 2 to 4 concrete checks that the result must pass.",
    "Then call preview_workflow to find template and structure errors. A preview has no side effects.",
    "Start a real run only after the person agrees, because a real run posts messages and calls integrations.",
    "Read its result in the workflow.settled report and with get_node_result. Fix the workflow and run it again, at most 3 times.",
    "End the test with each check marked passed or failed.",
    "In replies, call the workflow by its name. Do not show its wf_ id.",
    "The workflow tools enforce the current owner's permissions.",
  ].join(" ");
}

/** A run with no conversation origin reports on its own thread
 * (`workflowRunThreadKey`), and a `thread: "step"` step runs on a thread of
 * its own (`workflowStepThreadKey`) in any run. A run started from a
 * conversation reports there, so that key never matches. */
export function isWorkflowRunThread(thread: { key: string }): boolean {
  return workflowRunIdFromThreadKey(thread.key) !== undefined;
}

/** Nobody answers questions during a run. The engine refuses every decision on
 * a run thread's signal turns before a gate opens (`unattendedThread` in
 * `engine/host.ts`), so the rule covers every signal message: the run's own
 * `workflow.request` (`engine-deps.ts#promptOrchestrator`) and anything that
 * continues it, such as a delegated task's `child.settled`. A guess about what
 * an action says is as unsafe as a guess about where it goes. A person's reply
 * on the run page arrives as plain text and keeps the normal rules. */
export function workflowRunThreadContext(thread: { key: string }): string | undefined {
  if (!isWorkflowRunThread(thread)) return undefined;
  return [
    "Nobody can answer a question or approve an action during this run.",
    "If a fact that a send, change, or delete needs is missing or in conflict, do not do that action.",
    "This covers what the action says, such as a price or a time, and where it goes.",
    "Say in the result what was missing, so the workflow's author can fix the workflow.",
    "For other gaps, state your assumptions in the result.",
    "These rules apply to every signal message in this conversation, such as signalType `workflow.request` or `child.settled`.",
    "When a person writes in this conversation, use your normal rules for questions.",
  ].join(" ");
}

/** The thread context an assistant session gives each of its threads. */
export function workflowThreadContext(thread: { key: string }): string | undefined {
  return workflowEditorThreadContext(thread) ?? workflowRunThreadContext(thread);
}
