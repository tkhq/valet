/** A run's thread key: `signal:workflow:{runId}`, or its channel's
 * `slack-events:{channel}:workflow:{runId}`, with `:{nodeId}[:{iteration}]`
 * appended for a step's own thread (`workflowStepThreadKey`). */
const RUN_THREAD_KEY = /^(?:signal:workflow:|slack-events:[^:]+:workflow:)([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+)(?::([1-9][0-9]*))?)?$/;

/** Run keys identify owned histories; an origin or editor thread is never a run key. */
export function workflowRunIdFromThreadKey(key: string): string | undefined {
  return RUN_THREAD_KEY.exec(key)?.[1];
}

/** The step a step's own thread belongs to, or undefined for any other key. */
export function workflowStepFromThreadKey(key: string): { runId: string; nodeId: string; iteration: number } | undefined {
  const match = RUN_THREAD_KEY.exec(key);
  if (!match?.[2]) return undefined;
  return { runId: match[1]!, nodeId: match[2], iteration: match[3] ? Number(match[3]) : 0 };
}

export function isWorkflowRunConversation(sessionId: string, key: string): boolean {
  return workflowRunIdFromThreadKey(key) !== undefined || /^wf:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+(?::[0-9]+)?$/.test(sessionId);
}
