/**
 * The sealer for the Turnkey secret store. The api's `import/begin` returns
 * a one-time enclave target; the value is encrypted to it here, in the
 * browser, so the plaintext never reaches the Valet api. The crypto package
 * loads on first use and stays out of the main bundle.
 */
import type { SecretSealEnvelope } from "@valet/api/wire";
import type { SealedSecret } from "./index";

export const TURNKEY_SEAL_KIND = "turnkey-enclave-v1";

export async function sealForTurnkey(envelope: SecretSealEnvelope, value: string): Promise<SealedSecret> {
  const { ingressTargetBundle, organizationId } = envelope;
  if (typeof ingressTargetBundle !== "string" || typeof organizationId !== "string") {
    throw new Error("The secret store sent an incomplete import target. Reload the page and save again.");
  }
  const { encryptSecretToBundle } = await import("@turnkey/crypto");
  const { secretPayload, targetPublicKey } = await encryptSecretToBundle({ plaintext: value, ingressTargetBundle, organizationId });
  return { kind: TURNKEY_SEAL_KIND, secretPayload, targetPublicKey };
}
