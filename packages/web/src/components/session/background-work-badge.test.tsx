// @vitest-environment jsdom
/**
 * Background work badge (fix wave 2, H8): "N background · next deadline
 * in …" in the session header, a list of the work, and a Cancel per row
 * behind a confirm step that names the reason.
 */
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListSessionWakeupsResponse } from "@valet/api/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "~/api/client";
import { BackgroundWorkBadge, backgroundItems, badgeLabel, itemDetail, timeSince, timeUntil } from "./background-work-badge";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

function listing(now: number): ListSessionWakeupsResponse {
  return {
    wakeups: [
      { id: "wk_1", threadId: "th-1", kind: "process", status: "running", reason: "full proof build", deadlineAt: now + 30 * HOUR, createdAt: now - HOUR },
      { id: "wk_2", threadId: "th-1", kind: "timer", status: "pending", reason: "check CI", fireAt: now + 2 * HOUR, createdAt: now },
    ],
    leases: [
      { id: "ls_1", threadId: "th-1", ownerKind: "process", ownerId: "wk_1", reason: "full proof build", deadlineAt: now + 30 * HOUR, createdAt: now - HOUR },
      { id: "ls_2", threadId: "th-1", ownerKind: "hold", reason: "terminal work", deadlineAt: now + 3 * HOUR, createdAt: now },
    ],
  };
}

function renderBadge(canCancel = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<BackgroundWorkBadge sessionId="s-1" canCancel={canCancel} />, { wrapper });
}

afterEach(() => vi.restoreAllMocks());

describe("background work helpers", () => {
  it("lists wakeups and holds, and hides a process lease behind its wakeup", () => {
    expect(backgroundItems(listing(NOW)).map((i) => i.id)).toEqual(["wk_1", "wk_2", "ls_2"]);
    expect(backgroundItems(undefined)).toEqual([]);
  });

  it("labels the badge with the count and the nearest deadline", () => {
    expect(badgeLabel(backgroundItems(listing(NOW)), NOW)).toBe("3 background · next deadline in 3h");
    expect(badgeLabel([{ id: "wk_t", kind: "timer", reason: "x", fireAt: NOW + 10 * 60_000, createdAt: NOW, status: "pending" }], NOW)).toBe(
      "1 background · next wakeup in 10m",
    );
    expect(timeUntil(NOW + 3 * 24 * HOUR, NOW)).toBe("in 3d");
    expect(timeUntil(NOW - 1, NOW)).toBe("now");
  });
});

describe("row detail (fix wave 3, L2)", () => {
  it("shows how long a process has run, and starting while it is pending", () => {
    const [proc, timer, hold] = backgroundItems(listing(NOW));
    expect(proc && itemDetail(proc, NOW)).toBe("Process · running 1h · deadline in 1d");
    expect(timer && itemDetail(timer, NOW)).toBe("Timer · fires in 2h");
    expect(hold && itemDetail(hold, NOW)).toBe("Hold · running under 1m · deadline in 3h");
    expect(proc && itemDetail({ ...proc, status: "pending" }, NOW)).toBe("Process · starting · deadline in 1d");
    expect(timeSince(NOW - 49 * HOUR, NOW)).toBe("2d");
  });
});

describe("BackgroundWorkBadge", () => {
  it("renders nothing when the session has no background work", async () => {
    const list = vi.spyOn(api, "listSessionWakeups").mockResolvedValue({ wakeups: [], leases: [] });
    const { container } = renderBadge();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("opens the list and cancels a row after a confirm that names the reason", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    const cancel = vi
      .spyOn(api, "cancelSessionWakeup")
      .mockResolvedValue({ cancelled: { id: "wk_1", kind: "process" } });
    const user = userEvent.setup();
    renderBadge();

    const trigger = await screen.findByRole("button", { name: "Background work" });
    expect(trigger.textContent).toContain("3 background");
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Cancel full proof build" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('This stops "full proof build". The agent gets a message that you stopped it.')).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Stop it" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith("s-1", "wk_1"));
  });

  it("hides Cancel from a person who may not stop the work", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    const user = userEvent.setup();
    renderBadge(false);
    await user.click(await screen.findByRole("button", { name: "Background work" }));
    expect(await screen.findByText("terminal work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Cancel / })).toBeNull();
  });
});
