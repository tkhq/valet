// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WireQueueState } from "@valet/api/wire";
import { TypingLine } from "./viewer-faces";
import { ProcessingStatus } from "./processing-status";

afterEach(cleanup);
const base: WireQueueState = { mode: "followup", status: "idle", pendingIds: [], collectingIds: [] };

describe("ProcessingStatus", () => {
  it.each([
    [{ ...base, status: "queued" }, "Valet is queued"],
    [{ ...base, pendingIds: ["external"] }, "Valet is queued"],
    [{ ...base, collectingIds: ["external"] }, "Valet is queued"],
    [{ ...base, status: "blocked_on_decision_gate" }, "Valet is waiting for a response"],
    [{ ...base, status: "paused" }, "Valet is paused"],
    [{ ...base, status: "paused", activeItemId: "running" }, "Valet is working…"],
  ] satisfies [WireQueueState, string][])("renders durable state %j", (queue, label) => {
    render(<ProcessingStatus status="idle" queue={queue} />);
    expect(screen.getByRole("status").textContent).toBe(label);
  });

  it("keeps one live region through thinking, tools, response, and completion", () => {
    const { rerender } = render(<ProcessingStatus status="thinking" />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Valet is thinking…");
    rerender(<ProcessingStatus status="tool_calling" />);
    expect(region.textContent).toBe("Valet is working…");
    rerender(<ProcessingStatus status="streaming" />);
    expect(region.textContent).toBe("Valet is working…");
    rerender(<ProcessingStatus status="idle" />);
    expect(region.textContent).toBe("");
    expect(screen.getAllByRole("status")).toEqual([region]);
  });

  it("gives a pending response priority over active work and queued followups", () => {
    render(<ProcessingStatus status="thinking" needsResponse queue={{ ...base, status: "running", pendingIds: ["next"] }} />);
    expect(screen.getByRole("status").textContent).toBe("Valet is waiting for a response");
    expect(screen.getByRole("status").querySelector(".animate-pulse")).toBeNull();
  });

  it("keeps human typing separate from Valet processing", () => {
    render(<><TypingLine viewers={[]} /><ProcessingStatus status="thinking" /></>);
    expect(screen.getByTestId("typing-line").textContent).toBe("");
    expect(screen.getByRole("status").textContent).toBe("Valet is thinking…");
  });

  it("shows current tool work before queued followups", () => {
    render(<ProcessingStatus status="tool_calling" queue={{ ...base, status: "queued", pendingIds: ["next"] }} />);
    expect(screen.getByRole("status").textContent).toBe("Valet is working…");
  });

  it("does not treat a stale active item on an idle queue as running", () => {
    render(<ProcessingStatus status="idle" queue={{ ...base, activeItemId: "settled" }} />);
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
