// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const confirmHeldSecret = vi.fn();
const releaseHeldSecret = vi.fn();
const sendPrompt = vi.fn();
let secrets: { name: string; reference: string; createdAt: number; held?: { provider?: string } }[] = [];
let useAvailable = true;

vi.mock("~/api/client", () => ({
  api: {
    confirmHeldSecret: (...a: unknown[]) => confirmHeldSecret(...a),
    releaseHeldSecret: (...a: unknown[]) => releaseHeldSecret(...a),
  },
}));
vi.mock("~/api/queries", () => ({ useSendPrompt: () => ({ mutateAsync: (...a: unknown[]) => sendPrompt(...a) }) }));
vi.mock("~/api/secrets", () => ({
  qkSecretsAll: () => ["settings", "secrets"],
  useSecrets: () => ({ data: { enabled: true, canWrite: true, useAvailable, provider: "Memory", secrets } }),
}));

import { HeldSecretCards, heldCandidates } from "./held-secret-card";

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const TEXT = "deploy with secret://personal/HETZNER_API_KEY please\n\n(Valet kept a key from this message as secret://personal/HETZNER_API_KEY.)";

beforeEach(() => {
  confirmHeldSecret.mockReset().mockResolvedValue({});
  releaseHeldSecret.mockReset();
  sendPrompt.mockReset().mockResolvedValue({});
  secrets = [{ name: "HETZNER_API_KEY", reference: "secret://personal/HETZNER_API_KEY", createdAt: 0, held: { provider: "hetzner" } }];
  useAvailable = true;
});

describe("heldCandidates", () => {
  it("finds personal and team references once each, and skips company ones", () => {
    expect(heldCandidates(`${TEXT} and secret://team/t_1/DB_URL, secret://company/X.`)).toEqual([
      { reference: "secret://personal/HETZNER_API_KEY", target: { scope: "personal" }, name: "HETZNER_API_KEY" },
      { reference: "secret://team/t_1/DB_URL", target: { scope: "team", teamId: "t_1" }, name: "DB_URL" },
    ]);
  });
});

describe("HeldSecretCards", () => {
  it("shows nothing for a reference that is not held", () => {
    secrets = [{ name: "HETZNER_API_KEY", reference: "secret://personal/HETZNER_API_KEY", createdAt: 0 }];
    wrap(<HeldSecretCards text={TEXT} sessionId="s1" threadId="t1" />);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("saves a held key use-only with the provider's host and tells the agent", async () => {
    wrap(<HeldSecretCards text={TEXT} sessionId="s1" threadId="t1" />);
    expect((screen.getByRole("textbox", { name: "Only for host" }) as HTMLInputElement).value).toBe("api.hetzner.cloud");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    expect(confirmHeldSecret).toHaveBeenCalledWith({
      scope: "personal",
      name: "HETZNER_API_KEY",
      use: { hosts: ["api.hetzner.cloud"], header: "authorization", format: "Bearer {secret}" },
    });
    expect(sendPrompt.mock.calls[0]![0]).toMatchObject({ threadId: "t1", text: expect.stringContaining("only to api.hetzner.cloud") });
  });

  it("sends the text back, marked as not a key, when the person says it is not a key", async () => {
    releaseHeldSecret.mockResolvedValue({ value: "valet/passkey-pilot-2" });
    wrap(<HeldSecretCards text={TEXT} sessionId="s1" threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "It's not a key" }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    expect(releaseHeldSecret).toHaveBeenCalledWith({ scope: "personal", name: "HETZNER_API_KEY" });
    expect(sendPrompt.mock.calls[0]![0]).toEqual({
      text: "secret://personal/HETZNER_API_KEY was not a key. The text was: valet/passkey-pilot-2",
      threadId: "t1",
      notSecrets: ["valet/passkey-pilot-2"],
    });
  });

  it("saves a plain secret when the deployment has no use service", async () => {
    useAvailable = false;
    wrap(<HeldSecretCards text={TEXT} sessionId="s1" threadId="t1" />);
    expect(screen.queryByRole("textbox", { name: "Only for host" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(confirmHeldSecret).toHaveBeenCalledWith({ scope: "personal", name: "HETZNER_API_KEY" }));
  });
});
