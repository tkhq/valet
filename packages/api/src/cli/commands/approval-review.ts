import type { DecisionAction, DecisionGate } from "../../wire/types.js";

export function approvalReviewIncomplete(gate: DecisionGate): boolean {
  const approval = gate.approval;
  return approval !== undefined && (
    approval.toolId === undefined ||
    approval.toolId.trim() === "" ||
    approval.argsPreview === undefined ||
    approval.reviewIncomplete === true
  );
}

export function actionApproves(action: DecisionAction): boolean {
  return action.id === "approve" || action.approves === true;
}

export function approvalPreviewLines(gate: DecisionGate): string[] {
  const approval = gate.approval;
  if (!approval) return [];
  const lines = [
    `tool: ${approval.toolId ?? "unavailable"}`,
    `parameters: ${approval.argsPreview ?? "unavailable"}`,
  ];
  if (approvalReviewIncomplete(gate)) {
    lines.push("parameter review is incomplete; approval actions are unavailable");
  }
  return lines;
}
