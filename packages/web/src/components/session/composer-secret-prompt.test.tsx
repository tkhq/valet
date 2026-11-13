// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen, waitFor, act } from "@testing-library/react";
import { detectSecrets } from "@valet/shared";

const saveSecretValue = vi.fn();
vi.mock("~/api/secrets", () => ({ saveSecretValue: (...args: unknown[]) => saveSecretValue(...args) }));

import { ComposerSecretPrompt, ComposerSecretWarning, useSecretGuard } from "./composer-secret-prompt";

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
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
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
    expect(saveSecretValue).toHaveBeenCalledWith({ scope: "personal" }, "OPENAI_API_KEY", KEY);
  });
});
