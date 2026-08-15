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
let replaceMutateAsync = vi.fn().mockResolvedValue({ ok: true });

// importOriginal, not a bare replacement: vitest.config.ts sets
// `isolate: false` to share the module registry across test files in a
// worker (perf — avoids re-importing React/Radix/xyflow per file). Under
// that setting an incomplete `vi.mock("~/api/queries", ...)` in ANY file
// can end up governing the module for OTHER files sharing the worker —
// spreading the real module keeps every export present no matter whose
// factory the shared registry ends up using.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useDeleteSession: () => ({ isPending: false, mutateAsync: deleteMutateAsync }),
    useSetSessionModel: () => ({ isPending: false, mutate: setModelMutate }),
    usePauseSession: () => ({ isPending: pauseIsPending, mutateAsync: pauseMutateAsync }),
    useReplaceSandbox: () => ({ isPending: false, mutateAsync: replaceMutateAsync }),
  };
});

vi.mock("~/api/settings", () => ({
  useModels: () => ({ data: { models: [] }, isLoading: false, error: null }),
  useMe: () => ({ data: undefined, isLoading: false, error: null }),
  useOrg: () => ({ data: undefined, isLoading: false, error: null }),
}));

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({ data: undefined, isLoading: false, error: null }),
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
    docker: false,
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
  replaceMutateAsync = vi.fn().mockResolvedValue({ ok: true });
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

describe("SessionHeader — overflow menu", () => {
  it("has no direct trash button; the ⋯ menu holds Replace sandbox and Delete session", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    expect(screen.queryByRole("button", { name: "Delete session" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    expect(screen.getByRole("menuitem", { name: /replace sandbox/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /delete session/i })).toBeTruthy();
  });

  it("Replace sandbox posts the replace mutation without any confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    expect(replaceMutateAsync).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("surfaces the replace mutation's 409 error text verbatim", async () => {
    replaceMutateAsync = vi.fn().mockRejectedValue(new Error("a turn is running. Wait for it to finish, then retry."));
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    await waitFor(() => {
      expect(screen.getByText(/a turn is running/i)).toBeTruthy();
    });
  });

  it("Delete session confirms with copy naming threads, history, and child sessions", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toMatch(/threads/i);
    expect(message).toMatch(/child sessions/i);
    expect(deleteMutateAsync).toHaveBeenCalledWith("sess-1");
    confirmSpy.mockRestore();
  });

  it("a declined confirm does not delete", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));

    expect(deleteMutateAsync).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
