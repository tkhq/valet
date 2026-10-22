// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExternalUsageResponse } from "@valet/api/wire";
import { ToolUsage } from "./ToolUsage";

const hook = vi.hoisted(() => vi.fn());
vi.mock("~/api/usage", () => ({ useExternalUsage: hook }));
const data: ExternalUsageResponse = {
  daily: [{ dayMs: 1792627200000, surface: "mcp", calls: 4 }, { dayMs: 1792627200000, surface: "hosted", calls: 2 }],
  tools: [{ name: "github.create_issue", surface: "mcp", calls: 4, errorRate: 0.25, uniqueUsers: 2 }],
  clients: [{ surface: "mcp", name: "Claude Code", version: "2.0", calls: 4 }], detailsVisible: true, hasMore: true,
  recent: [{ id: "one", surface: "mcp", name: "github.create_issue", clientName: "Claude Code", clientVersion: "2.0", userId: "u", userName: "Conner", outcome: "ok", intent: "Create an issue to track the login bug.", createdAt: Date.now() }],
};
beforeEach(() => { hook.mockReturnValue({ data, isPending: false, isError: false }); });
function show() { return render(<ToolUsage period={{ kind: "lookback", window: "7d" }} scope="me" />); }

describe("Tool usage", () => {
  it("shows chart, tools, clients, and readable intents", () => {
    show();
    expect(screen.getByRole("img", { name: "Daily tool calls by surface" })).toBeTruthy();
    expect(screen.getByText("6 calls")).toBeTruthy();
    expect(screen.getByText("25.0%")).toBeTruthy();
    expect(screen.getByText("Create an issue to track the login bug.")).toBeTruthy();
    expect(screen.getByText("Conner · Claude Code 2.0")).toBeTruthy();
  });
  it("shows loading and empty states", () => {
    hook.mockReturnValue({ isPending: true });
    const rendered = show();
    expect(screen.getByRole("status").textContent).toContain("Loading tool usage");
    hook.mockReturnValue({ data: { daily: [], tools: [], clients: [], detailsVisible: true, recent: [], hasMore: false }, isPending: false });
    rendered.rerender(<ToolUsage period={{ kind: "lookback", window: "7d" }} scope="me" />);
    expect(screen.getByText("No tool calls in this window.")).toBeTruthy();
    expect(screen.getByText("No tools or commands yet.")).toBeTruthy();
    expect(screen.getByText("No clients in this window.")).toBeTruthy();
    expect(screen.getByText("No recent intents in this window.")).toBeTruthy();
  });
  it("filters all views by surface and resets search pagination", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(hook).toHaveBeenLastCalledWith({ kind: "lookback", window: "7d" }, "me", undefined, "", 20, undefined);
    fireEvent.click(screen.getByRole("button", { name: "Hosted" }));
    expect(hook).toHaveBeenLastCalledWith({ kind: "lookback", window: "7d" }, "me", undefined, "", 0, "hosted");
    fireEvent.change(screen.getByRole("textbox", { name: "Search intents" }), { target: { value: "login" } });
    await waitFor(() => expect(hook).toHaveBeenLastCalledWith({ kind: "lookback", window: "7d" }, "me", undefined, "login", 0, "hosted"));
  });
  it("does not expose a feed to a team member without detail permission", () => {
    hook.mockReturnValue({ data: { ...data, detailsVisible: false, recent: [] }, isPending: false });
    show();
    expect(screen.queryByRole("textbox", { name: "Search intents" })).toBeNull();
    expect(screen.getByText("Only team admins can see individual intents.")).toBeTruthy();
  });
});
