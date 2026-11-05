import { finishAuthChange } from "~/lib/auth-navigation";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { authClient } from "~/lib/auth-client";
import { useAuthConfig } from "~/api/auth-config";
import { safeNextPath } from "~/lib/next-path";
import { Button, Input, Label, Spinner } from "~/components/primitives";

/**
 * `/login` — public (auth-v2 design). It shows only the sign-in methods
 * `GET /api/auth-config` reports on (`AUTH_METHODS`): the email/password form
 * when `password` is on, and one button per social or SSO provider. The
 * primary method comes first. With no method on, the page says so instead
 * of showing a form that cannot work. (`stub: true` deployments never reach
 * this page: the guard in `api/client.ts` never fires.)
 *
 * `?next=` (artifacts design): where to land after sign-in — set by the
 * central 401 redirect and by the shared-artifact page, so a teammate who
 * followed an `/a/{token}` link gets the document, not the dashboard.
 * Sanitized to a same-origin path at the search boundary (`safeNextPath`),
 * so the render body never sees an open-redirect value.
 */
interface LoginSearch {
  next?: string;
}

export const Route = createFileRoute("/login")({
  validateSearch: (raw): LoginSearch => ({
    next: safeNextPath(raw.next),
  }),
  component: LoginRoute,
});

function LoginRoute() {
  const { next } = Route.useSearch();
  return <LoginPage next={next} />;
}

const SOCIAL_LABEL: Record<"google" | "github", string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
};

export function LoginPage({ next }: { next?: string } = {}) {
  const authConfigQ = useAuthConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // A rejected sign-in changes nothing a screen reader re-reads: the fields
  // keep their values and the message appends below them. Move the caret to
  // the message so the next thing read is why the form did not submit. The
  // effect (not the handler) does the move, because the message mounts on
  // the render that follows `setError`.
  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await authClient.signIn.email({ email, password });
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message ?? "Couldn’t sign in. Check your email and password.");
      return;
    }
    finishAuthChange(safeNextPath(next) ?? "/");
  }

  const config = authConfigQ.data;
  const social = config?.social ?? [];
  const sso = config?.sso ?? null;
  const passwordOn = config?.password ?? false;
  const primary = config?.primary ?? null;
  const callbackURL = () => `${window.location.origin}${next ?? "/"}`;

  // One button per provider. The primary provider takes the primary style.
  const providerButtons = [
    ...(sso ? [{ id: "oidc" as const, label: `Continue with ${sso.name}`,
      // Origin-absolute: a relative callbackURL resolves against
      // BETTER_AUTH_URL (the api origin), which in dev is :8788,
      // not the vite server the user is on.
      onClick: () => authClient.signIn.sso({ providerId: "oidc", callbackURL: callbackURL() }) }] : []),
    ...social.map((provider) => ({ id: provider, label: SOCIAL_LABEL[provider],
      onClick: () => authClient.signIn.social({ provider, callbackURL: callbackURL() }) })),
  ].sort((a, b) => Number(b.id === primary) - Number(a.id === primary));

  const buttons = providerButtons.length > 0 && (
    <div className="space-y-2">
      {providerButtons.map((button) => (
        <Button key={button.id} type="button" variant={button.id === primary ? "primary" : "secondary"} className="w-full" onClick={button.onClick}>
          {button.label}
        </Button>
      ))}
    </div>
  );

  const form = passwordOn && (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="login-email">Email</Label>
        <Input
          id="login-email"
          type="email"
          autoComplete="email"
          // An address is not prose. Spell-check marks a correct address
          // as a mistake and gives the wrong hint after a failed sign-in.
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="login-password">Password</Label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-xs text-danger-500">
          {error}
        </p>
      )}
      {/* The label stays while the request is in flight. A lone spinner
          names the button "Loading", which tells nobody what is loading. */}
      <Button type="submit" className="w-full" variant={primary === "password" || providerButtons.length === 0 ? "primary" : "secondary"} disabled={submitting}>
        {submitting ? (
          <>
            <Spinner size={14} /> Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );

  // The primary method leads; the other kind follows under a rule.
  const passwordFirst = primary === "password" || providerButtons.length === 0;
  const [first, second] = passwordFirst ? [form, buttons] : [buttons, form];
  const nothingOn = config !== undefined && !passwordOn && providerButtons.length === 0;

  return (
    <div className="grid min-h-screen place-items-center bg-[--bg] px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-1 text-center">
          <span aria-hidden className="text-base leading-none text-moss">
            ◈
          </span>
          <h1 className="font-display text-2xl text-ink">Sign in</h1>
        </div>

        {authConfigQ.isLoading && (
          <div className="flex justify-center"><Spinner /></div>
        )}

        {nothingOn && (
          <p role="status" className="text-center text-sm text-muted">
            Sign-in is not set up for this Valet. Ask your administrator to turn on a sign-in method.
          </p>
        )}

        {first}
        {first && second && <div className="border-t border-line pt-6">{second}</div>}
        {!first && second}

        {passwordOn && (
          <p className="text-center text-sm text-muted">
            New here?{" "}
            <Link to="/signup" search={{ next }} className="text-moss hover:underline">
              Create an account
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
