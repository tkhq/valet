import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "~/api/client";
import { Button, Spinner } from "~/components/primitives";

/**
 * `/cli/login` — approve or deny a `valet login` from a terminal
 * (`docs/specs/2026-07-14-auth-v2-design.md`, "CLI browser sign-in").
 *
 * The CLI opens this page with its loopback `redirect_uri`, a PKCE
 * `code_challenge`, a `state`, and the computer name. Allow sends the
 * browser back to the CLI with a one-time code, which the CLI exchanges for
 * a personal API key. The key never reaches this page.
 */
interface CliLoginSearch {
  redirect_uri?: string;
  code_challenge?: string;
  state?: string;
  device?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const Route = createFileRoute("/cli/login")({
  validateSearch: (raw): CliLoginSearch => ({
    redirect_uri: str(raw.redirect_uri),
    code_challenge: str(raw.code_challenge),
    state: str(raw.state),
    device: str(raw.device),
  }),
  component: CliLoginRoute,
});

function CliLoginRoute() {
  return <CliLoginPage search={Route.useSearch()} />;
}

export function CliLoginPage({ search }: { search: CliLoginSearch }) {
  const { redirect_uri: redirectUri, code_challenge: codeChallenge, state = "", device = "" } = search;
  const valid = Boolean(redirectUri && codeChallenge);
  const info = useQuery({
    queryKey: ["cli-login", redirectUri, codeChallenge, device],
    queryFn: () => api.cliLogin({ redirectUri: redirectUri ?? "", codeChallenge: codeChallenge ?? "", device }),
    enabled: valid,
    retry: false,
  });
  const [deciding, setDeciding] = useState<"allow" | "deny" | null>(null);
  const [done, setDone] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    if (!redirectUri || !codeChallenge) return;
    setDeciding(accept ? "allow" : "deny");
    setError(null);
    try {
      const { redirect } = await api.decideCliLogin({ redirect_uri: redirectUri, code_challenge: codeChallenge, state, device, accept });
      setDone(accept ? "allow" : "deny");
      window.location.assign(redirect);
    } catch {
      setDeciding(null);
      setError("Valet could not record your choice. Run `valet login` again in your terminal.");
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[--bg] px-6 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1 text-center">
          <span aria-hidden className="text-base leading-none text-moss">
            ◈
          </span>
          <h1 className="font-display text-2xl text-ink">Sign in to the Valet CLI</h1>
        </div>

        {valid && signingIn(info.error) ? (
          <div className="flex justify-center">
            <Spinner />
          </div>
        ) : !valid || info.isError ? (
          <p className="text-center text-sm text-muted">
            This sign-in link is not valid. Run <code>valet login</code> again in your terminal.
          </p>
        ) : info.isPending ? (
          <div className="flex justify-center">
            <Spinner />
          </div>
        ) : done ? (
          <p className="text-center text-sm text-ink">
            {done === "allow"
              ? "Sending the sign-in to your terminal. You can close this tab when the terminal says you are logged in."
              : "Sign-in canceled. You can close this tab."}
          </p>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-ink">
              The Valet CLI on <strong>{info.data.device}</strong> wants to sign in as <strong>{info.data.account}</strong>.
            </p>

            <div className="rounded border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-ink dark:border-amber-700/60 dark:bg-amber-950/40">
              Allow this only if you just ran <code>valet login</code>, or asked your agent to run it, on this computer.
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted">If you allow it, the CLI can</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
                {info.data.access.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
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
          </div>
        )}
      </div>
    </div>
  );
}

/** A 401 means the visitor is signed out. The API client is already sending them to sign in. */
function signingIn(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
