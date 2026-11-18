import { useState } from "react";
import type { PostCommitSigningGithubCheckResponse } from "@valet/api/wire";
import { api } from "~/api/client";
import { Button, Dialog, DialogContent, DialogFooter, Spinner } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

const GITHUB_NEW_KEY_URL = "https://github.com/settings/ssh/new";

/**
 * Guides the person to add their Valet signing key to GitHub themselves
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 * Valet never writes keys to GitHub. "Check GitHub" reads the account's
 * public list of signing keys.
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
          <li>
            Title: <span className="font-mono">Valet commit signing</span>. Key type: <strong>Signing Key</strong>, not Authentication Key.
          </li>
          <li className="space-y-1.5">
            <span>Paste this key:</span>
            <code className="block break-all rounded border border-line bg-paper p-2 font-mono text-xs text-ink">{publicKey}</code>
            <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy key"}
            </Button>
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
