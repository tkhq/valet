// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "~/api/api-error";

const saveSecretValue = vi.fn();
vi.mock("~/api/secrets", () => ({ saveSecretValue: (...args: unknown[]) => saveSecretValue(...args) }));

import { SecretRequestForm, requestedReference } from "./secret-request-form";

const personal = { scope: "personal" as const, name: "OPENAI_API_KEY", purpose: "Call OpenAI." };

describe("SecretRequestForm", () => {
  it("shows the name and where it is saved, saves the value, then answers with the reference only", async () => {
    saveSecretValue.mockResolvedValueOnce({});
    const onAnswered = vi.fn(async () => {});
    render(<SecretRequestForm request={personal} inset="" busy={false} onAnswered={onAnswered} onDecline={vi.fn()} />);
    expect(screen.getByText("OPENAI_API_KEY")).toBeTruthy();
    expect(screen.getByText("Your personal secrets")).toBeTruthy();
    const field = screen.getByLabelText("Value for OPENAI_API_KEY") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "sk-the-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith("secret://personal/OPENAI_API_KEY"));
    expect(saveSecretValue).toHaveBeenCalledWith({ scope: "personal" }, "OPENAI_API_KEY", "sk-the-value");
    expect(JSON.stringify(onAnswered.mock.calls)).not.toContain("sk-the-value");
  });

  it("answers with the reference when an earlier attempt already saved it", async () => {
    saveSecretValue.mockRejectedValueOnce(new ApiError(409, "exists"));
    const onAnswered = vi.fn(async () => {});
    render(<SecretRequestForm request={personal} inset="" busy={false} onAnswered={onAnswered} onDecline={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Value for OPENAI_API_KEY"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  it("names a team reference with its team id", () => {
    expect(requestedReference({ scope: "team", teamId: "t1", name: "DB", purpose: "" })).toBe("secret://team/t1/DB");
  });
});
