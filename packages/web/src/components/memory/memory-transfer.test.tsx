// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "~/api/client";
import { MemoryTransfer } from "./memory-transfer";

const team = { id: "t1", orgId: "o1", name: "Engineering", origin: "local" as const, externalId: null,
  createdAt: 1, memberCount: 1, callerRole: "admin" as const, defaultModel: null };
const org = { id: "o1", name: "Org", createdAt: 1, callerRole: "member" as const,
  features: { organizations: true, ssoTeamSync: false }, ssoTeamGroups: [], allowPublicArtifacts: false, plugins: [] };

afterEach(() => vi.restoreAllMocks());
function setup(owner?: { ownerType: "team"; ownerId: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryTransfer path="notes/source.md" owner={owner} /></QueryClientProvider>);
}

it("pushes only after team, path and explicit submission; preserves a collision for correction", async () => {
  vi.spyOn(api, "listTeams").mockResolvedValue({ teams: [team] });
  vi.spyOn(api, "getOrg").mockResolvedValue(org);
  const copy = vi.spyOn(api, "copyMemoryFile").mockRejectedValueOnce(new ApiError(400, "POST /memory/copy-to-team → 400", { error: "Destination memory file already exists. Choose another path." }))
    .mockResolvedValue({ file: { ownerType: "team", ownerId: "t1", path: "notes/new.md" } });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Push to a team" }));
  const picker = screen.getByRole("button", { name: /^Destination team:/ });
  await waitFor(() => expect(picker).toHaveProperty("disabled", false));
  fireEvent.keyDown(picker, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Engineering" }));
  expect(copy).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Push to a team" })[1]);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Destination memory file already exists. Choose another path.");
  fireEvent.change(screen.getByLabelText("Destination path"), { target: { value: "notes/new.md" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Push to a team" })[1]);
  await screen.findByText("Copied to notes/new.md in team memory.");
  expect(copy).toHaveBeenLastCalledWith("push", { teamId: "t1", from: "notes/source.md", to: "notes/new.md" });
});

it("lets a team reader pull to personal memory without team write authority", async () => {
  const copy = vi.spyOn(api, "copyMemoryFile").mockResolvedValue({ file: { ownerType: "user", ownerId: "u1", path: "notes/source.md" } });
  setup({ ownerType: "team", ownerId: "t1" });
  fireEvent.click(screen.getByRole("button", { name: "Pull to personal memory" }));
  expect(screen.queryByLabelText("Destination team")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Pull to personal memory" })[1]);
  await screen.findByText("Copied to notes/source.md in personal memory.");
  expect(copy).toHaveBeenCalledWith("pull", { teamId: "t1", from: "notes/source.md", to: "notes/source.md" });
});

it("explains and disables pushes for ordinary members and org admins outside the team", async () => {
  vi.spyOn(api, "listTeams").mockResolvedValue({ teams: [{ ...team, callerRole: null }] });
  vi.spyOn(api, "getOrg").mockResolvedValue({ ...org, callerRole: "admin" });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Push to a team" }));
  await screen.findByText("No teams available for copying.");
  fireEvent.keyDown(screen.getByRole("button", { name: /^Destination team:/ }), { key: "Enter" });
  expect(await screen.findByRole("menuitem", { name: "Engineering" })).toHaveProperty("ariaDisabled", "true");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.getAllByRole("button", { name: "Push to a team" })[1]).toHaveProperty("disabled", true);
  expect(screen.getByText("A team or organization admin can copy files into this team.")).toBeTruthy();
});

it("recovers team lookup failures through Retry", async () => {
  vi.spyOn(api, "listTeams").mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ teams: [team] });
  vi.spyOn(api, "getOrg").mockResolvedValue(org);
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Push to a team" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  fireEvent.keyDown(screen.getByRole("button", { name: /^Destination team:/ }), { key: "Enter" });
  expect(await screen.findByRole("menuitem", { name: "Engineering" })).toBeTruthy();
});
