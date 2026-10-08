import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "~/api/client";
import { useMe } from "~/api/settings";
import { NotYou } from "~/components/auth/not-you";
import { Button, Input, Spinner } from "~/components/primitives";

/**
 * `/cli/device` — approve or deny a `valet login` from a terminal
 * (`docs/specs/2026-07-14-auth-v2-design.md`, "CLI device sign-in").
 *
 * The person types the code their terminal shows. The page never reads the
 * code from its URL, so a link someone else sends cannot approve their CLI
 * with one click. Allow gives that CLI a token for this account.
 */
export const Route = createFileRoute("/cli/device")({
  component: CliDevicePage,
});

export function CliDevicePage() {
  // Loads the account now, so a signed-out visitor goes to sign in before
  // typing the code, not after.
  useMe();
  const [draft, setDraft] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const info = useQuery({
    queryKey: ["cli-device", code],
    queryFn: () => api.cliDevice(code ?? ""),
    enabled: code !== null,
    retry: false,
  });
  const [deciding, setDeciding] = useState<"allow" | "deny" | null>(null);
  const [done, setDone] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function lookUp(event: FormEvent) {
    event.preventDefault();
    if (draft.trim()) setCode(draft.trim());
  }

  async function decide(accept: boolean) {
    if (!info.data) return;
    setDeciding(accept ? "allow" : "deny");
    setError(null);
    try {
      await api.decideCliDevice(info.data.user_code, accept);
      setDone(accept ? "allow" : "deny");
    } catch {
      setDeciding(null);
      setError("Valet could not record your choice. Run `valet login` again in your terminal.");
    }
  }

  const signingIn = info.error instanceof ApiError && info.error.status === 401;

  return (
    <div className="grid min-h-screen place-items-center bg-[--bg] px-6 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1 text-center">
          <span aria-hidden className="text-base leading-none text-moss">
            ◈
          </span>
          <h1 className="font-display text-2xl text-ink">Sign in to the Valet CLI</h1>
        </div>

        {done ? (
          <p className="text-center text-sm text-ink">
            {done === "allow"
              ? "Done. Your terminal finishes signing in within a few seconds. You can close this tab."
              : "Sign-in canceled. You can close this tab."}
          </p>
        ) : code === null || info.isError && !signingIn ? (
          <form className="space-y-4" onSubmit={lookUp}>
            <p className="text-sm text-ink">Enter the code that <code>valet login</code> shows in your terminal.</p>
            <Input
              aria-label="Code"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="BCDF-GHJK"
              className="text-center font-mono text-lg uppercase tracking-widest"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            {info.isError && (
              <p className="text-sm text-danger-600">
                No sign-in is waiting for this code. Check the code in your terminal, or run <code>valet login</code> again.
              </p>
            )}
            <Button type="submit" className="w-full" disabled={!draft.trim()}>
              Continue
            </Button>
          </form>
        ) : info.isPending || signingIn || !info.data ? (
          <div className="flex justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-ink">
              The Valet CLI on <strong>{info.data.device}</strong> wants to sign in as <strong>{info.data.account}</strong>.
            </p>

            <div className="rounded border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-ink dark:border-amber-700/60 dark:bg-amber-950/40">
              Allow this only if you, or your agent, just ran <code>valet login</code> and it shows <strong>{info.data.user_code}</strong>.
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted">If you allow it, the CLI can</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
                {info.data.access.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {info.data.limits.map((line) => (
                <p key={line} className="text-xs text-muted">{line}</p>
              ))}
            </div>

            {error && <p className="text-sm text-danger-600">{error}</p>}

            <div className="flex gap-3">
              <Button variant="secondary" className="flex-1" disabled={deciding !== null} onClick={() => void decide(false)}>
                {deciding === "deny" ? <Spinner /> : "Deny"}
              </Button>
              <Button className="flex-1" disabled={deciding !== null} onClick={() => void decide(true)}>
                {deciding === "allow" ? <Spinner /> : "Allow"}
              </Button>
            </div>
            <NotYou account={info.data.account} />
          </div>
        )}
      </div>
    </div>
  );
}
