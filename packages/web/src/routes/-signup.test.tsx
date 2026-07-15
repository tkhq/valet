// @vitest-environment jsdom
/**
 * `/signup` (auth-v2 design, Task 10): the invite code field is prefilled
 * and readonly from `?invite=` and hidden entirely when absent; submit
 * calls the `signUpEmailWithInvite` wrapper (see `~/lib/auth-client` —
 * `inviteCode` isn't in better-auth's generated `signUp.email` client
 * type, so the page goes through a typed wrapper instead); the api's
 * exact invite-rejection copy surfaces inline unmodified.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const navigate = vi.fn();
const signUpEmailWithInvite = vi.fn().mockResolvedValue({
  data: { token: null, user: { id: "u1", email: "ada@example.com", name: "Ada" } },
  error: null,
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/lib/auth-client", () => ({
  signUpEmailWithInvite: (...args: unknown[]) => signUpEmailWithInvite(...args),
}));

import { SignupPage } from "./signup";

describe("SignupPage", () => {
  beforeEach(() => {
    navigate.mockClear();
    signUpEmailWithInvite.mockClear();
  });

  it("hides the invite code field when no ?invite= param is present", () => {
    render(<SignupPage invite={undefined} />);
    expect(screen.queryByLabelText("Invite code")).toBeNull();
  });

  it("prefills a readonly invite code field from ?invite=", () => {
    render(<SignupPage invite="abc123" />);
    const inviteInput = screen.getByLabelText("Invite code") as HTMLInputElement;
    expect(inviteInput.value).toBe("abc123");
    expect(inviteInput.readOnly).toBe(true);
  });

  it("submits with inviteCode from ?invite= and navigates home on success", async () => {
    render(<SignupPage invite="abc123" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(signUpEmailWithInvite).toHaveBeenCalledWith({
        name: "Ada",
        email: "ada@example.com",
        password: "hunter22",
        inviteCode: "abc123",
      }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
  });

  it("submits with no inviteCode when no invite param is present", async () => {
    render(<SignupPage invite={undefined} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(signUpEmailWithInvite).toHaveBeenCalledWith({
        name: "Ada",
        email: "ada@example.com",
        password: "hunter22",
        inviteCode: undefined,
      }),
    );
  });

  it("shows the api's exact invite-rejection message inline and does not navigate", async () => {
    signUpEmailWithInvite.mockResolvedValueOnce({
      data: null,
      error: { message: "an invite is required to join this deployment" },
    });
    render(<SignupPage invite={undefined} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(screen.getByText("an invite is required to join this deployment")).toBeTruthy(),
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
