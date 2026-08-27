// @vitest-environment jsdom
/**
 * Asserts that the UsageCard renders a link to /usage.
 * Kept separate from usage-card.test.ts which only tests the pure
 * `windowCostDisplay` function and requires no DOM rendering.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "user_1" }, isLoading: false }),
}));

const emptyWindow = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  turns: 0,
  unpricedTurns: 0,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      me: { day: emptyWindow, week: emptyWindow, month: emptyWindow },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("~/api/client", () => ({
  api: { getUsageSummary: vi.fn() },
}));

import { UsageCard } from "./usage-card";

describe("UsageCard", () => {
  it("renders a link to /usage", () => {
    render(<UsageCard />);
    const link = document.querySelector("a[href='/usage']");
    expect(link).toBeTruthy();
    expect(link!.textContent).toMatch(/View all usage/);
  });
});
