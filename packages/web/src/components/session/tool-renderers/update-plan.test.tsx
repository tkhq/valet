// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { pickRenderer, ToolShell } from "./index";
import { updatePlanRenderer } from "./update-plan";

const args = {
  items: [
    { text: "Read the failing test", status: "done" },
    { text: "Fix the parser", status: "in_progress" },
    { text: "Run the suite", status: "pending" },
  ],
};
const result = { content: [{ type: "text", text: "Plan updated: 1 of 3 done. Now: Fix the parser" }], text: "Plan updated: 1 of 3 done. Now: Fix the parser" };

function renderCall(status: "completed" | "error", callArgs: unknown, error?: string) {
  const renderer = pickRenderer("update_plan", callArgs);
  render(
    <ToolShell toolName="update_plan" category={renderer.category} Icon={renderer.Icon} status={status}
      target={renderer.formatTarget(callArgs, "update_plan")} summary={renderer.formatSummary?.(callArgs, result, status, "update_plan")}>
      <renderer.Body args={callArgs} result={result} status={status} error={error} toolName="update_plan" />
    </ToolShell>,
  );
}

describe("update_plan renderer", () => {
  it("shows one line with progress and the checklist on expand, never JSON", () => {
    expect(pickRenderer("update_plan")).toBe(updatePlanRenderer);
    renderCall("completed", args);
    const header = screen.getByRole("button", { expanded: false });
    expect(header.textContent).toContain("Updated the plan");
    expect(header.textContent).toContain("1 of 3");
    fireEvent.click(header);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(args.items.map((item) => item.text));
    const body = document.getElementById(header.getAttribute("aria-controls") ?? "");
    expect(body?.textContent).toContain("Fix the parser");
    expect(body?.textContent).not.toContain("{");
  });

  it("shows the error text instead of a checklist when the call failed", () => {
    renderCall("error", { items: [] }, "Validation failed for tool \"update_plan\": items must have at least 1 item.");
    expect(screen.getByText(/Validation failed/)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
