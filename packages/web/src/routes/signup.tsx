import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { signUpEmailWithInvite } from "~/lib/auth-client";
import { Button, Input, Label, Spinner } from "~/components/primitives";

interface SignupSearch {
  invite?: string;
}

/**
 * `/signup` — public (auth-v2 design). The invite code field only appears
 * (prefilled, readonly) when the visitor arrived via an invite link
 * (`?invite=…`) — signup with no code relies on `evaluateAdmission`'s
 * email-domain/first-user rules server-side, same as today.
 */
export const Route = createFileRoute("/signup")({
  validateSearch: (raw): SignupSearch => ({
    invite: typeof raw.invite === "string" ? raw.invite : undefined,
  }),
  component: SignupRoute,
});

function SignupRoute() {
  const { invite } = Route.useSearch();
  return <SignupPage invite={invite} />;
}

export function SignupPage({ invite }: { invite?: string }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signUpError } = await signUpEmailWithInvite({
      name,
      email,
      password,
      inviteCode: invite,
    });
    setSubmitting(false);
    if (signUpError) {
      setError(signUpError.message ?? "Couldn't create your account.");
      return;
    }
    navigate({ to: "/" });
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[--bg] px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-1 text-center">
          <span aria-hidden className="text-base leading-none text-moss">
            ◈
          </span>
          <h1 className="font-display text-2xl text-ink">Create your account</h1>
        </div>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="signup-name">Name</Label>
            <Input
              id="signup-name"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signup-email">Email</Label>
            <Input
              id="signup-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signup-password">Password</Label>
            <Input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {invite && (
            <div className="space-y-1.5">
              <Label htmlFor="signup-invite">Invite code</Label>
              <Input id="signup-invite" value={invite} readOnly />
            </div>
          )}
          {error && <p className="text-xs text-danger-500">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? <Spinner size={14} /> : "Create account"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted">
          Already have an account?{" "}
          <Link to="/login" className="text-moss hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
