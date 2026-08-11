// @vitest-environment jsdom
/**
 * OwnerPicker: renders nothing with no eligible team, filters out teams
 * the caller can see but isn't a member of (an org admin's `useTeams()`
 * includes those — the create routes 404 on them), and reports the
 * selected teamId on change.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

let teamsData: { teams: { id: string; callerRole: "admin" | "member" | null }[] } | undefined;

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData }),
}));

import { OwnerPicker } from "./owner-picker";

describe("OwnerPicker", () => {
  it("renders nothing when the caller has no eligible team", () => {
    teamsData = { teams: [{ id: "t1", callerRole: null }] };
    const { container } = render(
      <OwnerPicker id="owner" value="" onChange={vi.fn()} help="help text" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("offers only teams with a non-null callerRole", () => {
    teamsData = {
      teams: [
        { id: "t-member", callerRole: "member" },
        { id: "t-admin", callerRole: "admin" },
        { id: "t-not-mine", callerRole: null },
      ],
    };
    render(<OwnerPicker id="owner" value="" onChange={vi.fn()} help="help text" />);
    const select = screen.getByLabelText("Owner") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "t-member", "t-admin"]);
  });

  it("reports the selected teamId on change", () => {
    teamsData = { teams: [{ id: "t1", callerRole: "member" }] };
    const onChange = vi.fn();
    render(<OwnerPicker id="owner" value="" onChange={onChange} help="help text" />);
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "t1" } });
    expect(onChange).toHaveBeenCalledWith("t1");
  });
});
