import type { ApprovalModeWire, RiskLevelWire } from "@valet/api/wire";

export const MODE_LABELS: Record<ApprovalModeWire, string> = {
  allow: "Allow", require_approval: "Require approval", deny: "Deny",
};
export const RISK_LABELS: Record<RiskLevelWire, string> = {
  low: "Low", medium: "Medium", high: "High", critical: "Critical",
};
