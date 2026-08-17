import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { authClient } from "~/lib/auth-client";
import { useAuthConfig } from "~/api/auth-config";
import { Button, Input, Label, Spinner } from "~/components/primitives";

/**
 * `/login` — public (auth-v2 design). Email/password, plus social/SSO
 * buttons filtered to what `GET /api/auth-config` reports connected
 * (`stub: true` deployments report empty `social`/`sso` and this page is
 * unreachable anyway — the guard in `api/client.ts` never fires).
 */
export const Route = createFileRoute("/login")({
  component: LoginPage,
});

const SOCIAL_LABEL: Record<"google" | "github", string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
};

export function LoginPage() {
  const navigate = useNavigate();
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
    navigate({ to: "/" });
  }

  const social = authConfigQ.data?.social ?? [];
  const sso = authConfigQ.data?.sso ?? null;
  const hasAlternatives = social.length > 0 || sso !== null;

  return (
    <div className="grid min-h-screen place-items-center bg-[--bg] px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-1 text-center">
          <span aria-hidden className="text-base leading-none text-moss">
            ◈
          </span>
          <h1 className="font-display text-2xl text-ink">Sign in</h1>
        </div>

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
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? (
              <>
                <Spinner size={14} /> Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>

        {hasAlternatives && (
          <div className="space-y-2 border-t border-line pt-6">
            {social.map((provider) => (
              <Button
                key={provider}
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() =>
                  authClient.signIn.social({
                    provider,
                    callbackURL: `${window.location.origin}/`,
                  })
                }
              >
                {SOCIAL_LABEL[provider]}
              </Button>
            ))}
            {sso && (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() =>
                  // Origin-absolute: a relative callbackURL resolves against
                  // BETTER_AUTH_URL (the api origin), which in dev is :8788,
                  // not the vite server the user is on.
                  authClient.signIn.sso({
                    providerId: "oidc",
                    callbackURL: `${window.location.origin}/`,
                  })
                }
              >
                Continue with {sso.name}
              </Button>
            )}
          </div>
        )}

        <p className="text-center text-sm text-muted">
          New here?{" "}
          <Link to="/signup" className="text-moss hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
