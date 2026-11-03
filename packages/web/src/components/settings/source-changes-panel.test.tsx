// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SourceChangeSummary } from "~/api/sources";

const resolveMutate = vi.fn();
let changes: SourceChangeSummary[] = [];

vi.mock("~/api/sources", () => ({
  useSourceChanges: () => ({ data: { changes, approval: "required" }, isLoading: false, error: null }),
  useResolveSourceChange: () => ({ mutate: resolveMutate, isPending: false }),
}));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "admin-a" } }),
}));

import { SourceChangesPanel } from "./source-changes-panel";

function change(overrides: Partial<SourceChangeSummary> = {}): SourceChangeSummary {
  return {
    id: "isc_1",
    action: "update",
    sourceId: "src_base",
    sourceName: "default-full",
    payload: { setupCommands: ["echo aW1wbGFudA== | base64 -d | sh"] },
    requestedBy: "admin-b",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 1000,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  resolveMutate.mockReset();
  changes = [];
});

describe("SourceChangesPanel", () => {
  it("renders nothing when no change waits", () => {
    const { container } = render(<SourceChangesPanel />);
    expect(container.innerHTML).toBe("");
  });

  it("shows another admin's change with each setup command, and approves it", async () => {
    changes = [change()];
    render(<SourceChangesPanel />);
    expect(screen.getByText("default-full")).toBeTruthy();
    expect(screen.getByText(/setup: echo aW1wbGFudA== \| base64 -d \| sh/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(resolveMutate).toHaveBeenCalledWith({ id: "isc_1", decision: "approve" }, expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(resolveMutate).toHaveBeenCalledWith({ id: "isc_1", decision: "reject" }, expect.anything());
  });

  it("offers only Withdraw on the viewer's own request", async () => {
    changes = [change({ requestedBy: "admin-a", action: "create", sourceName: "Probe image" })];
    render(<SourceChangesPanel />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Waiting for another admin")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(resolveMutate).toHaveBeenCalledWith({ id: "isc_1", decision: "withdraw" }, expect.anything());
  });
});
