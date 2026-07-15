/**
 * better-auth React client (auth-v2 design). Same-origin — Vite proxies
 * `/api` to the server in dev (see `vite.config.ts`), and the built app is
 * served from the same origin in production — so no `baseURL` is set.
 */
import { createAuthClient } from "better-auth/react";
import { ssoClient } from "@better-auth/sso/client";

export const authClient = createAuthClient({ plugins: [ssoClient()] });

/**
 * `inviteCode` rides the `/sign-up/email` body but isn't a user-table
 * `additionalField` (see `packages/api/src/auth/provisioning.ts`'s
 * `readInviteCode` — it's read straight off `ctx.body` for the admission
 * check, then discarded), so `inferAdditionalFields` doesn't apply. The
 * generated `authClient.signUp.email` type only knows the base fields;
 * this thin wrapper calls the same endpoint through `$fetch` (whose `body`
 * is untyped `any` in better-auth's own client types) so the extra key can
 * ride along without an `as any` cast on our side.
 */
export interface SignUpEmailResult {
  token: string | null;
  user: { id: string; email: string; name: string; image?: string | null };
}

export interface SignUpEmailError {
  message?: string;
  status: number;
  statusText: string;
}

export type SignUpEmailResponse =
  | { data: SignUpEmailResult; error: null }
  | { data: null; error: SignUpEmailError };

export function signUpEmailWithInvite(input: {
  name: string;
  email: string;
  password: string;
  inviteCode?: string;
}): Promise<SignUpEmailResponse> {
  return authClient.$fetch<SignUpEmailResult>("/sign-up/email", {
    method: "POST",
    body: input,
  });
}
