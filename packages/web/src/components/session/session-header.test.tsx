// @vitest-environment jsdom
/**
 * Sandbox hibernation plan, Task 5: the pause control + sleeping badge.
 * `SandboxChip` gains a `suspended` entry (dot + "sleeping — will wake on
 * message" tooltip label), and the header grows a pause button that posts
 * `usePauseSession`, is disabled unless `sandbox.state === "ready"`, and
 * surfaces the mutation's error text verbatim on failure (e.g. the 409
 * "a turn is running" / "sandbox is not ready to pause" bodies).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "~/components/primitives";
import type { SessionDetail } from "@valet/api/wire";

const deleteMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const setModelMutate = vi.fn();
let pauseMutateAsync = vi.fn().mockResolvedValue({ status: "hibernated" });
let pauseIsPending = false;

vi.mock("~/api/queries", () => ({
  useDeleteSession: () => ({ isPending: false, mutateAsync: deleteMutateAsync }),
  useSetSessionModel: () => ({ isPending: false, mutate: setModelMutate }),
  usePauseSession: () => ({ isPending: pauseIsPending, mutateAsync: pauseMutateAsync }),
}));

vi.mock("~/api/settings", () => ({
  useModels: () => ({ data: { models: [] }, isLoading: false, error: null }),
  useMe: () => ({ data: undefined, isLoading: false, error: null }),
  useOrg: () => ({ data: undefined, isLoading: false, error: null }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

import { SessionHeader, SandboxChip } from "./session-header";

function baseSession(): SessionDetail {
  return {
    id: "sess-1",
    workspace: "acme/repo",
    status: "active",
    title: "Fix the bug",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 3,
    profile: "headless",
  };
}

function renderHeader(sandbox?: { state: string; epoch: number }) {
  return render(
    <TooltipProvider>
      <SessionHeader session={baseSession()} agentStatus="idle" conn="open" sandbox={sandbox} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  deleteMutateAsync.mockClear();
  setModelMutate.mockClear();
  pauseMutateAsync = vi.fn().mockResolvedValue({ status: "hibernated" });
  pauseIsPending = false;
});

describe("SandboxChip — suspended state", () => {
  it("renders the sleeping label for a suspended sandbox", () => {
    render(
      <TooltipProvider>
        <SandboxChip sandbox={{ state: "suspended", epoch: 1 }} />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText("sleeping — will wake on message")).toBeTruthy();
  });
});

describe("SessionHeader — pause control", () => {
  it("disables the pause button while the sandbox is not ready", () => {
    renderHeader({ state: "provisioning", epoch: 1 });
    const button = screen.getByRole("button", { name: /pause/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("enables the pause button once the sandbox is ready and posts on click", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    const button = screen.getByRole("button", { name: /pause/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await user.click(button);
    expect(pauseMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("surfaces the mutation's error text verbatim on a 409", async () => {
    pauseMutateAsync = vi.fn().mockRejectedValue(new Error("a turn is running"));
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: /pause/i }));

    await waitFor(() => {
      expect(screen.getByText("a turn is running")).toBeTruthy();
    });
  });
});
