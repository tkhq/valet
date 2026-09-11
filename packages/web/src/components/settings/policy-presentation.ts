import type { ApprovalModeWire, RiskLevelWire } from "@valet/api/wire";

export const MODE_LABELS: Record<ApprovalModeWire, string> = {
  allow: "Allow", require_approval: "Require approval", deny: "Deny",
};
export const RISK_LABELS: Record<RiskLevelWire, string> = {
  low: "Low", medium: "Medium", high: "High", critical: "Critical",
};

export const POLICY_SELECT_CLASS = "h-9 w-full min-w-0 rounded border border-line bg-paper px-2 text-sm text-ink";
