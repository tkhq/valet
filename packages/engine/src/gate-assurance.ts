/**
 * Approval assurance on decision gates
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 *
 * `presence` is a proof of presence: an AuthZEN-shaped approval whose
 * `state` holds Turnkey-verified passkey activities (`PresenceProof`).
 *
 * A gate asks for a passkey tap with `context.assurance = "presence"`. The
 * engine then refuses any approving resolution that does not carry
 * `assurance: "presence"`. Only the host's passkey endpoint sets that, after
 * Turnkey has verified the passkey stamp. The check lives in the engine, so
 * every surface that resolves gates (web, channels, bulk answers, MCP, CLI)
 * meets it. Rejecting stays one click everywhere.
 */
import type { DecisionAction, DecisionResolution } from "./types.js";

/** `session`: a signed-in person clicked Approve. `presence`: a passkey tap a third party verified. */
export type ApprovalAssurance = "session" | "presence";

export const PRESENCE_REQUIRED_MESSAGE =
  "This approval needs your passkey. Open the thread in Valet and approve it with your passkey.";

export class PresenceRequiredError extends Error {
  constructor() {
    super(PRESENCE_REQUIRED_MESSAGE);
    this.name = "PresenceRequiredError";
  }
}

export function gateAssurance(gate: { context?: Record<string, unknown> }): ApprovalAssurance {
  return gate.context?.assurance === "presence" ? "presence" : "session";
}

/** True when the chosen action approves. Gates without explicit actions approve with `approve`. */
export function isApprovingAction(actions: DecisionAction[] | undefined, actionId: string | undefined): boolean {
  if (actionId === undefined) return false;
  if (actionId === "approve") return true;
  return actions?.some((a) => a.id === actionId && a.approves === true) ?? false;
}

/** The refusal message for a resolution a presence gate must not accept, or null. */
export function presenceRefusal(
  gate: { context?: Record<string, unknown>; actions?: DecisionAction[] },
  resolution: Pick<DecisionResolution, "actionId" | "assurance" | "approval">,
): string | null {
  if (gateAssurance(gate) !== "presence") return null;
  if (!isApprovingAction(gate.actions, resolution.actionId)) return null;
  if (resolution.assurance === "presence" && (resolution.approval?.state.activities.length ?? 0) > 0) return null;
  return PRESENCE_REQUIRED_MESSAGE;
}
