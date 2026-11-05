// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WireQueueState } from "@valet/api/wire";
import { TypingLine } from "./viewer-faces";
import { formatElapsed, ProcessingStatus, retryLabel } from "./processing-status";
import { useCompactingForThread, useStreamStore } from "~/stores/stream";

afterEach(cleanup);
const base: WireQueueState = { mode: "followup", status: "idle", pendingIds: [], collectingIds: [] };

describe("ProcessingStatus", () => {
  it("says Valet is compacting context in place of thinking, with the pulse and the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    render(<ProcessingStatus status="thinking" startedAt={4_000} compacting />);
    expect(screen.getByRole("status").textContent).toBe("Valet is compacting context…");
    expect(document.querySelector("img")?.className).toContain("animate-pulse");
    expect(screen.getByText("6s")).toBeTruthy();
    vi.useRealTimers();
  });

  it("shows compaction between turns, and keeps a pending response first", () => {
    const { rerender } = render(<ProcessingStatus status="idle" compacting />);
    expect(screen.getByRole("status").textContent).toBe("Valet is compacting context…");
    rerender(<ProcessingStatus status="idle" compacting needsResponse />);
    expect(screen.getByRole("status").textContent).toBe("Valet is waiting for a response");
  });

  it("clears the compacting line on compaction_end", () => {
    function Line() {
      return <ProcessingStatus status="idle" compacting={useCompactingForThread("s1", "t1")} />;
    }
    render(<Line />);
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => useStreamStore.getState().ingest("s1", { seq: 1, ts: 1, type: "compaction_start", threadId: "t1" }));
    expect(screen.getByRole("status").textContent).toBe("Valet is compacting context…");
    act(() => useStreamStore.getState().ingest("s1", { seq: 2, ts: 2, type: "compaction_end", threadId: "t1" }));
    expect(screen.getByRole("status").textContent).toBe("");
  });

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

describe("ProcessingStatus activity", () => {
  it("names the running step and the turn's elapsed time, and announces only the step", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      render(<ProcessingStatus status="tool_calling" activity="Merge-test the branch" startedAt={75_000} />);
      expect(screen.getByRole("status").textContent).toBe("Merge-test the branch");
      expect(screen.getByText("25s").getAttribute("aria-hidden")).toBe("true");
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(screen.getByText("30s")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats elapsed time compactly", () => {
    expect(formatElapsed(9_400)).toBe("9s");
    expect(formatElapsed(185_000)).toBe("3m 5s");
    expect(formatElapsed(3_720_000)).toBe("1h 2m");
  });
});

describe("retryLabel", () => {
  const retry = { threadId: "t", action: "retry" as const, provider: "openai", reason: "server_error" as const, attempt: 2, maxAttempts: 4, waitMs: 4_000, at: 10_000 };

  it("counts down to the retry and names the attempt, as Claude Code does", () => {
    expect(retryLabel(retry, 10_500)).toBe("OpenAI had a server error. Retrying in 4s · attempt 2/4");
    expect(retryLabel(retry, 14_500)).toBe("OpenAI had a server error. Retrying · attempt 2/4");
  });

  it("names the provider the turn moved to", () => {
    expect(retryLabel({ threadId: "t", action: "fallback", provider: "anthropic", reason: "overloaded", toProvider: "openai", at: 0 }, 0))
      .toBe("Anthropic is overloaded. Continuing with OpenAI…");
  });

  it("replaces the working label while the turn waits on a retry", () => {
    render(<ProcessingStatus status="idle" queue={{ ...base, status: "running", activeItemId: "q" }} retry={{ ...retry, at: Date.now() }} />);
    expect(screen.getByRole("status").textContent).toMatch(/^OpenAI had a server error\. Retrying/);
  });
});
