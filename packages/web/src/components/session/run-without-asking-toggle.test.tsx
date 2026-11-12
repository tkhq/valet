// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AssistantOwner } from "@valet/api/wire";

let threads: Array<{ id: string; sessionId: string; createdAt: number; approvalBypass?: true }> = [];
let me: { id: string; orgRole?: "admin" | "member" } | undefined;
let teams: Array<{ id: string; callerRole: "admin" | "member" }> = [];
const bypassMutate = vi.fn();

vi.mock("~/api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api/queries")>()),
  useThreads: () => ({ data: { threads } }),
  useSetThreadApprovalBypass: () => ({ isPending: false, mutate: bypassMutate }),
}));
vi.mock("~/api/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api/settings")>()),
  useMe: () => ({ data: me }),
  useTeams: () => ({ data: { teams } }),
}));

import { RunWithoutAskingToggle } from "./run-without-asking-toggle";

const owner: AssistantOwner = { type: "user", id: "u1" };
function renderToggle(who: AssistantOwner = owner, onlyWhenOn = false) {
  return render(<RunWithoutAskingToggle sessionId="sess-1" threadId="t1" owner={who} onlyWhenOn={onlyWhenOn} />);
}

describe("RunWithoutAskingToggle", () => {
  afterEach(() => { threads = []; me = undefined; teams = []; bypassMutate.mockReset(); });

  it("turns it on only after the owner confirms", async () => {
    me = { id: "u1" };
    threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1 }];
    renderToggle();
    const toggle = screen.getByRole("switch", { name: "Run without asking" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Run without asking")).toBeTruthy();
    await userEvent.click(toggle);
    expect(bypassMutate).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Run without asking" }));
    expect(bypassMutate).toHaveBeenCalledWith({ threadId: "t1", on: true }, expect.anything());
  });

  it("works from the keyboard and turns off without a confirm", async () => {
    me = { id: "u1" };
    threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1, approvalBypass: true }];
    renderToggle();
    expect(screen.getByText("Run without asking")).toBeTruthy();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("switch", { name: "Run without asking" }));
    await userEvent.keyboard(" ");
    expect(bypassMutate).toHaveBeenCalledWith({ threadId: "t1", on: false }, expect.anything());
  });

  it("is hidden from a viewer who cannot turn it on", () => {
    me = { id: "someone-else" };
    threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1 }];
    renderToggle();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("returns the hint when permission hides the switch", () => {
    me = { id: "someone-else" };
    threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1 }];
    render(<RunWithoutAskingToggle sessionId="sess-1" threadId="t1" owner={owner} fallback={<span>Enter to send</span>} />);
    expect(screen.getByText("Enter to send")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("stays visible to anyone while it is on, so they can turn it off", () => {
    me = { id: "someone-else" };
    threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1, approvalBypass: true }];
    renderToggle();
    expect(screen.getByRole("switch", { name: "Run without asking" }).getAttribute("aria-checked")).toBe("true");
  });

  it("with onlyWhenOn, shows nothing while off and the switch while on", () => {
    me = { id: "u1" };
    threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1 }];
    const off = renderToggle(owner, true);
    expect(screen.queryByRole("switch")).toBeNull();
    off.unmount();
    threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1, approvalBypass: true }];
    renderToggle(owner, true);
    expect(screen.getByRole("switch", { name: "Run without asking" }).getAttribute("aria-checked")).toBe("true");
  });

  it("hides only the visible text at narrow widths and keeps the accessible name", () => {
    me = { id: "u1" };
    threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1 }];
    render(<RunWithoutAskingToggle sessionId="sess-1" threadId="t1" owner={owner} compactLabel />);
    const text = screen.getByText("Run without asking");
    expect(text.className).toContain("hidden");
    expect(text.className).toContain("@container(min-width:34rem)");
    expect(screen.getByRole("switch", { name: "Run without asking" }).getAttribute("aria-checked")).toBe("false");
  });

  it("hands a mutation error to onError instead of rendering it beside the switch", async () => {
    me = { id: "u1" };
    threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1, approvalBypass: true }];
    bypassMutate.mockImplementation((_v, opts) => opts.onError(new Error("boom")));
    const onError = vi.fn();
    render(<RunWithoutAskingToggle sessionId="sess-1" threadId="t1" owner={owner} onError={onError} />);
    await userEvent.click(screen.getByRole("switch", { name: "Run without asking" }));
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining("boom"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("who may turn it on", () => {
    function offThread() { threads = [{ id: "t1", sessionId: "sess-1", createdAt: 1 }]; }

    it("shows it to the owner of a personal thread", () => {
      me = { id: "u1" };
      offThread();
      renderToggle({ type: "user", id: "u1" });
      expect(screen.getByRole("switch", { name: "Run without asking" })).toBeTruthy();
    });

    it("hides it from a viewer who does not own the personal thread", () => {
      me = { id: "u2" };
      offThread();
      renderToggle({ type: "user", id: "u1" });
      expect(screen.queryByRole("switch")).toBeNull();
    });

    it("shows it to an admin of the owning team", () => {
      me = { id: "u2" };
      teams = [{ id: "team-1", callerRole: "admin" }];
      offThread();
      renderToggle({ type: "team", id: "team-1" });
      expect(screen.getByRole("switch", { name: "Run without asking" })).toBeTruthy();
    });

    it("hides it from a team member who is not an admin", () => {
      me = { id: "u2" };
      teams = [{ id: "team-1", callerRole: "member" }];
      offThread();
      renderToggle({ type: "team", id: "team-1" });
      expect(screen.queryByRole("switch")).toBeNull();
    });

    it("hides it on an org-owned thread, even from an org admin", () => {
      me = { id: "u2", orgRole: "admin" };
      offThread();
      renderToggle({ type: "org", id: "org-1" });
      expect(screen.queryByRole("switch")).toBeNull();
    });
  });
});
