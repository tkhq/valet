/** Labels for the problem reasons ingest, the webhook routes, and the
 * channel host record, and the stage each one happens in. An unknown reason
 * falls back to its raw string rather than hiding. Used by the Events Log. */
const REASON_LABEL: Record<string, string> = {
  slack_classifier_rejected: "Classification rejected",
  no_subscription_match: "No subscription",
  filter_excluded: "Filtered out",
  bad_signature: "Bad signature",
  foreign_workspace: "Wrong workspace",
  unknown_org: "Not connected",
  transport_unavailable: "Transport down",
  slack_retry: "Slow response",
  slack_interaction_unmatched: "Slack form did not start a workflow",
  unlinked_sender: "Unlinked sender",
  channel_reply_failed: "Reply not posted",
  duplicate: "Duplicate delivery",
  unsupported_kind: "Unsupported message",
  verify_failed: "Verification failed",
  malformed_callback: "Malformed callback",
  unauthorized: "Not authorized",
  edge_denied: "Agent message blocked",
  hop_budget: "Too many agent hops",
  pending_cap: "Too many waiting messages",
  child_cap: "Too many child sessions",
  org_ceiling: "Organization limit reached",
};

export function problemStage(reason: string): string {
  if (reason === "slack_classifier_rejected" || reason === "slack_interaction_unmatched") return "Classification";
  if (reason === "filter_excluded") return "Subscription filter";
  if (reason === "no_subscription_match") return "Subscription match";
  if (reason.startsWith("workflow_")) return "Workflow routing";
  if (["bad_signature", "foreign_workspace", "unknown_org", "slack_retry"].includes(reason)) return "Receipt and verification";
  return "Delivery and authorization";
}

/** A reason's label, or the raw reason when it has none, so nothing hides. */
export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}
