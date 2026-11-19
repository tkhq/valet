/**
 * Seals a secret value in the browser for the deployment's secret store.
 * `POST /api/secrets/import/begin` returns an envelope whose `kind` names
 * the sealer; the sealed value goes to `import/finish`. Each provider's
 * sealer lives in its own file here; generic code calls only `sealSecret`.
 */
import type { SecretSealEnvelope } from "@valet/api/wire";
import { sealForTurnkey, TURNKEY_SEAL_KIND } from "./turnkey";

export interface SealedSecret {
  kind: string;
  [field: string]: unknown;
}

type Sealer = (envelope: SecretSealEnvelope, value: string) => Promise<SealedSecret>;

const SEALERS: Record<string, Sealer> = {
  [TURNKEY_SEAL_KIND]: sealForTurnkey,
};

/** The plaintext a sealer receives. For a use-only save the use service
 * reads JSON: the value plus the rules for using it, so the rules travel
 * inside the sealed value and nobody who stores it can change them. */
export function plaintextFor(envelope: SecretSealEnvelope, value: string): string {
  if (!envelope.use) return value;
  const { client, owner, rules } = envelope.use;
  return JSON.stringify({ v: 1, value, client, owner, rules });
}

export async function sealSecret(envelope: SecretSealEnvelope, value: string): Promise<SealedSecret> {
  const sealer = SEALERS[envelope.kind];
  if (!sealer) throw new Error("This page cannot seal values for this secret store. Reload the page, then save again.");
  return sealer(envelope, plaintextFor(envelope, value));
}
