// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionOutcomes } from "./SessionOutcomes";
const state = vi.hoisted(() => ({ data: { outcomes: [{ key: "completed", label: "Completed", definition: "Requested work delivered.", sessions: 4 }] }, isPending: false, isError: false, refetch: vi.fn() }));
const hook = vi.hoisted(() => vi.fn());
vi.mock("~/api/usage", () => ({ useSessionOutcomeUsage: (...args: unknown[]) => { hook(...args); return state; } }));
describe("Session outcomes", () => {
  it("shows scoped counts and the classification period", () => {
    render(<SessionOutcomes period={{ kind: "lookback", window: "7d" }} scope="team" teamId="team" />);
    expect(screen.getByText("Completed")).toBeTruthy(); expect(screen.getByText("4")).toBeTruthy();
    expect(hook).toHaveBeenCalledWith({ kind: "lookback", window: "7d" }, "team", "team");
  });
  it("shows an empty state", () => {
    state.data = { outcomes: [] };
    render(<SessionOutcomes period={{ kind: "lookback", window: "7d" }} scope="me" />);
    expect(screen.getByText("No classified sessions in this window.")).toBeTruthy();
  });
  it("provides retry on failure", () => {
    state.isError = true;
    render(<SessionOutcomes period={{ kind: "lookback", window: "7d" }} scope="me" />);
    expect(screen.getByRole("alert")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(state.refetch).toHaveBeenCalled();
  });
});
