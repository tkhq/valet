/** Run keys identify owned histories; an origin or editor thread is never a run key. */
export function workflowRunIdFromThreadKey(key: string): string | undefined {
  return /^(?:signal:workflow:|slack-events:[^:]+:workflow:)([A-Za-z0-9_-]+)$/.exec(key)?.[1];
}

export function isWorkflowRunConversation(sessionId: string, key: string): boolean {
  return workflowRunIdFromThreadKey(key) !== undefined || /^wf:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+(?::[0-9]+)?$/.test(sessionId);
}
