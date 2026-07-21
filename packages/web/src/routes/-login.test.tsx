// @vitest-environment jsdom
/**
 * `/login` (auth-v2 design, Task 10): email/password sign-in, social
 * buttons rendered only for what `GET /api/auth-config` reports, and the
 * SSO button labeled with the configured provider's name. Mocks
 * `~/lib/auth-client` and `~/api/auth-config` the way `-integrations.test.tsx`
 * mocks its api module — this suite cares that the page calls the right
 * better-auth client methods with the right args, not that better-auth
 * itself works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const navigate = vi.fn();
const signInEmail = vi.fn().mockResolvedValue({ data: { user: {} }, error: null });
const signInSocial = vi.fn();
const signInSso = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => signInEmail(...args),
      social: (...args: unknown[]) => signInSocial(...args),
      sso: (...args: unknown[]) => signInSso(...args),
    },
  },
}));

let authConfigData: { stub: boolean; social: ("google" | "github")[]; sso: { name: string } | null } = {
  stub: false,
  social: ["github"],
  sso: { name: "Keycloak" },
};

vi.mock("~/api/auth-config", () => ({
  useAuthConfig: () => ({ data: authConfigData, isLoading: false, error: null }),
}));

import { LoginPage } from "./login";

describe("LoginPage", () => {
  beforeEach(() => {
    navigate.mockClear();
    signInEmail.mockClear();
    signInSocial.mockClear();
    signInSso.mockClear();
    authConfigData = { stub: false, social: ["github"], sso: { name: "Keycloak" } };
  });

  it("renders email/password fields plus only the configured social + SSO buttons", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Keycloak" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
  });

  it("renders no alternatives block when auth-config has neither social nor sso", () => {
    authConfigData = { stub: false, social: [], sso: null };
    render(<LoginPage />);
    expect(screen.queryByText(/Continue with/)).toBeNull();
  });

  it("submits email/password via signIn.email and navigates home on success", async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(signInEmail).toHaveBeenCalledWith({ email: "a@b.com", password: "hunter2" }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
  });

  it("clicking a social button calls signIn.social with that provider", () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(signInSocial).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: `${window.location.origin}/`,
    });
  });

  it("clicking the SSO button calls signIn.sso with providerId oidc", () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Keycloak" }));
    expect(signInSso).toHaveBeenCalledWith({
      providerId: "oidc",
      callbackURL: `${window.location.origin}/`,
    });
  });

  it("shows better-auth's error message inline on failed sign-in and does not navigate", async () => {
    signInEmail.mockResolvedValueOnce({
      data: null,
      error: { message: "Invalid email or password" },
    });
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Invalid email or password")).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
  });
});
