import { useState } from "react";
import { Turnkey } from "@turnkey/sdk-browser";
import type { CommitSigningKeySummary, GetCommitSigningResponse } from "@valet/api/wire";
import { Badge, Button, Spinner } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { errorText } from "~/lib/error-text";
import { formatDateOr } from "~/lib/format-when";
import { useCommitSigning, useEnrollCommitSigning } from "~/api/commit-signing";
import { useMe } from "~/api/settings";

/**
 * You · Connected accounts · Commit signing (agent commit signing design).
 *
 * One passkey tap creates the user's Turnkey sub-organization; the browser
 * makes the passkey with `@turnkey/sdk-browser` and posts the attestation.
 * After that the row lists the signing keys agents have been granted, newest
 * first. There is no disconnect here yet: the sub-organization is the
 * issuance record, and removing it is a Turnkey action the passkey owns.
 */
export function CommitSigningSection() {
  const signingQ = useCommitSigning();
  const meQ = useMe();
  const enroll = useEnrollCommitSigning();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (signingQ.isLoading) {
    return (
      <FieldRow label="Commit signing">
        <Spinner size={14} />
      </FieldRow>
    );
  }
  if (signingQ.error || !signingQ.data) {
    return (
      <FieldRow label="Commit signing">
        <p className="text-sm text-danger-500">Failed to load commit signing.</p>
      </FieldRow>
    );
  }
  const data = signingQ.data;

  if (!data.configured) {
    return (
      <FieldRow label="Commit signing">
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

  if (!data.enrolled) {
    return (
      <FieldRow
        label="Commit signing"
        hint="Agents sign commits with a key held in Turnkey after you approve each pull request. Your passkey is the root of that Turnkey organization."
        {...(error ? { error } : {})}
      >
        <Button type="button" disabled={creating || enroll.isPending} onClick={() => void onSetUp()}>
          {creating || enroll.isPending ? "Setting up…" : "Set up commit signing"}
        </Button>
      </FieldRow>
    );
  }

  return (
    <>
      <FieldRow label="Commit signing">
        <div className="space-y-1 text-sm text-ink">
          <div className="flex items-center gap-2">
            <Badge>Ready</Badge>
            <span className="text-xs text-muted">Turnkey organization {data.subOrgId}</span>
          </div>
          {data.enrolledAt && <div className="text-xs text-muted">Set up {formatDateOr(data.enrolledAt, "")}</div>}
        </div>
      </FieldRow>
      {data.keys.length > 0 && (
        <FieldRow label="Signing keys" hint="One key per approved pull request. Keys close at the end of their window.">
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
        <span>
          {item.repo}
          {pr} · {item.branch}
        </span>
        <Badge>{item.status}</Badge>
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
