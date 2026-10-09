// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { backgroundArgs, bashRenderer } from "./bash";

const started = "started sandbox process wk_1 (deadline 2026-10-10T09:00:00.000Z). You will receive a process.exited signal.";

describe("bashRenderer: background calls (fix wave 2, M7)", () => {
  it("shows the background badge, the reason, and the deadline", () => {
    render(
      <bashRenderer.Body
        toolName="bash"
        args={{ command: "lake build", background: true, deadline_hours: 48, reason: "full proof build" }}
        result={{ text: started }}
        status="completed"
      />,
    );
    expect(screen.getByText("background")).toBeTruthy();
    expect(screen.getByText("full proof build")).toBeTruthy();
    expect(screen.getByText("deadline 48h")).toBeTruthy();
  });

  it("summarizes a background call by its deadline, not an exit code", () => {
    const args = { command: "lake build", background: true, deadline_hours: 48, reason: "proof" };
    expect(bashRenderer.formatSummary?.(args, { text: started }, "completed", "bash")).toBe("background · 48h deadline");
  });

  it("renders a refused background start as a plain result (fix wave 4, N6)", () => {
    const args = { command: "lake build", background: true, deadline_hours: 48, reason: "full proof build" };
    const refused = "background work limit reached: 20 items. Cancel one with wakeup_cancel, then retry.";
    render(<bashRenderer.Body toolName="bash" args={args} result={{ text: refused }} status="completed" />);
    expect(screen.queryByText("background")).toBeNull();
    expect(screen.queryByText("deadline 48h")).toBeNull();
    expect(bashRenderer.formatSummary?.(args, { text: refused }, "completed", "bash")).toBeUndefined();
  });

  it("leaves a foreground call without the strip", () => {
    render(<bashRenderer.Body toolName="bash" args={{ command: "ls" }} result={{ text: "a\nb" }} status="completed" />);
    expect(screen.queryByText("background")).toBeNull();
    expect(backgroundArgs({ command: "ls", background: false })).toBeNull();
  });
});
