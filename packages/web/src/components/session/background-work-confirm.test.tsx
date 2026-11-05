// @vitest-environment jsdom
/**
 * The background-work confirm (fix wave 4, group C): status per row, the
 * copy when force cannot help, and the list after a forced retry that
 * stopped the work but did not finish the action.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackgroundWorkConflict, BackgroundWorkItem } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import { ApiError } from "~/api/client";
import { confirmCopy, useBackgroundWorkGuard, workAlreadyStopped, workItemDetail } from "./background-work-confirm";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const HOUR = 3_600_000;
const ACTION = { title: "Stop background work and pause?", confirmLabel: "Stop background work and pause" };

const proc: BackgroundWorkItem = {
  id: "wk_1",
  kind: "process",
  status: "running",
  reason: "full proof build",
  threadId: "t1",
  deadlineAt: NOW + 3 * HOUR,
  createdAt: NOW - HOUR,
};

function conflict(overrides: Partial<BackgroundWorkConflict> = {}): BackgroundWorkConflict {
  return {
    error: 'This session has background work running: "full proof build" (process).',
    code: "background_work",
    work: [proc],
    hiddenCount: 0,
    forceAllowed: true,
    ...overrides,
  };
}

describe("workItemDetail (fix wave 4, N11)", () => {
  it("shows starting for a pending row", () => {
    expect(workItemDetail({ ...proc, status: "pending" }, NOW)).toBe("Process · starting · deadline in 3h");
    expect(workItemDetail(proc, NOW)).toBe("Process · running 1h · deadline in 3h");
  });
});

describe("confirmCopy (fix wave 4, N2)", () => {
  it("states the fact without a question, and does not repeat the list, when force cannot help", () => {
    const copy = confirmCopy(conflict({ forceAllowed: false }), ACTION, false);
    expect(copy.title).toBe("Background work is running");
    expect(copy.description).toContain("wakeup_cancel");
    expect(copy.description).toContain("team admin");
    expect(copy.description).not.toContain("full proof build");
  });

  it("keeps the action's question when the person may force it", () => {
    expect(confirmCopy(conflict(), ACTION, false).title).toBe(ACTION.title);
  });
});

describe("workAlreadyStopped (fix wave 4, N8)", () => {
  it("matches the 409 that says the work already stopped, and nothing else", () => {
    const stopped = new ApiError(409, "409", {
      error: "a turn started, so the request did not pause the session. The background work already stopped. Wait for the turn to finish, then retry.",
    });
    expect(workAlreadyStopped(stopped)).toBe(true);
    expect(workAlreadyStopped(new ApiError(409, "409", { error: "a turn is running" }))).toBe(false);
    expect(workAlreadyStopped(new ApiError(409, "409", conflict()))).toBe(false);
  });
});

function Harness({ run }: { run: (force: boolean) => Promise<unknown> }) {
  const guard = useBackgroundWorkGuard();
  return (
    <>
      <button type="button" onClick={() => void guard.attempt(ACTION, run)}>
        Pause
      </button>
      {guard.dialog}
    </>
  );
}

describe("useBackgroundWorkGuard after the work already stopped (fix wave 4, N8)", () => {
  it("marks the list stopped, shows the server text, and offers no confirm", async () => {
    const text = "a turn started, so the request did not pause the session. The background work already stopped. Wait for the turn to finish, then retry.";
    const run = async (force: boolean) => {
      if (!force) throw new ApiError(409, "409", conflict());
      throw new ApiError(409, "409", { error: text });
    };
    const user = userEvent.setup();
    render(<Harness run={run} />);
    await user.click(screen.getByRole("button", { name: "Pause" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: ACTION.confirmLabel }));
    await waitFor(() => expect(within(dialog).getByText("Background work stopped")).toBeTruthy());
    expect(within(dialog).getByText("Stopped")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toBe(text);
    expect(within(dialog).queryByRole("button", { name: ACTION.confirmLabel })).toBeNull();
  });
});
