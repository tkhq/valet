import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Turnkey, WebauthnStamper } from "@turnkey/sdk-browser";
import { api, ApiError } from "~/api/client";
import { FRESH_SIGN_IN_REQUIRED, type CommitSigningHistoryEntry, type CommitSigningKeySummary, type GetCommitSigningResponse } from "@valet/api/wire";
import { Badge, Button, ConfirmDialog, Spinner } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { signOutAndReturn } from "~/lib/auth-navigation";
import { errorText } from "~/lib/error-text";
import { formatDateOr, formatDateTime } from "~/lib/format-when";
import { useCommitSigning, useEnrollCommitSigning, useFinishCommitSigningKey } from "~/api/commit-signing";
import { useMe } from "~/api/settings";
import { SigningKeyModal } from "~/components/settings/signing-key-modal";

/** The section's anchor on Integrations. Sign-in comes back to it after the fresh sign-in dialog. */
export const COMMIT_SIGNING_ANCHOR = "commit-signing";

/** True when the api refused setup because the sign-in is too old. */
function isFreshSignInRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && typeof err.payload === "object" && err.payload !== null &&
    "code" in err.payload && err.payload.code === FRESH_SIGN_IN_REQUIRED;
}

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
  const finish = useFinishCommitSigningKey();
  const [signInAgain, setSignInAgain] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const setupButton = useRef<HTMLButtonElement>(null);
  const returned = useRef(false);

  // After the fresh sign-in, `/login?next=` opens this page at the section's
  // anchor. The section renders after its data loads, so the browser's own
  // jump to the anchor misses it. Scroll here once, and focus the setup
  // button: the passkey prompt needs a click or key press from the person.
  const loaded = signingQ.data !== undefined;
  useEffect(() => {
    if (!loaded || returned.current || window.location.hash !== `#${COMMIT_SIGNING_ANCHOR}`) return;
    returned.current = true;
    document.getElementById(COMMIT_SIGNING_ANCHOR)?.scrollIntoView({ block: "start" });
    setupButton.current?.focus({ preventScroll: true });
  }, [loaded]);

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

  // Presence setup is two passkey prompts: create the passkey, then let it
  // create your signing key, so Valet's server never holds authority in your
  // Turnkey organization. If the second prompt fails, "Finish setup" retries it.
  const finishKey = async (body: string, credentialId?: string) => {
    const signed = await new WebauthnStamper({
      rpId: data.passkey?.rpId ?? window.location.hostname,
      userVerification: "required",
      ...(credentialId ? { allowCredentials: [{ id: base64UrlToBytes(credentialId), type: "public-key" as const }] } : {}),
    }).stamp(body);
    await finish.mutateAsync({ body, ...signed });
  };

  const onSignOut = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOutAndReturn(`${window.location.pathname}${window.location.search}#${COMMIT_SIGNING_ANCHOR}`);
    } catch (err) {
      setSignOutError(errorText(err, "Could not sign out. Try again."));
      setSigningOut(false);
    }
  };

  const onSetUp = async () => {
    const passkey = data.passkey;
    if (!passkey) return;
    setError(null);
    // The api refuses setup on an old sign-in. When the page knows the
    // sign-in age, offer sign-out at once instead of a refused request.
    if (data.freshSignInUntil !== undefined && Date.now() > data.freshSignInUntil) {
      setSignInAgain(true);
      return;
    }
    setCreating(true);
    try {
      const email = meQ.data?.email ?? "valet user";
      const attestation = await createPasskey(passkey, email);
      const resp = await enroll.mutateAsync(attestation);
      if (resp.keyStep) await finishKey(resp.keyStep.body, attestation.attestation.credentialId);
    } catch (err) {
      if (isFreshSignInRefusal(err)) setSignInAgain(true);
      else setError(errorText(err, "Could not set up commit signing. Try again."));
    } finally {
      setCreating(false);
    }
  };

  const onFinish = async () => {
    setError(null);
    setCreating(true);
    try {
      const step = await api.getCommitSigningKeyStep();
      await finishKey(step.body);
    } catch (err) {
      setError(errorText(err, "Could not create your signing key. Try again."));
    } finally {
      setCreating(false);
    }
  };

  if (data.pendingKey) {
    return (
      <FieldRow
        label="Status"
        hint="Your passkey has not created your signing key yet. Finish setup asks for your passkey once."
        {...(error ? { error } : {})}
      >
        <Button type="button" disabled={creating} onClick={() => void onFinish()}>
          {creating ? "Finishing…" : "Finish setup"}
        </Button>
      </FieldRow>
    );
  }

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
        <Button ref={setupButton} type="button" disabled={creating || enroll.isPending} onClick={() => void onSetUp()}>
          {creating || enroll.isPending ? "Setting up…" : data.needsReenroll ? "Set up again" : "Set up commit signing"}
        </Button>
        <ConfirmDialog
          open={signInAgain}
          onOpenChange={setSignInAgain}
          title="Sign in again to set up commit signing"
          description="Setup needs a sign-in from the last 15 minutes. This stops a stolen session from adding its own passkey."
          confirmLabel="Sign out and sign in again"
          pendingLabel="Signing out…"
          confirmVariant="primary"
          pending={signingOut}
          error={signOutError}
          onConfirm={() => void onSignOut()}
        >
          <p className="text-sm text-muted">After you sign in, Valet opens this page again, and you can set up commit signing.</p>
        </ConfirmDialog>
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
      {/* Passkey mode has no windows: the key never expires and every push
          asks for a tap. The list only exists for window (session) mode. */}
      {data.mode === "session" && data.keys.length > 0 && (
        <FieldRow label="Signing windows" hint="Windows close at their end time.">
          <ul className="space-y-2 text-sm text-ink">
            {data.keys.slice(0, 10).map((key) => (
              <SigningKeyRow key={key.fingerprint} item={key} />
            ))}
          </ul>
        </FieldRow>
      )}
      {data.history.length > 0 && (
        <FieldRow label="Signed commits" hint="Each row is one passkey approval. The activity id finds the signature in your Turnkey organization.">
          <ul className="space-y-3 text-sm text-ink">
            {data.history.map((entry) => (
              <SigningHistoryRow key={`${entry.sessionId}:${entry.commits[entry.commits.length - 1]?.new ?? ""}`} entry={entry} />
            ))}
          </ul>
        </FieldRow>
      )}
    </>
  );
}

function SigningHistoryRow({ entry }: { entry: CommitSigningHistoryEntry }) {
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="min-w-0 break-words">
          {entry.repo} · {entry.branch}
        </span>
        <span className="text-xs text-muted">{formatDateTime(entry.signedAt)}</span>
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: entry.sessionId }}
          search={{ thread: entry.threadId }}
          className="inline-flex min-h-11 items-center text-xs text-accent-600 underline sm:min-h-0"
        >
          approval
        </Link>
      </div>
      {entry.commits.map((commit, i) => (
        <div key={commit.new} className="text-xs text-muted">
          <a
            href={`https://github.com/${entry.repo}/commit/${commit.new}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-accent-600 underline"
          >
            {commit.new.slice(0, 7)}
          </a>{" "}
          · Turnkey activity <span className="break-all font-mono">{entry.activityIds[i] ?? "unknown"}</span>
        </div>
      ))}
    </li>
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

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
