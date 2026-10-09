// @vitest-environment jsdom
/**
 * "Move to workspace" with background work (fix wave 3, H2): a move stops
 * every wakeup and hold, so the dialog lists that work, sends `force` only
 * from its own confirm, and reports how many items stopped.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ListSessionWakeupsResponse, PatchSessionResponse } from "@valet/api/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "~/api/client";

let wakeups: ListSessionWakeupsResponse = { wakeups: [], leases: [] };
let movePending = false;
const moveMutate = vi.fn();

vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSessionWakeups: () => ({ data: wakeups }),
    useMoveSession: () => ({ isPending: movePending, error: null, mutate: moveMutate }),
  };
});

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useTeams: () => ({
      data: { teams: [{ id: "team_1", name: "Platform", callerRole: "admin" }] },
      isLoading: false,
      error: null,
    }),
    useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
  };
});

import { MoveSessionDialog } from "./move-session-dialog";

const HOUR = 3_600_000;

function renderDialog() {
  const onOpenChange = vi.fn();
  render(<MoveSessionDialog sessionId="s1" owner={{ type: "user", id: "u1" }} open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

async function pickTeam(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Personal" }));
  await user.click(await screen.findByRole("menuitem", { name: "Platform" }));
}

beforeEach(() => {
  wakeups = { wakeups: [], leases: [] };
  movePending = false;
  moveMutate.mockReset();
});

describe("MoveSessionDialog with background work", () => {
  it("lists the work a move stops and sends force from its confirm", async () => {
    wakeups = {
      wakeups: [
        { id: "wk_1", threadId: "t1", kind: "process", status: "running", reason: "full proof build", deadlineAt: Date.now() + 49 * HOUR, createdAt: Date.now() - 2 * HOUR - 60_000 },
      ],
      leases: [],
    };
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Moving stops this background work/)).toBeTruthy();
    expect(within(dialog).getByText("full proof build")).toBeTruthy();
    expect(within(dialog).getByText("Process · running 2h · deadline in 2d")).toBeTruthy();

    await pickTeam(user);
    await user.click(within(dialog).getByRole("button", { name: "Stop background work and move" }));
    expect(moveMutate).toHaveBeenCalledWith({ teamId: "team_1", force: true }, expect.anything());
  });

  it("moves without force when nothing runs, and closes", async () => {
    moveMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: (r: Partial<PatchSessionResponse>) => void }) => opts.onSuccess?.({}));
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await pickTeam(user);
    await user.click(screen.getByRole("button", { name: "Move runtime" }));
    expect(moveMutate).toHaveBeenCalledWith({ teamId: "team_1" }, expect.anything());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows how many items the move stopped", async () => {
    wakeups = { wakeups: [], leases: [{ id: "ls_1", threadId: "t1", ownerKind: "hold", reason: "terminal work", deadlineAt: Date.now() + HOUR, createdAt: Date.now() }] };
    moveMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: (r: Partial<PatchSessionResponse>) => void }) =>
      opts.onSuccess?.({ cancelledWorkCount: 1, cancelledWork: ["ls_1"] }));
    const user = userEvent.setup();
    renderDialog();
    await pickTeam(user);
    await user.click(screen.getByRole("button", { name: "Stop background work and move" }));
    expect(await screen.findByText("Moved. Stopped 1 background item. The agent got a message about it.")).toBeTruthy();
  });

  it("a 409 for work the list did not show switches to the confirm", async () => {
    moveMutate.mockImplementation((_vars: unknown, opts: { onError?: (e: unknown) => void }) =>
      opts.onError?.(new ApiError(409, "PATCH → 409", {
        error: "This session has background work running.",
        code: "background_work",
        work: [{ id: "wk_9", kind: "timer", reason: "check CI", fireAt: Date.now() + HOUR + 60_000, createdAt: Date.now() }],
        hiddenCount: 0,
        forceAllowed: true,
      })));
    const user = userEvent.setup();
    renderDialog();
    await pickTeam(user);
    await user.click(screen.getByRole("button", { name: "Move runtime" }));
    await waitFor(() => expect(screen.getByText("check CI")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Stop background work and move" })).toBeTruthy();
  });
});
