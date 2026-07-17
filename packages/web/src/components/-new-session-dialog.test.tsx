// @vitest-environment jsdom
/**
 * `NewSessionDialog` (sandbox auth gateway plan, Task 7; repo picker,
 * GitHub/repo integration plan Task 11): the web dialog is the interactive
 * session entry point, so it must request the "full" profile (ttyd +
 * code-server behind the gateway) rather than the "headless" server-side
 * default. Task 11 adds an optional repo picker over `useRepos()`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GetReposResponse } from "@valet/api/wire";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

const mutateAsync = vi.fn().mockResolvedValue({ id: "sess-new" });
vi.mock("~/api/queries", () => ({
  useCreateSession: () => ({ mutateAsync, isPending: false, error: null }),
}));

let reposData: GetReposResponse = { repos: [], connected: false, installed: false };
vi.mock("~/api/repos", () => ({
  useRepos: () => ({ data: reposData, isLoading: false, error: null }),
}));

import { NewSessionDialog } from "./new-session-dialog";

function repo(fullName: string, opts: { installed?: boolean; defaultBranch?: string } = {}) {
  return {
    fullName,
    url: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    defaultBranch: opts.defaultBranch ?? "main",
    private: false,
    installed: opts.installed,
  };
}

describe("NewSessionDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsync.mockResolvedValue({ id: "sess-new" });
    reposData = { repos: [], connected: false, installed: false };
  });

  it("submits with profile: full", async () => {
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /create/i }));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "full" }),
    );
  });

  it("no repo selected: create body carries no repos key at all (regression pin)", async () => {
    reposData = {
      repos: [repo("acme/api", { installed: true })],
      connected: true,
      installed: true,
    };
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const body = mutateAsync.mock.calls[mutateAsync.mock.calls.length - 1][0];
    expect("repos" in body).toBe(false);
  });

  it("unconnected + no installs: shows a hint row instead of the combobox", () => {
    reposData = { repos: [], connected: false, installed: false };
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(/connect github or install the app/i)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /search repositories/i })).toBeNull();
  });

  it("lists repos in response order with an installed marker", async () => {
    reposData = {
      repos: [repo("acme/api", { installed: true }), repo("acme/web", { installed: false })],
      connected: true,
      installed: true,
    };
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: /search repositories/i }));

    const listbox = screen.getByRole("listbox", { name: /repository results/i });
    const options = within(listbox).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("acme/api"),
      expect.stringContaining("acme/web"),
    ]);
    expect(within(options[0]).getByText("Installed")).toBeTruthy();
    expect(within(options[1]).queryByText("Installed")).toBeNull();
  });

  it("selecting a repo adds a binding row and autofills the workspace", async () => {
    reposData = {
      repos: [repo("acme/api", { installed: true, defaultBranch: "develop" })],
      connected: true,
      installed: true,
    };
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: /search repositories/i }));
    await user.click(screen.getByRole("option", { name: /acme\/api/i }));

    expect(screen.getByText("acme/api")).toBeTruthy();
    const workspaceInput = screen.getByLabelText("Workspace path") as HTMLInputElement;
    expect(workspaceInput.value).toBe("/workspace/api");
    const refInput = screen.getByLabelText("Branch for acme/api") as HTMLInputElement;
    expect(refInput.value).toBe("develop");
  });

  it("manually-edited workspace is not clobbered by a later repo selection", async () => {
    reposData = {
      repos: [repo("acme/api", { installed: true })],
      connected: true,
      installed: true,
    };
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    const workspaceInput = screen.getByLabelText("Workspace path");
    await user.clear(workspaceInput);
    await user.type(workspaceInput, "/custom/path");

    await user.click(screen.getByRole("combobox", { name: /search repositories/i }));
    await user.click(screen.getByRole("option", { name: /acme\/api/i }));

    expect((workspaceInput as HTMLInputElement).value).toBe("/custom/path");
  });

  it("Authenticate-as select renders only when installed && connected", async () => {
    reposData = {
      repos: [repo("acme/api", { installed: true }), repo("acme/web", { installed: false })],
      connected: true,
      installed: true,
    };
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("combobox", { name: /search repositories/i }));
    await user.click(screen.getByRole("option", { name: /acme\/api/i }));
    expect(screen.getByLabelText("Authenticate as for acme/api")).toBeTruthy();

    await user.click(screen.getByRole("combobox", { name: /add another repo/i }));
    await user.click(screen.getByRole("option", { name: /acme\/web/i }));
    expect(screen.queryByLabelText("Authenticate as for acme/web")).toBeNull();
  });

  it("removing a row drops its Authenticate-as select and binding", async () => {
    reposData = {
      repos: [repo("acme/api", { installed: true })],
      connected: true,
      installed: true,
    };
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: /search repositories/i }));
    await user.click(screen.getByRole("option", { name: /acme\/api/i }));

    await user.click(screen.getByRole("button", { name: "Remove acme/api" }));
    expect(screen.queryByText("acme/api")).toBeNull();
  });

  it("caps at 5 repos and hides the combobox once the cap is hit", async () => {
    const repos = Array.from({ length: 6 }, (_, i) => repo(`acme/repo${i}`, { installed: true }));
    reposData = { repos, connected: true, installed: true };
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();

    for (let i = 0; i < 5; i++) {
      const combo = screen.getByRole("combobox", { name: i === 0 ? /search repositories/i : /add another repo/i });
      await user.click(combo);
      await user.click(screen.getByRole("option", { name: new RegExp(`^acme/repo${i}`) }));
    }

    expect(screen.queryByPlaceholderText("owner/repo")).toBeNull();
    expect(screen.getByText(/up to 5 repos/i)).toBeTruthy();
  });

  it("submits selected repos as bindings with host/cloneUrl/ref/auth", async () => {
    reposData = {
      repos: [repo("acme/api", { installed: true, defaultBranch: "main" })],
      connected: true,
      installed: true,
    };
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: /search repositories/i }));
    await user.click(screen.getByRole("option", { name: /acme\/api/i }));

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const body = mutateAsync.mock.calls[mutateAsync.mock.calls.length - 1][0];
    expect(body.repos).toEqual([
      {
        host: "github",
        fullName: "acme/api",
        cloneUrl: "https://github.com/acme/api.git",
        ref: "main",
        auth: "auto",
      },
    ]);
  });
});
