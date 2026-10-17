// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./appearance-settings";

describe("AppearanceSettings", () => {
  it("labels the identity Appears as and reports field edits", () => {
    const onChange = vi.fn();
    render(<AppearanceSettings value={{}} onChange={onChange} subscription />);
    expect(screen.getByRole("group", { name: "Appears as" })).toBeTruthy();
    expect(screen.queryByText(/presence/i)).toBeNull();
    expect(screen.queryByText(/subscription/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Release helper" } });
    expect(onChange).toHaveBeenCalledWith({ displayName: "Release helper" });
  });

  it("shows the validation error for an invalid avatar URL", () => {
    render(<AppearanceSettings value={{ avatarUrl: "http://example.com/a.png" }} onChange={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("HTTPS");
  });
});
