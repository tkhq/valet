/**
 * Turnkey wiring shared by the passkey endpoint and the approval verifier.
 * Tests replace fields with `Object.assign` and restore them after.
 */
import { loadTurnkeyConfig, type TurnkeyDeploymentConfig } from "@valet/plugin-turnkey/config";
import { turnkeyOps, type TurnkeyOpsFactory } from "@valet/plugin-turnkey/turnkey-client";
import { forwardStamped, type ForwardStamped } from "./turnkey-forward.js";

export interface PresenceDeps {
  config: () => TurnkeyDeploymentConfig | null;
  turnkey: TurnkeyOpsFactory;
  forward: ForwardStamped;
  now: () => number;
}

export const presenceDeps: PresenceDeps = {
  config: () => loadTurnkeyConfig(process.env),
  turnkey: turnkeyOps,
  forward: forwardStamped,
  now: () => Date.now(),
};
