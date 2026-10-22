// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ToolIntentUsage } from "@valet/api/wire";
import { IntentKeys } from "./IntentKeys";
const edits = vi.hoisted(() => ({ edit: vi.fn(), merge: vi.fn() }));
vi.mock("~/api/tagging", () => ({ useEditTagKey: () => ({ mutate: edits.edit }), useMergeTagKey: () => ({ mutate: edits.merge }) }));
const data: ToolIntentUsage = { canManage: false, consolidationDue: false, keys: [
  { key: "code_change", label: "Code changes", definition: "Modify software.", calls: 12, uniqueUsers: 3, errorRate: 0.25, status: "active", origin: "seed" },
  { key: "customer_support", label: "Customer support", definition: "Help a customer.", calls: 3, uniqueUsers: 1, errorRate: 0, status: "provisional", origin: "classifier" },
  { key: "other", label: "Other", definition: "No matching purpose.", calls: 0, uniqueUsers: 0, errorRate: 0, status: "active", origin: "seed" },
] };
describe("Intent keys", () => {
  it("shows the purpose chart, definitions, counts, and emerging drill-down", () => {
    const select = vi.fn();
    render(<IntentKeys data={data} selected="" onSelect={select} />);
    expect(screen.getByRole("group", { name: "Tool calls by intent key" })).toBeTruthy();
    expect(screen.getByText("25.0%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Emerging Emerging: 3 calls" }));
    expect(select).toHaveBeenCalledWith("__emerging");
    expect(screen.getByText("Emerging keys (1)")).toBeTruthy();
    expect(screen.queryByText("Manage key")).toBeNull();
  });
  it("has a distinct empty state and supports clearing the key filter", () => {
    const select = vi.fn();
    render(<IntentKeys data={{ ...data, keys: [] }} selected="code_change" onSelect={select} />);
    expect(screen.getByText("No tagged calls in this window. Queued calls appear after classification.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear key filter" }));
    expect(select).toHaveBeenCalledWith("");
  });
  it("shows consolidation and explicit admin edits and merges", () => {
    render(<IntentKeys data={{ ...data, canManage: true, consolidationDue: true }} selected="" onSelect={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Consolidation due");
    fireEvent.click(screen.getAllByText("Manage key")[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Save key" })[0]!);
    expect(edits.edit).toHaveBeenCalledWith({ key: "code_change", label: "Code changes", definition: "Modify software." });
    fireEvent.click(screen.getAllByRole("button", { name: "Merge key" })[0]!);
    expect(edits.merge).toHaveBeenCalledWith({ key: "code_change", into: "other" });
  });
});
