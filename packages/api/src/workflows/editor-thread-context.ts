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
    "Clarify missing inputs, then use patch_workflow to build its steps incrementally so the person can review the canvas.",
    "Use propose_trigger or propose_schedule for automation so the person can review the saved configuration before enabling it.",
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
