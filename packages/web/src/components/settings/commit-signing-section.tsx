import { useState } from "react";
import { Turnkey } from "@turnkey/sdk-browser";
import type { CommitSigningKeySummary, GetCommitSigningResponse } from "@valet/api/wire";
import { Badge, Button, Spinner } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { errorText } from "~/lib/error-text";
import { formatDateOr } from "~/lib/format-when";
import { useCommitSigning, useEnrollCommitSigning } from "~/api/commit-signing";
import { useMe } from "~/api/settings";
import { SigningKeyModal } from "~/components/settings/signing-key-modal";

/**
 * Personal · Integrations · Commit signing (agent commit signing design).
 *
 * One passkey tap creates the user's Turnkey sub-organization and their
 * Valet signing key; the browser makes the passkey with
 * `@turnkey/sdk-browser` and posts the attestation. The person then adds the
 * key to GitHub themselves (`SigningKeyModal`). An enrollment from before
 * per-person keys shows "Set up again". There is no disconnect here yet:
 * the sub-organization is the issuance record, and removing it is a Turnkey
 * action the passkey owns.
 */
export function CommitSigningSection() {
  const signingQ = useCommitSigning();
  const meQ = useMe();
  const enroll = useEnrollCommitSigning();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);

  if (signingQ.isLoading) {
    return (
      <FieldRow label="Status">
        <Spinner size={14} />
      </FieldRow>
    );
  }
  if (signingQ.error || !signingQ.data) {
    return (
      <FieldRow label="Status">
        <p className="text-sm text-danger-500">Failed to load commit signing.</p>
      </FieldRow>
    );
  }
  const data = signingQ.data;

  if (!data.configured) {
    return (
      <FieldRow label="Status">
        <p className="text-sm text-muted">
          Commit signing is not configured for this deployment. An admin can set the VALET_TURNKEY_* variables.
        </p>
      </FieldRow>
    );
  }

  const onSetUp = async () => {
    const passkey = data.passkey;
    if (!passkey) return;
    setError(null);
    setCreating(true);
    try {
      const email = meQ.data?.email ?? "valet user";
      const attestation = await createPasskey(passkey, email);
      await enroll.mutateAsync(attestation);
    } catch (err) {
      setError(errorText(err, "Could not set up commit signing. Try again."));
    } finally {
      setCreating(false);
    }
  };

  if (!data.enrolled || data.needsReenroll) {
    return (
      <FieldRow
        label="Status"
        hint={
          data.needsReenroll
            ? "Your setup is from an older version. Set up again to get your own signing key. You then add it to GitHub yourself."
            : "Your passkey signs each commit an agent makes, through a key held in Turnkey. Your passkey is the root of that Turnkey organization."
        }
        {...(error ? { error } : {})}
      >
        <Button type="button" disabled={creating || enroll.isPending} onClick={() => void onSetUp()}>
          {creating || enroll.isPending ? "Setting up…" : data.needsReenroll ? "Set up again" : "Set up commit signing"}
        </Button>
      </FieldRow>
    );
  }

  return (
    <>
      <FieldRow label="Status">
        <div className="space-y-1.5 text-sm text-ink">
          <div className="flex items-center gap-2">
            <Badge variant="success" className="shrink-0 whitespace-nowrap">Ready</Badge>
            {data.enrolledAt && <span className="text-xs text-muted">Set up {formatDateOr(data.enrolledAt, "")}</span>}
          </div>
          <div className="text-xs text-muted">
            Turnkey organization <span className="break-all font-mono">{data.subOrgId}</span>
          </div>
          <div className="text-xs text-muted">
            {data.mode === "session" ? "Approved windows sign commits." : "Your passkey signs each commit."}
          </div>
        </div>
      </FieldRow>
      {data.signingKey && (
        <FieldRow label="Signing key" hint="Add this key to your GitHub account as a Signing Key. Valet cannot add it for you.">
          <div className="space-y-1.5 text-sm text-ink">
            <div className="break-all font-mono text-xs">{data.signingKey.fingerprint}</div>
            <Button type="button" size="sm" variant="secondary" onClick={() => setKeyOpen(true)}>
              Add to GitHub
            </Button>
          </div>
          <SigningKeyModal open={keyOpen} onOpenChange={setKeyOpen} publicKey={data.signingKey.publicKey} />
        </FieldRow>
      )}
      {data.keys.length > 0 && (
        <FieldRow label="Signing windows" hint="Windows close at their end time.">
          <ul className="space-y-2 text-sm text-ink">
            {data.keys.slice(0, 10).map((key) => (
              <SigningKeyRow key={key.fingerprint} item={key} />
            ))}
          </ul>
        </FieldRow>
      )}
    </>
  );
}

function SigningKeyRow({ item }: { item: CommitSigningKeySummary }) {
  const pr = item.prNumber === undefined ? "" : ` #${item.prNumber}`;
  return (
    <li className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 break-words">
          {item.repo}
          {pr} · {item.branch}
        </span>
        <Badge className="shrink-0 whitespace-nowrap">{item.status}</Badge>
      </div>
      <div className="text-xs text-muted">
        {item.fingerprint} · valid {formatDateOr(item.notBefore, "")} to {formatDateOr(item.notAfter, "")}
      </div>
    </li>
  );
}

/** The passkey ceremony, in the shape `POST /api/me/commit-signing/enroll` takes. */
async function createPasskey(
  config: NonNullable<GetCommitSigningResponse["passkey"]>,
  userName: string,
): Promise<{
  authenticatorName: string;
  challenge: string;
  attestation: { credentialId: string; clientDataJson: string; attestationObject: string; transports: string[] };
}> {
  const turnkey = new Turnkey({
    apiBaseUrl: config.apiBaseUrl,
    defaultOrganizationId: config.organizationId,
    ...(config.rpId ? { rpId: config.rpId } : {}),
  });
  const client = turnkey.passkeyClient(config.rpId ? { rpId: config.rpId } : undefined);
  const passkey = await client.createUserPasskey({
    publicKey: {
      rp: { name: "Valet commit signing" },
      user: { name: userName, displayName: userName },
    },
  });
  return {
    authenticatorName: "Valet passkey",
    challenge: passkey.encodedChallenge,
    attestation: {
      credentialId: passkey.attestation.credentialId,
      clientDataJson: passkey.attestation.clientDataJson,
      attestationObject: passkey.attestation.attestationObject,
      transports: passkey.attestation.transports,
    },
  };
}
