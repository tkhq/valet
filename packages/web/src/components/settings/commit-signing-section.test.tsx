// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { GetCommitSigningResponse } from "@valet/api/wire";

let signingData: GetCommitSigningResponse | undefined;
let signingLoading = false;
let signingError = false;
const enrollMutateAsync = vi.fn();
const createUserPasskey = vi.fn();

vi.mock("~/api/commit-signing", () => ({
  useCommitSigning: () => ({
    data: signingData,
    isLoading: signingLoading,
    error: signingError ? new Error("boom") : null,
  }),
  useEnrollCommitSigning: () => ({ mutateAsync: enrollMutateAsync, isPending: false }),
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { email: "dev@example.com" }, isLoading: false, error: null }),
}));

const checkCommitSigningGithub = vi.fn();
const finishCommitSigningKey = vi.fn();
const getCommitSigningKeyStep = vi.fn();
const stamp = vi.fn(async (body: string) => ({ stampHeaderName: "X-Stamp-WebAuthn", stampHeaderValue: `s:${body}` }));
vi.mock("~/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api/client")>()),
  api: {
    checkCommitSigningGithub: () => checkCommitSigningGithub(),
    finishCommitSigningKey: (b: unknown) => finishCommitSigningKey(b),
    getCommitSigningKeyStep: () => getCommitSigningKeyStep(),
  },
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));

vi.mock("@turnkey/sdk-browser", () => ({
  Turnkey: class {
    passkeyClient() {
      return { createUserPasskey };
    }
  },
  WebauthnStamper: class {
    stamp(body: string) {
      return stamp(body);
    }
  },
}));

import { CommitSigningSection } from "./commit-signing-section";

const configured: GetCommitSigningResponse = {
  configured: true,
  enrolled: false,
  passkey: { apiBaseUrl: "https://api.turnkey.com", organizationId: "parent-org" },
  keys: [],
};

beforeEach(() => {
  signingData = configured;
  signingLoading = false;
  signingError = false;
  enrollMutateAsync.mockReset();
  createUserPasskey.mockReset();
});

