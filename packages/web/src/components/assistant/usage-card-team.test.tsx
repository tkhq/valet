// @vitest-environment jsdom
/**
 * The home usage ranking marks a team's own work with the team icon, the
 * way the Usage page does, so a team row does not read as a person.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "user_1" }, isLoading: false }) }));

const window = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, costUsd: 1, turns: 1, unpricedTurns: 0 };
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      me: { day: window, week: window, month: window },
      org: {
        windowDays: 30,
        members: [
          { ...window, userId: "team:team-x", name: "Platform", isTeam: true },
          { ...window, userId: "user_2", name: "Test Member" },
        ],
      },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

import { UsageCard } from "./usage-card";

describe("UsageCard org ranking", () => {
  it("marks a team row with the team icon and leaves a person's row plain", () => {
    render(<UsageCard />);
    const teamIcons = screen.getAllByRole("img", { name: "Team" });
    expect(teamIcons).toHaveLength(1);
    expect(teamIcons[0]!.parentElement?.textContent).toBe("Platform");
    expect(screen.getByText("Test Member").parentElement?.querySelector('[aria-label="Team"]')).toBeNull();
  });
});
