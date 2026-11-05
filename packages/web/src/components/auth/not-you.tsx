import { useState } from "react";
import { finishAuthChange } from "~/lib/auth-navigation";
import { authClient } from "~/lib/auth-client";
import { useComposerDraftStore } from "~/stores/composer-drafts";

/**
 * "Not you? Sign out" for the approval pages. Signing out returns to this
 * page through `/login?next=`, so the person approves as the right account.
 */
export function NotYou({ account }: { account: string }) {
  const [busy, setBusy] = useState(false);
  async function switchAccount() {
    setBusy(true);
    await authClient.signOut();
    useComposerDraftStore.getState().activateOwner("");
    finishAuthChange(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  return (
    <p className="text-center text-xs text-muted">
      Signed in as {account}.{" "}
      <button type="button" className="text-moss hover:underline disabled:opacity-50" disabled={busy} onClick={() => void switchAccount()}>
        Not you? Sign out
      </button>
    </p>
  );
}
