import { useState } from "react";
import type { ResolveWorkflowApprovalRequest } from "@valet/api/wire";
import { useResolveApproval } from "~/api/workflows";

type ApprovalResponse = Pick<ResolveWorkflowApprovalRequest, "approved" | "scope">;

/** Shared submission state; each card owns its actions and confirmation copy. */
export function useApprovalResponse(runId: string, nodeId: string, iteration?: number) {
  const [note, setNote] = useState("");
  const [confirmation, setConfirmation] = useState<ApprovalResponse | null>(null);
  const [submitted, setSubmitted] = useState<ApprovalResponse | null>(null);
  const resolve = useResolveApproval(runId);

  function submit(response: ApprovalResponse) {
    setSubmitted(response);
    resolve.mutate({
      nodeId,
      body: { ...response, note: note.trim() || undefined, iteration },
    });
    setConfirmation(null);
  }

  function respond(response: ApprovalResponse, confirm: boolean) {
    if (confirm) setConfirmation(response);
    else submit(response);
  }

  return {
    note, setNote, confirmation, submitted, resolve, respond,
    confirm: () => { if (confirmation !== null) submit(confirmation); },
    onConfirmationOpenChange: (open: boolean) => { if (!open) setConfirmation(null); },
  };
}
