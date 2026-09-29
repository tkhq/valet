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
  return `This conversation is the visual editor for workflow ${match[1]}. Read that workflow before answering questions or making changes. Apply requested changes with the workflow tools. The workflow tools enforce the current owner's permissions.`;
}
