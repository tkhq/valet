// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { automationProposalRenderer } from "./automation-proposal";
import { matches } from "./types";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, search, children }: { to: string; params?: Record<string, string>; search?: Record<string, string>; children: ReactNode }) => {
    const path = Object.entries(params ?? {}).reduce((acc, [key, value]) => acc.replace(`$${key}`, value), to);
    const query = new URLSearchParams(search).toString();
    return <a href={query ? `${path}?${query}` : path}>{children}</a>;
  },
}));
describe("automation proposal renderer", () => {
  it("claims both normal and pinned proposal tools", () => {
    expect(matches(automationProposalRenderer, "call_tool", { tool_id: "events.propose_subscription" })).toBe(true);
    expect(matches(automationProposalRenderer, "workflows__propose_schedule", {})).toBe(true);
    expect(matches(automationProposalRenderer, "call_tool", { tool_id: "workflows.create_schedule" })).toBe(false);
  });
  it("renders review details with a locally constructed link, never a supplied URL", () => {
    const Body = automationProposalRenderer.Body;
    render(<Body args={{}} toolName="call_tool" status="completed" result={JSON.stringify({ proposal: { kind: "subscription", id: "proposal-1", reviewUrl: "https://evil.test", config: { eventKeys: ["slack.message"], filters: [{ field: "channel", value: "C123" }], target: { follow: true }, audience: "team" } } })} />);
    expect(screen.getByText("Also deliver later replies from the source thread")).toBeTruthy();
    expect(screen.getByText("Team members")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review listener" }).getAttribute("href")).toBe("/presence/rules/proposal-1");
  });
  it("links a schedule proposal to its routine page", () => {
    const Body = automationProposalRenderer.Body;
    render(<Body args={{}} toolName="call_tool" status="completed" result={JSON.stringify({ proposal: { kind: "schedule", id: "proposal-2", config: { cron: "0 9 * * *", timezone: "UTC", prompt: "Summarize" } } })} />);
    expect(screen.getByRole("link", { name: "Review routine" }).getAttribute("href")).toBe("/presence/routines?routine=proposal-2");
  });
});
