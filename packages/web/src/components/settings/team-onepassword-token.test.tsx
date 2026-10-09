// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TeamOnePasswordToken } from "./team-onepassword-token";
import { api } from "~/api/client";

vi.mock("~/api/client", () => ({ api: { getTeamOnePasswordStatus: vi.fn(), putCredential: vi.fn(), deleteCredential: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function view(teamId = "a", canMutate = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const content = (id: string) => <QueryClientProvider client={qc}>
    <TeamOnePasswordToken key={id} teamId={id} teamName={id} canMutate={canMutate} />
  </QueryClientProvider>;
  const result = render(content(teamId));
  return { ...result, switchTeam: (id: string) => result.rerender(content(id)), qc };
}

describe("team 1Password connection", () => {
  it("reports a status error instead of offering controls", async () => {
    vi.mocked(api.getTeamOnePasswordStatus).mockRejectedValue(new Error("offline"));
    view();
    expect(await screen.findByText("Could not load the connection. Reload the page to try again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect 1Password" })).toBeNull();
  });

  it("connects through a token dialog, like any other integration", async () => {
    vi.mocked(api.getTeamOnePasswordStatus).mockResolvedValue({ tokenConnected: false });
    vi.mocked(api.putCredential).mockImplementation(async () => {
      vi.mocked(api.getTeamOnePasswordStatus).mockResolvedValue({ tokenConnected: true });
      return { ok: true };
    });
    view();
    expect(await screen.findByText("Uses the organization token")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect 1Password" }));
    fireEvent.change(screen.getByLabelText("Service account token"), { target: { value: "fake-team-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect token" }));
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(api.putCredential).toHaveBeenCalledWith("onepassword", { type: "service_account", apiKey: "fake-team-token", scope: "team", teamId: "a" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // A Valet team admin is not necessarily allowed to create a 1Password
  // service account, so the team dialog carries the same setup steps and
  // refusal note as the personal and organization dialogs.
  it("the setup dialog shows the steps and says what to ask for when 1Password refuses", async () => {
    vi.mocked(api.getTeamOnePasswordStatus).mockResolvedValue({ tokenConnected: false });
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Connect 1Password" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("link", { name: "Create a service account" })).toBeTruthy();
    const note = dialog.getByText(/contact your administrator/i);
    expect(note.textContent).toMatch(/ask a 1Password owner or administrator/i);
    expect(note.textContent).toMatch(/permission to create and manage service accounts/i);
    expect(note.textContent).toMatch(/keep the token outside every vault the service account can read/i);
  });

  it("shows status but no controls to a member", async () => {
    vi.mocked(api.getTeamOnePasswordStatus).mockResolvedValue({ tokenConnected: false });
    view("c", false);
    expect(await screen.findByText("Uses the organization token")).toBeTruthy();
    expect(screen.getByText("Team admin required")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect 1Password" })).toBeNull();
  });

  it("reports a failed save in the dialog, and confirms before disconnecting", async () => {
    vi.mocked(api.getTeamOnePasswordStatus).mockResolvedValue({ tokenConnected: true });
    vi.mocked(api.putCredential).mockRejectedValue(new Error("synthetic failure"));
    vi.mocked(api.deleteCredential).mockResolvedValue({ ok: true });
    view();
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    fireEvent.change(screen.getByLabelText("Service account token"), { target: { value: "fake-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect token" }));
    expect(await screen.findByText("Could not save the token. Check it and your team access, then try again.")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(api.deleteCredential).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: "Disconnect" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.deleteCredential).toHaveBeenCalledWith("onepassword", { scope: "team", teamId: "a" }));
  });
});
