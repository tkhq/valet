/**
 * Notices when the editor's assistant panel actually changed the open
 * workflow, and refetches it so the canvas can follow without a manual
 * reload.
 *
 * `workflows.patch_workflow` writes the definition directly (there is no
 * proposal step), but nothing pushes that write back to an open editor: WS
 * events are session-scoped, and the workflow REST query has no live
 * channel. What the client *does* see is the panel's own transcript. A
 * completed workflows tool call in that transcript is the cue to refetch.
 *
 * The action reaches the model by two routes — `call_tool`, and the pinned
 * `workflows__patch_workflow` direct tool — so the transcript carries two
 * call shapes. Both are read through the workflow renderer's parsers, so
 * this watch cannot follow one route and miss the other.
 *
 * Success is read off the RESULT, not the arguments. The api runs the patch
 * and the full linter before it writes anything, and a rejected call comes
 * back as `{ success: false, error }` whose text is not JSON — so only a
 * result that parses AND carries this workflow's id proves a write landed.
 * That single test also drops patches aimed at some other workflow.
 *
 * This hook only invalidates. Adopting the refetched definition is the
 * editor's decision, because the editor is the only component that knows
 * whether the user has an unsaved draft that adopting would discard, and
 * because it must react to the data ARRIVING — a counter bumped here would
 * fire while the refetch is still in flight and adopt the pre-patch
 * definition.
 */
import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qkWorkflows } from "~/api/workflows";
import {
  isWorkflowCallTool,
  workflowRefsFrom,
  workflowToolSuffix,
} from "~/components/session/tool-renderers/workflow";
import { useStreamStore, type StreamMessage } from "~/stores/stream";

/**
 * Workflows actions that rewrite a stored definition. `save_workflow`
 * replaces it wholesale; `patch_workflow` edits nodes and edges in place.
 * Reads (`get_workflow`, `list_workflows`) return an id too, so matching on
 * the id alone would fire on every lookup.
 */
const DEFINITION_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "patch_workflow",
  "save_workflow",
]);

/**
 * Call ids of the completed tool calls that wrote `workflowId`, oldest
 * first. Pure, so the "did this call change the workflow" rule is testable
 * without a store or a rendered tree.
 */
export function definitionWriteCallIds(
  messages: readonly StreamMessage[] | undefined,
  threadId: string | undefined,
  workflowId: string,
): string[] {
  if (!messages) return [];
  const ids: string[] = [];
  for (const message of messages) {
    // A panel thread is one conversation among several in the same session.
    // Without this the editor would refetch for a patch typed in another tab.
    if (threadId !== undefined && message.threadId !== threadId) continue;
    for (const part of message.parts) {
      if (part.kind !== "tool_call" || part.status !== "completed") continue;
      if (!isWorkflowCallTool(part.toolName, part.args)) continue;
      const suffix = workflowToolSuffix(part.args, part.toolName);
      if (suffix === undefined || !DEFINITION_WRITE_TOOLS.has(suffix)) continue;
      if (workflowRefsFrom(part.result).workflowId !== workflowId) continue;
      ids.push(part.callId);
    }
  }
  return ids;
}

/**
 * Watches one conversation for writes to one workflow and invalidates the
 * workflow's detail and version queries when it sees a new one.
 *
 * The writes already in the transcript when the watch starts are recorded
 * without a refetch: those edits are in the definition the editor loaded,
 * so refetching for them would be noise.
 */
export function useWorkflowPatchWatch(
  sessionId: string | undefined,
  threadId: string | undefined,
  workflowId: string,
): void {
  const qc = useQueryClient();
  const messages = useStreamStore((s) =>
    sessionId ? s.bySession[sessionId]?.messages : undefined,
  );

  const writeIds = useMemo(
    () => definitionWriteCallIds(messages, threadId, workflowId),
    [messages, threadId, workflowId],
  );
  // The joined ids ARE the dependency: a text delta re-runs the memo and
  // hands back an equal array with a new identity, which would restart the
  // effect on every frame of a streamed reply.
  const signature = writeIds.join("\n");

  const seenRef = useRef<{ key: string; ids: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    const key = `${sessionId ?? ""} ${threadId ?? ""} ${workflowId}`;
    const ids = signature === "" ? [] : signature.split("\n");
    const seen = seenRef.current;

    if (seen === null || seen.key !== key) {
      seenRef.current = { key, ids: new Set(ids) };
      return;
    }
    if (ids.every((id) => seen.ids.has(id))) return;

    seenRef.current = { key, ids: new Set(ids) };
    qc.invalidateQueries({ queryKey: qkWorkflows.detail(workflowId) });
    qc.invalidateQueries({ queryKey: qkWorkflows.versions(workflowId) });
  }, [signature, sessionId, threadId, workflowId, qc]);
}
