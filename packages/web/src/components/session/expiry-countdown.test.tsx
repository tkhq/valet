// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatDateTime } from "~/lib/format-when";
import { ExpiryCountdown } from "./expiry-countdown";

describe("ExpiryCountdown deadline and resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 12, 0));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([24, 72, 192])("includes the date for a deadline %i hours away", (hours) => {
    const expiresAt = Date.now() + hours * 3_600_000;
    const { container } = render(<ExpiryCountdown expiresAt={expiresAt} descriptionId="expiry" />);
    expect(container.querySelector("#expiry")?.textContent).toBe(`Expires at ${formatDateTime(expiresAt)}`);
  });

  it("uses only the time for a same-day deadline", () => {
    const expiresAt = Date.now() + 3_600_000;
    const { container } = render(<ExpiryCountdown expiresAt={expiresAt} descriptionId="expiry" />);
    expect(container.querySelector("#expiry")?.textContent).toBe(`Expires at ${new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  });

  it.each(["focus", "visibilitychange"])("refreshes immediately on %s after sleep", (event) => {
    const expiresAt = Date.now() + 180_000;
    render(<ExpiryCountdown expiresAt={expiresAt} />);
    expect(screen.getByRole("timer").textContent).toBe("Expires in 3 min");
    // Move wall time without running the scheduled timeout, as during sleep.
    vi.setSystemTime(expiresAt + 1000);
    if (event === "focus") fireEvent.focus(window);
    else {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      fireEvent(document, new Event("visibilitychange"));
      expect(screen.getByRole("timer").textContent).toBe("Expires in 3 min");
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      fireEvent(document, new Event("visibilitychange"));
    }
    expect(screen.getByRole("timer").textContent).toBe("Expired");
    act(() => vi.advanceTimersByTime(15_000));
    expect(screen.getByRole("timer").textContent).toBe("Expired");
  });
});
