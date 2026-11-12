import { useMemo, useState } from "react";
import { detectSecrets, maskSecret, replaceSecrets, type SecretCandidate } from "@valet/shared";
import { Button, Input, Spinner } from "~/components/primitives";
import { saveSecretValue, type SecretTarget } from "~/api/secrets";
import { ApiError } from "~/api/api-error";
import { errorText } from "~/lib/error-text";

/**
 * Keeps a pasted key out of a message. The composer runs every draft through
 * `detectSecrets`. With a secret store, the prompt offers to save a match
 * and send the reference instead, and the composer holds the send until the
 * user decides; "Keep as text" sends it anyway, and the api's backstop still
 * catches a known key format. Without a store, a warning says the key will
 * stay in the conversation, and nothing is held.
 */
/**
 * `save`: a secret store is set up and the user may write to it. The prompt
 * offers to save the key, and the composer holds the send until the user
 * decides. `warn`: no store, so there is nowhere to save it. The prompt says
 * the key will stay in the conversation, and the send is never held.
 */
export type SecretGuardMode = "save" | "warn";

export function useSecretGuard(text: string, mode: SecretGuardMode) {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const pending = useMemo(() => detectSecrets(text).filter((c) => !kept.has(c.value)), [text, kept]);
  return {
    mode,
    pending,
    /** True when the composer must not send yet. */
    holdsSend: mode === "save" && pending.length > 0,
    keep: (value: string) => setKept((prev) => new Set(prev).add(value)),
  };
}

/** The prompt for a deployment with no secret store: a warning, never a block. */
export function ComposerSecretWarning({ candidate, onDismiss }: { candidate: SecretCandidate; onDismiss: () => void }) {
  return (
    <div role="status" className="mx-3 mb-2 rounded border border-line bg-warning-wash px-3 py-2 text-xs text-ink">
      <p>
        This looks like a {candidate.label.toLowerCase()} (<span className="font-mono">{maskSecret(candidate.value)}</span>). If you send it,
        it stays in this conversation. Remove it unless you mean to share it. An admin can set up a secret store to keep keys out of threads.
      </p>
      <div className="mt-2 flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function referenceFor(target: SecretTarget, name: string): string {
  return target.scope === "team" && target.teamId ? `secret://team/${target.teamId}/${name}` : `secret://personal/${name}`;
}

export function ComposerSecretPrompt({
  candidate,
  text,
  target,
  onReplace,
  onKeep,
}: {
  candidate: SecretCandidate;
  text: string;
  target: SecretTarget;
  /** Called with the draft after the key is saved and replaced. */
  onReplace: (next: string) => void;
  onKeep: () => void;
}) {
  const [name, setName] = useState(candidate.suggestedName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where = target.scope === "team" ? "this team's secrets" : "your personal secrets";

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveSecretValue(target, trimmed, candidate.value);
    } catch (err) {
      const taken = err instanceof ApiError && err.status === 409;
      setError(taken ? `A secret named ${trimmed} already exists. Pick another name.` : errorText(err, "Could not save it. Try again."));
      setSaving(false);
      return;
    }
    onReplace(replaceSecrets(text, [{ candidate, with: referenceFor(target, trimmed) }]));
    setSaving(false);
  }

  return (
    <div role="alert" className="mx-3 mb-2 rounded border border-line bg-warning-wash px-3 py-2 text-xs text-ink">
      <p>
        This looks like a {candidate.label.toLowerCase()} (<span className="font-mono">{maskSecret(candidate.value)}</span>). Save it to {where} and
        send a reference instead? The agent can use the reference, and the key stays out of the thread.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Secret name"
          size="sm"
          className="w-56 font-mono"
          spellCheck={false}
          autoComplete="off"
          disabled={saving}
        />
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving || name.trim().length === 0}>
          {saving ? <Spinner size={14} /> : "Save as secret"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onKeep} disabled={saving}>
          Keep as text
        </Button>
      </div>
      {error && <p className="mt-1 text-danger-text">{error}</p>}
    </div>
  );
}
