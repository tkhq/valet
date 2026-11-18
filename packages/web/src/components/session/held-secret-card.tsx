import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { secretUseDefaultFor } from "@valet/shared";
import type { SecretSummary } from "@valet/api/wire";
import { api } from "~/api/client";
import { useSendPrompt } from "~/api/queries";
import { qkSecretsAll, useSecrets, type SecretTarget } from "~/api/secrets";
import { Button, Spinner } from "~/components/primitives";
import { SecretUseFields, draftFromDefault, draftHost, draftIncomplete, ruleFromDraft, HEADER_CHOICES } from "~/components/settings/secret-use-fields";
import { errorText } from "~/lib/error-text";

/**
 * The card under a message whose key the api's backstop holds (secret intake,
 * `docs/specs/2026-11-17-secret-intake-design.md`). No command can read a held
 * key. The person saves it use-only for one host, or as a plain secret, or
 * says it is not a key. Each choice sends a short message so the agent learns
 * the outcome; "It's not a key" sends the text back, marked so the backstop
 * leaves it.
 */

const REFERENCE = /secret:\/\/(personal|team\/[A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9_])/g;

/** The personal and team references in a message, once each. */
export function heldCandidates(text: string): { reference: string; target: SecretTarget; name: string }[] {
  const out = new Map<string, { reference: string; target: SecretTarget; name: string }>();
  for (const m of text.matchAll(REFERENCE)) {
    const where = m[1]!;
    const target: SecretTarget = where === "personal" ? { scope: "personal" } : { scope: "team", teamId: where.slice("team/".length) };
    out.set(m[0], { reference: m[0], target, name: m[2]! });
  }
  return [...out.values()];
}

export function HeldSecretCards({ text, sessionId, threadId }: { text: string; sessionId: string; threadId?: string | null }) {
  const refs = heldCandidates(text);
  if (refs.length === 0) return null;
  return (
    <>
      {refs.map((r) => (
        <HeldSecretLookup key={r.reference} {...r} sessionId={sessionId} threadId={threadId ?? undefined} />
      ))}
    </>
  );
}

function HeldSecretLookup(props: { reference: string; target: SecretTarget; name: string; sessionId: string; threadId?: string }) {
  const q = useSecrets(props.target);
  const row = q.data?.secrets.find((s) => s.name === props.name);
  if (!q.data?.canWrite || !row?.held) return null;
  // Keyed by name, so the fields start from this row's provider.
  return <HeldSecretCard key={row.name} {...props} row={row} useAvailable={q.data.useAvailable} />;
}

function HeldSecretCard({
  reference,
  target,
  name,
  sessionId,
  threadId,
  row,
  useAvailable,
}: {
  reference: string;
  target: SecretTarget;
  name: string;
  sessionId: string;
  threadId?: string;
  row: SecretSummary;
  useAvailable: boolean;
}) {
  const qc = useQueryClient();
  const send = useSendPrompt(sessionId);
  const [draft, setDraft] = useState(() => draftFromDefault(secretUseDefaultFor(row.held?.provider)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = useAvailable ? draftHost(draft) : "";
  const scope = { scope: target.scope, ...(target.teamId ? { teamId: target.teamId } : {}), name };

  async function run(action: () => Promise<{ text: string; notSecrets?: string[] }>) {
    setBusy(true);
    setError(null);
    try {
      const followUp = await action();
      await qc.invalidateQueries({ queryKey: qkSecretsAll() });
      await send.mutateAsync({ text: followUp.text, ...(threadId ? { threadId } : {}), ...(followUp.notSecrets ? { notSecrets: followUp.notSecrets } : {}) });
    } catch (err) {
      setError(errorText(err, "Could not finish. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const use = useAvailable ? ruleFromDraft(draft) : undefined;
      await api.confirmHeldSecret({ ...scope, ...(use ? { use } : {}) });
      if (!use) return { text: `I saved ${reference} as a secret.` };
      const header = draft.choice === "custom" ? use.header : HEADER_CHOICES[draft.choice].label;
      return { text: `I saved ${reference} as use-only: Valet sends it only to ${use.hosts.join(", ")}, in the ${header} header. Use it with valet-secrets http.` };
    });

  const notKey = () =>
    run(async () => {
      const { value } = await api.releaseHeldSecret(scope);
      return { text: `${reference} was not a key. The text was: ${value}`, notSecrets: [value] };
    });

  return (
    <div role="group" aria-label={`Held key ${name}`} className="rounded border border-line bg-warning-wash px-3 py-2 text-xs text-ink">
      <p>
        Valet kept a key from this message as <span className="font-mono">{name}</span>. No command can read it until you choose where it can
        be used.
      </p>
      {useAvailable && (
        <div className="mt-2 flex flex-col gap-1">
          <SecretUseFields draft={draft} onChange={setDraft} disabled={busy} size="sm" />
          <p className="text-muted">
            {host
              ? `The agent never gets this key. Valet sends it only to ${host}. Check the host before you save.`
              : "Set a host to make this key use-only. Without a host, commands can read the value."}
          </p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy || (useAvailable && draftIncomplete(draft))}>
          {busy ? <Spinner size={14} /> : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void notKey()} disabled={busy}>
          It&apos;s not a key
        </Button>
      </div>
      {error && <p role="alert" className="mt-1 text-danger-text">{error}</p>}
    </div>
  );
}
