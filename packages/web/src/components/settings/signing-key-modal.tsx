import { useState } from "react";
import type { PostCommitSigningGithubCheckResponse } from "@valet/api/wire";
import { api } from "~/api/client";
import { Button, Checkbox, Dialog, DialogContent, DialogFooter, Spinner } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

const GITHUB_NEW_KEY_URL = "https://github.com/settings/ssh/new";

/**
 * Guides the person to add their Valet signing key to GitHub themselves
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 * Valet never writes keys to GitHub. GitHub's form defaults to
 * Authentication Key, so the key shows only after the person confirms the
 * Signing Key type. "Check GitHub" reads the account's public key lists and
 * names a key that was added with the wrong type.
 */
export function SigningKeyModal({
  open,
  onOpenChange,
  publicKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publicKey: string;
}) {
  const [typeConfirmed, setTypeConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<PostCommitSigningGithubCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
    } catch {
      setError("Could not copy. Select the key and copy it.");
    }
  }

  async function check() {
    setChecking(true);
    setError(null);
    try {
      setResult(await api.checkCommitSigningGithub());
    } catch (err) {
      setError(errorText(err, "Could not check GitHub. Try again."));
    } finally {
      setChecking(false);
    }
  }

  const status = !result
    ? null
    : !result.connected
      ? "Connect GitHub under Settings, Connected accounts, then check again."
      : result.listed
        ? `Found on github.com/${result.login}. Commits you approve show as Verified.`
        : result.listedAsAuthentication
          ? `The key is on github.com/${result.login} as an Authentication Key, so GitHub does not use it to verify commits. Delete it on GitHub. Then add it again with Key type: Signing Key, and check again.`
          : `Not on github.com/${result.login} yet. Add it as a Signing Key, then check again.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add your Valet signing key to GitHub" description="You add the key yourself. Valet cannot add keys to your GitHub account.">
        <ol className="list-decimal space-y-3 pl-5 text-sm text-ink">
          <li>
            Open GitHub, Settings, SSH and GPG keys, New SSH key.{" "}
            <a className="text-accent-600 underline" href={GITHUB_NEW_KEY_URL} target="_blank" rel="noreferrer">
              Open GitHub
            </a>
          </li>
          <li className="space-y-1.5">
            <span>
              Title: <span className="font-mono">Valet commit signing</span>. Change Key type to <strong>Signing Key</strong>. GitHub selects Authentication Key first, and an Authentication Key does not verify commits.
            </span>
            <label className="flex min-h-11 items-center gap-2 sm:min-h-0">
              <Checkbox checked={typeConfirmed} onCheckedChange={setTypeConfirmed} aria-label="I set Key type to Signing Key" />
              I set Key type to Signing Key
            </label>
          </li>
          <li className="space-y-1.5">
            <span>Paste this key:</span>
            {typeConfirmed ? (
              <>
                <code className="block break-all rounded border border-line bg-paper p-2 font-mono text-xs text-ink">{publicKey}</code>
                <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy key"}
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted">The key shows after you confirm the key type.</p>
            )}
          </li>
        </ol>
        {status && <p className="text-sm text-ink" aria-live="polite">{status}</p>}
        {error && <p role="alert" className="text-sm text-danger-text">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" onClick={() => void check()} disabled={checking}>
            {checking ? <Spinner size={14} /> : "Check GitHub"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
