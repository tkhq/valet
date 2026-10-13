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
    "Before the first step, restate the plan in two or three lines: what starts it, what each step does, and where the result goes.",
    "If a gap would change the build, such as which event, channel, repo, or account to use, call ask_question once with the plan as `detail` and the likely answers as `options`.",
    "Otherwise, build it and list what you assumed.",
    "Use patch_workflow to build its steps incrementally so the person can review the canvas.",
    "Use propose_trigger or propose_schedule for automation so the person can review the saved configuration before enabling it.",
    "Do not run it or enable schedules or event subscriptions unless the person explicitly asks.",
    "In replies, call the workflow by its name. Do not show its wf_ id.",
    "The workflow tools enforce the current owner's permissions.",
  ].join(" ");
}

/** A run with no conversation origin reports on its own thread
 * (`workflowRunThreadKey`). A person may watch it from the run page, or
 * nobody may, so a question is allowed but a guess is stated instead when
 * it is safe. A run started from a conversation reports there, so its key
 * never matches. */
export function workflowRunThreadContext(thread: { key: string }): string | undefined {
  if (!/^(?:signal|slack-events:[^:]+):workflow:[A-Za-z0-9_-]+$/.test(thread.key)) return undefined;
  return "A person may not be watching this run. Call ask_question only when a guess could send, change, or delete something in the wrong place. Otherwise, state your assumptions in the result.";
}

/** The thread context an assistant session gives each of its threads. */
export function workflowThreadContext(thread: { key: string }): string | undefined {
  return workflowEditorThreadContext(thread) ?? workflowRunThreadContext(thread);
}
