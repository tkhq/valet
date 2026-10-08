import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "~/api/client";
import { NotYou } from "~/components/auth/not-you";
import { Button, Spinner } from "~/components/primitives";

/**
 * `/oauth/consent` — approve or deny an app that asks for MCP access to Valet
 * (`docs/specs/2026-10-07-mcp-agent-tools-design.md`, "Sign-in and consent").
 *
 * Every MCP authorization lands here: the server adds `prompt=consent` to
 * each authorize request. The app receives its authorization code only when
 * the person chooses Allow. The page names the account, the app, and where
 * the code goes, and warns when that is not this computer, because an app
 * name is chosen by the app and proves nothing.
 */
interface ConsentSearch {
  consent_code?: string;
}

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: (raw): ConsentSearch => ({
    consent_code: typeof raw.consent_code === "string" ? raw.consent_code : undefined,
  }),
  component: ConsentRoute,
});

function ConsentRoute() {
  const { consent_code: code } = Route.useSearch();
  return <ConsentPage code={code} />;
}

export function ConsentPage({ code }: { code: string | undefined }) {
  const info = useQuery({
    queryKey: ["oauth-consent", code],
    queryFn: () => api.oauthConsent(code ?? ""),
    enabled: Boolean(code),
    retry: false,
  });
  const [deciding, setDeciding] = useState<"allow" | "deny" | null>(null);
  const [done, setDone] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    if (!code) return;
    setDeciding(accept ? "allow" : "deny");
    setError(null);
    try {
      const { redirect } = await api.decideOAuthConsent(code, accept);
      setDone(accept ? "allow" : "deny");
      window.location.assign(redirect);
    } catch {
      setDeciding(null);
      setError("Valet could not record your choice. Start the connection again from your app.");
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[--bg] px-6 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1 text-center">
          <span aria-hidden className="text-base leading-none text-moss">
            ◈
          </span>
          <h1 className="font-display text-2xl text-ink">Connect an app to Valet</h1>
        </div>

        {code && info.error instanceof ApiError && info.error.status === 401 ? (
          <div className="flex justify-center">
            <Spinner />
          </div>
        ) : done ? (
          <p className="text-center text-sm text-ink">
            {done === "allow"
              ? "Returning you to the app. You can close this tab when the app says it is connected."
              : "Access denied. You can close this tab."}
          </p>
        ) : !code || info.isError ? (
          <p className="text-center text-sm text-muted">
            This approval request expired or does not exist. Start the connection again from your app.
          </p>
        ) : info.isPending ? (
          <div className="flex justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-ink">
              <strong>{info.data.client_name}</strong> wants to act as <strong>{info.data.account}</strong> in Valet.
            </p>

            {!info.data.redirect_is_local && (
              <div className="rounded border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-ink dark:border-amber-700/60 dark:bg-amber-950/40">
                Access goes to <strong>{info.data.redirect_origin}</strong>, not to this computer. Allow it only if you
                started this connection in that app.
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted">If you allow it, the app can</p>
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
            <p className="text-center text-xs text-muted">
              Code goes to {info.data.redirect_origin}. You can disconnect the app any time in Settings &gt; Agent access.
            </p>
            <NotYou account={info.data.account} />
          </div>
        )}
      </div>
    </div>
  );
}
