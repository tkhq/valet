import { useMemo, useState } from "react";
import { findSecretCandidates, maskSecret, replaceSecrets, suggestSecretName, type SecretTokenCandidate } from "@valet/shared";
import { Button, Input, Spinner } from "~/components/primitives";
import { saveSecretValue, type SecretTarget } from "~/api/secrets";
import { ApiError } from "~/api/api-error";
import { errorText } from "~/lib/error-text";

/**
 * Keeps a pasted key out of a message (secret intake, stage 1:
 * `docs/specs/2026-11-17-secret-intake-design.md`). The composer runs every
 * draft through `findSecretCandidates`, which also finds keys with no known
 * format. With a secret store, the prompt offers to save a candidate and send
 * the reference instead, and the composer holds the send until the person
 * decides; "It's not a key" sends the text unchanged, and the api's backstop
 * still checks it. Without a store, a warning says the key will stay in the
 * conversation, and nothing is held.
 */

/**
 * `save`: a secret store is set up and the person may write to it. The prompt
 * offers to save the key, and the composer holds the send until they decide.
 * `warn`: no store, so there is nowhere to save it. The prompt says the key
 * will stay in the conversation, and the send is never held.
 */
export type SecretGuardMode = "save" | "warn";

/** Stage-1 score at which the composer asks. Lower scores are left to the api. */
export const COMPOSER_PROMPT_SCORE = 0.5;

/** A candidate as the prompt shows it. */
export interface ComposerSecretCandidate {
  start: number;
  end: number;
  value: string;
  /** For example "OpenAI key" or "Hetzner key"; "key" when the provider is unknown. */
  label: string;
  suggestedName: string;
}

function labelFor(c: SecretTokenCandidate): string {
  if (c.reason === "known" && c.provider) return c.provider;
  if (c.reason === "password") return "password";
  if (c.provider) return `${c.provider.charAt(0).toUpperCase()}${c.provider.slice(1)} key`;
  return "key";
}

/** "a Hetzner key", "an OpenAI key": the label keeps its case. */
export function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

/** The candidates the composer asks about, in message order. */
export function composerCandidates(text: string, opts: { credentialRequested?: boolean } = {}): ComposerSecretCandidate[] {
  return findSecretCandidates(text, opts)
    .filter((c) => c.score >= COMPOSER_PROMPT_SCORE)
    .map((c) => ({
      start: c.start,
      end: c.end,
      value: c.value,
      label: labelFor(c),
      suggestedName: c.reason === "password" ? suggestSecretName({ suggestedName: "PASSWORD" }) : suggestSecretName(c),
    }));
}

export function useSecretGuard(text: string, mode: SecretGuardMode, opts: { credentialRequested?: boolean } = {}) {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const credentialRequested = opts.credentialRequested === true;
  const pending = useMemo(
    () => composerCandidates(text, credentialRequested ? { credentialRequested } : {}).filter((c) => !kept.has(c.value)),
    [text, kept, credentialRequested],
  );
  return {
    mode,
    pending,
    /** True when the composer must not send yet. */
    holdsSend: mode === "save" && pending.length > 0,
    keep: (value: string) => setKept((prev) => new Set(prev).add(value)),
  };
}

/** The prompt for a deployment with no secret store: a warning, never a block. */
export function ComposerSecretWarning({ candidate, onDismiss }: { candidate: ComposerSecretCandidate; onDismiss: () => void }) {
  return (
    <div role="status" className="mx-3 mb-2 rounded border border-line bg-warning-wash px-3 py-2 text-xs text-ink">
      <p>
        This looks like {withArticle(candidate.label)} (<span className="font-mono">{maskSecret(candidate.value)}</span>). If you send it,
        it stays in this conversation. Remove it unless you mean to share it. An admin can set up a secret store to keep keys out of threads.
      </p>
      <div className="mt-2 flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          It&apos;s not a key
        </Button>
      </div>
    </div>
  );
}

function referenceFor(target: SecretTarget, name: string): string {
  return target.scope === "team" && target.teamId ? `secret://team/${target.teamId}/${name}` : `secret://personal/${name}`;
}

/** Matches the api's rule for a single-segment secret name. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function ComposerSecretPrompt({
  candidate,
  text,
  target,
  onReplace,
  onKeep,
  position,
}: {
  candidate: ComposerSecretCandidate;
  text: string;
  target: SecretTarget;
  /** Called with the draft after the key is saved and replaced. */
  onReplace: (next: string) => void;
  onKeep: () => void;
  /** "1 of 2" when the draft holds more than one candidate. */
  position?: { index: number; total: number };
}) {
  const [name, setName] = useState(candidate.suggestedName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where = target.scope === "team" ? "this team's secrets" : "your personal secrets";
  const trimmed = name.trim();
  const nameOk = NAME_PATTERN.test(trimmed);

  async function save() {
    if (!nameOk || saving) return;
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
        {position && position.total > 1 && <span className="mr-1 text-muted">{`${position.index + 1} of ${position.total}.`}</span>}
        This looks like {withArticle(candidate.label)} (<span className="font-mono">{maskSecret(candidate.value)}</span>). Save it to {where} and
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
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving || !nameOk}>
          {saving ? <Spinner size={14} /> : "Save as secret"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onKeep} disabled={saving}>
          It&apos;s not a key
        </Button>
      </div>
      {!nameOk && trimmed.length > 0 && <p className="mt-1 text-danger-text">Use letters, digits, dot, dash and underscore, starting with a letter or digit.</p>}
      {error && <p className="mt-1 text-danger-text">{error}</p>}
    </div>
  );
}
