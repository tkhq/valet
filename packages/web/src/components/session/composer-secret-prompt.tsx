import { useMemo, useState } from "react";
import { detectSecrets, maskSecret, replaceSecrets, type SecretCandidate } from "@valet/shared";
import { Button, Input, Spinner } from "~/components/primitives";
import { saveSecretValue, type SecretTarget } from "~/api/secrets";
import { ApiError } from "~/api/api-error";
import { errorText } from "~/lib/error-text";

/**
 * Keeps a pasted key out of a message. The composer runs every draft through
 * `detectSecrets`; while a match is unhandled, the prompt offers to save it
 * as a secret and send the reference instead, and the composer holds the
 * send. "Keep as text" lets the user send it anyway: the backstop on the api
 * still catches a known key format.
 */
export function useSecretGuard(text: string) {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const pending = useMemo(() => detectSecrets(text).filter((c) => !kept.has(c.value)), [text, kept]);
  return {
    pending,
    keep: (value: string) => setKept((prev) => new Set(prev).add(value)),
  };
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
