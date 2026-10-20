// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./appearance-settings";

afterEach(cleanup);

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

  it("says a tool call that names an identity wins", () => {
    render(<AppearanceSettings value={{}} onChange={() => {}} />);
    expect(screen.getByText(/A tool call that names an identity wins\.$/)).toBeTruthy();
    expect(screen.queryByText(/Explicit identity arguments/)).toBeNull();
  });

  it("shows the validation error for an invalid avatar URL", () => {
    render(<AppearanceSettings value={{ avatarUrl: "http://example.com/a.png" }} onChange={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("HTTPS");
  });
});
