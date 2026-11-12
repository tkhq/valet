// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen, waitFor, act } from "@testing-library/react";
import { detectSecrets } from "@valet/shared";

const saveSecretValue = vi.fn();
vi.mock("~/api/secrets", () => ({ saveSecretValue: (...args: unknown[]) => saveSecretValue(...args) }));

import { ComposerSecretPrompt, useSecretGuard } from "./composer-secret-prompt";

const KEY = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";

describe("useSecretGuard", () => {
  it("holds a draft with a key until the user keeps it", () => {
    const { result } = renderHook(() => useSecretGuard(`run with ${KEY}`));
    expect(result.current.pending).toHaveLength(1);
    act(() => result.current.keep(KEY));
    expect(result.current.pending).toHaveLength(0);
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