describe("CommitSigningSection", () => {
  it("names the deployment fix when signing is not configured", () => {
    signingData = { configured: false, enrolled: false, keys: [] };
    render(<CommitSigningSection />);
    expect(screen.getByText(/not configured for this deployment/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("creates a passkey and posts the attestation when set up is clicked", async () => {
    createUserPasskey.mockResolvedValue({
      encodedChallenge: "chal",
      attestation: {
        credentialId: "cred",
        clientDataJson: "{}",
        attestationObject: "ao",
        transports: ["AUTHENTICATOR_TRANSPORT_INTERNAL"],
      },
    });
    enrollMutateAsync.mockResolvedValue({ subOrgId: "sub", enrolledAt: 1 });
    render(<CommitSigningSection />);
    fireEvent.click(screen.getByRole("button", { name: "Set up commit signing" }));
    await waitFor(() => expect(enrollMutateAsync).toHaveBeenCalledTimes(1));
    expect(createUserPasskey).toHaveBeenCalledTimes(1);
    expect(enrollMutateAsync).toHaveBeenCalledWith({
      authenticatorName: "Valet passkey",
      challenge: "chal",
      attestation: {
        credentialId: "cred",
        clientDataJson: "{}",
        attestationObject: "ao",
        transports: ["AUTHENTICATOR_TRANSPORT_INTERNAL"],
      },
    });
  });

  it("shows the failure inline when the passkey ceremony is cancelled", async () => {
    createUserPasskey.mockRejectedValue(new Error("The operation was cancelled"));
    render(<CommitSigningSection />);
    fireEvent.click(screen.getByRole("button", { name: "Set up commit signing" }));
    await waitFor(() => expect(screen.getByText(/The operation was cancelled/)).toBeTruthy());
    expect(enrollMutateAsync).not.toHaveBeenCalled();
  });

  it("lists signing windows for a window-mode account", () => {
    signingData = {
      ...configured,
      enrolled: true,
      mode: "session",
      subOrgId: "sub-1",
      enrolledAt: Date.parse("2026-09-12T10:00:00Z"),
      keys: [
        {
          fingerprint: "SHA256:abc",
          repo: "tkhq/valet",
          branch: "valet/x",
          prNumber: 7,
          sessionId: "s1",
          notBefore: Date.parse("2026-09-12T10:00:00Z"),
          notAfter: Date.parse("2026-09-12T12:00:00Z"),
          status: "active",
        },
      ],
    };
    render(<CommitSigningSection />);
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText(/tkhq\/valet/)).toBeTruthy();
    expect(screen.getByText(/SHA256:abc/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up commit signing" })).toBeNull();
  });

  it("offers Set up again for an enrollment without a person key", () => {
    signingData = { ...configured, enrolled: true, needsReenroll: true, subOrgId: "old" };
    render(<CommitSigningSection />);
    expect(screen.getByRole("button", { name: "Set up again" })).toBeTruthy();
  });

  it("shows no windows list for a passkey-mode account", () => {
    signingData = {
      ...configured, enrolled: true, mode: "presence", subOrgId: "sub-1",
      signingKey: { publicKey: "ssh-ed25519 AAAAkey", fingerprint: "SHA256:person" },
      keys: [{ fingerprint: "SHA256:old", repo: "a/b", branch: "x", sessionId: "s", notBefore: 1, notAfter: 2, status: "closed" }],
    };
    render(<CommitSigningSection />);
    expect(screen.queryByText("Signing windows")).toBeNull();
  });

  it("shows the person's key and checks GitHub from the modal", async () => {
    signingData = {
      ...configured,
      enrolled: true,
      mode: "presence",
      subOrgId: "sub-1",
      signingKey: { publicKey: "ssh-ed25519 AAAAkey", fingerprint: "SHA256:person" },
    };
    checkCommitSigningGithub.mockResolvedValue({ connected: true, login: "octo", listed: false });
    render(<CommitSigningSection />);
    expect(screen.getByText("SHA256:person")).toBeTruthy();
    expect(screen.getByText("Your passkey signs each commit.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to GitHub" }));
    expect(screen.getByText("ssh-ed25519 AAAAkey")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check GitHub" }));
    await waitFor(() => expect(screen.getByText(/Not on github.com\/octo yet/)).toBeTruthy());
  });

  it("has the new passkey create the signing key right after setup", async () => {
    createUserPasskey.mockResolvedValue({
      encodedChallenge: "chal",
      attestation: { credentialId: "Y3JlZA", clientDataJson: "{}", attestationObject: "ao", transports: [] },
    });
    enrollMutateAsync.mockResolvedValue({ subOrgId: "sub", enrolledAt: 1, keyStep: { body: "create-key" } });
    finishCommitSigningKey.mockResolvedValue({ subOrgId: "sub", enrolledAt: 2 });
    render(<CommitSigningSection />);
    fireEvent.click(screen.getByRole("button", { name: "Set up commit signing" }));
    await waitFor(() => expect(finishCommitSigningKey).toHaveBeenCalledWith({ body: "create-key", stampHeaderName: "X-Stamp-WebAuthn", stampHeaderValue: "s:create-key" }));
  });

  it("offers Finish setup when the key step did not complete", async () => {
    signingData = { ...configured, enrolled: true, pendingKey: true, subOrgId: "sub" };
    getCommitSigningKeyStep.mockResolvedValue({ body: "retry-key" });
    finishCommitSigningKey.mockResolvedValue({ subOrgId: "sub", enrolledAt: 2 });
    render(<CommitSigningSection />);
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(finishCommitSigningKey).toHaveBeenCalledWith({ body: "retry-key", stampHeaderName: "X-Stamp-WebAuthn", stampHeaderValue: "s:retry-key" }));
  });
});
