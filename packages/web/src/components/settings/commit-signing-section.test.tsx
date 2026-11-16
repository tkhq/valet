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

vi.mock("@turnkey/sdk-browser", () => ({
  Turnkey: class {
    passkeyClient() {
      return { createUserPasskey };
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

  it("lists the granted keys once enrolled", () => {
    signingData = {
      ...configured,
      enrolled: true,
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
});
