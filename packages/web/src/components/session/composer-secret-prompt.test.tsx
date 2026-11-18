// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen, waitFor, act } from "@testing-library/react";
import { detectSecrets } from "@valet/shared";

const saveSecretValue = vi.fn();
vi.mock("~/api/secrets", () => ({ saveSecretValue: (...args: unknown[]) => saveSecretValue(...args) }));

import { ComposerSecretPrompt, ComposerSecretWarning, composerCandidates, useSecretGuard, withArticle } from "./composer-secret-prompt";

const KEY = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";

describe("useSecretGuard", () => {
  it("holds a draft with a key until the user keeps it", () => {
    const { result } = renderHook(() => useSecretGuard(`run with ${KEY}`, "save"));
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.holdsSend).toBe(true);
    act(() => result.current.keep(KEY));
    expect(result.current.pending).toHaveLength(0);
  });
});

describe("without a secret store", () => {
  it("warns about the key but never holds the send", () => {
    const { result } = renderHook(() => useSecretGuard(`run with ${KEY}`, "warn"));
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.holdsSend).toBe(false);
  });

  it("says the key stays in the conversation and offers no save", () => {
    const text = `run with ${KEY}`;
    const onDismiss = vi.fn();
    render(<ComposerSecretWarning candidate={detectSecrets(text)[0]!} onDismiss={onDismiss} />);
    expect(screen.getByText(/stays in this conversation/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save as secret" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "It's not a key" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("ComposerSecretPrompt", () => {
  it("saves the key under the suggested name and swaps it for the reference", async () => {
    saveSecretValue.mockResolvedValueOnce({});
    const text = `run with ${KEY} now`;
    const onReplace = vi.fn();
    render(<ComposerSecretPrompt candidate={detectSecrets(text)[0]!} text={text} target={{ scope: "personal" }} onReplace={onReplace} onKeep={vi.fn()} />);
    expect(screen.getByText(/sk-p…s9T0/)).toBeTruthy();
    expect(screen.queryByText(KEY)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save as secret" }));
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith("run with secret://personal/OPENAI_API_KEY now"));
    expect(saveSecretValue).toHaveBeenCalledWith({ scope: "personal" }, "OPENAI_API_KEY", KEY, {});
  });
});


// Random values made for this test, not real keys.
const HETZNER = "q7Rk2PzW9vLmX4cT8bNe1JyH6uFa3GdS0oViKtYw5ZlQrBnMxCe7Ts2PjUh9Wd4A";

describe("withArticle", () => {
  it("keeps the provider's case and picks the article", () => {
    expect(withArticle("Hetzner key")).toBe("a Hetzner key");
    expect(withArticle("OpenAI key")).toBe("an OpenAI key");
    expect(withArticle("key")).toBe("a key");
  });
});

describe("composerCandidates", () => {
  it("asks about a formatless key and names it after the provider", () => {
    const [c] = composerCandidates(`here's my hetzner api key ${HETZNER} can you deploy`);
    expect(c).toMatchObject({ value: HETZNER, label: "Hetzner key", suggestedName: "HETZNER_API_KEY" });
  });

  it("keeps the known-format name for a known key", () => {
    const key = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    expect(composerCandidates(`token ${key}`)[0]?.suggestedName).toBe("GITHUB_TOKEN");
  });

  it("does not ask about a commit SHA or a UUID", () => {
    expect(composerCandidates("revert 3f9c2b7e1a4d8f6c0b5e9a7d2c4f1e8b6a3d9c7e please")).toEqual([]);
    expect(composerCandidates("org 5d4c9a2e-7b1f-4e3a-9c8d-2f6b1a7e4c90")).toEqual([]);
  });

  it("asks about a password after a password word", () => {
    expect(composerCandidates("my password is Blue&72!")[0]).toMatchObject({ label: "password", suggestedName: "PASSWORD" });
  });
});

describe("ComposerSecretPrompt with a use service", () => {
  it("pre-fills the provider's host and header and saves the key use-only", async () => {
    saveSecretValue.mockReset().mockResolvedValueOnce({});
    const text = `here's my hetzner api key ${HETZNER} can you deploy`;
    const onReplace = vi.fn();
    const [candidate] = composerCandidates(text);
    render(<ComposerSecretPrompt candidate={candidate!} text={text} target={{ scope: "personal" }} onReplace={onReplace} onKeep={vi.fn()} useAvailable />);
    const host = screen.getByRole("textbox", { name: "Only for host" }) as HTMLInputElement;
    expect(host.value).toBe("api.hetzner.cloud");
    expect(screen.getByText(/sends it only to api\.hetzner\.cloud/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save as secret" }));
    await waitFor(() => expect(onReplace).toHaveBeenCalled());
    expect(saveSecretValue).toHaveBeenCalledWith({ scope: "personal" }, "HETZNER_API_KEY", HETZNER, {
      use: { hosts: ["api.hetzner.cloud"], header: "authorization", format: "Bearer {secret}" },
    });
  });

  it("saves a plain secret when the person clears the host", async () => {
    saveSecretValue.mockReset().mockResolvedValueOnce({});
    const text = `here's my hetzner api key ${HETZNER} can you deploy`;
    const [candidate] = composerCandidates(text);
    render(<ComposerSecretPrompt candidate={candidate!} text={text} target={{ scope: "personal" }} onReplace={vi.fn()} onKeep={vi.fn()} useAvailable />);
    fireEvent.change(screen.getByRole("textbox", { name: "Only for host" }), { target: { value: "" } });
    expect(screen.getByText(/Without a host, commands can read the value/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save as secret" }));
    await waitFor(() => expect(saveSecretValue).toHaveBeenCalledWith({ scope: "personal" }, "HETZNER_API_KEY", HETZNER, {}));
  });

  it("starts with an empty host for an unknown provider", () => {
    const text = `the new token is ${HETZNER}`;
    const [candidate] = composerCandidates(text);
    render(<ComposerSecretPrompt candidate={candidate!} text={text} target={{ scope: "personal" }} onReplace={vi.fn()} onKeep={vi.fn()} useAvailable />);
    expect((screen.getByRole("textbox", { name: "Only for host" }) as HTMLInputElement).value).toBe("");
  });
});
