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

const collision = (revision = "rev-1") => new ApiError(409, "Conflict", {
  code: "MEMORY_DESTINATION_EXISTS", destinationVersion: revision,
  error: "Destination already exists.",
});
function startPull() {
  const view = setup({ ownerType: "team", ownerId: "t1" });
  fireEvent.click(screen.getByRole("button", { name: "Pull to personal memory" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Pull to personal memory" })[1]);
  return view;
}

it("asks on collision without overwriting, and cancel makes no second request", async () => {
  const copy = vi.spyOn(api, "copyMemoryFile").mockRejectedValue(collision());
  startPull();
  await screen.findByRole("dialog");
  expect(copy).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledWith("pull", { teamId: "t1", from: "notes/source.md", to: "notes/source.md" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: false }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(copy).toHaveBeenCalledTimes(1);
});

it("sends replacement only after explicit confirmation and freezes inputs while pending", async () => {
  const copy = vi.spyOn(api, "copyMemoryFile").mockRejectedValueOnce(collision())
    .mockImplementationOnce(() => new Promise(() => {}));
  startPull();
  fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
  await waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
  expect(copy).toHaveBeenLastCalledWith("pull", { teamId: "t1", from: "notes/source.md", to: "notes/source.md", replacement: { expectedVersion: "rev-1" } });
  expect(screen.getByLabelText("Destination path")).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("choosing another path preserves the draft and clears replacement authorization", async () => {
  const copy = vi.spyOn(api, "copyMemoryFile").mockRejectedValueOnce(collision())
    .mockResolvedValue({ file: { ownerType: "user", ownerId: "u1", path: "notes/renamed.md" } });
  startPull();
  fireEvent.click(await screen.findByRole("button", { name: "Choose another path" }));
  const destination = screen.getByLabelText("Destination path");
  expect(destination).toHaveProperty("value", "notes/source.md");
  fireEvent.change(destination, { target: { value: "notes/renamed.md" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Pull to personal memory" })[1]);
  await screen.findByText("Copied to notes/renamed.md in personal memory.");
  expect(copy).toHaveBeenLastCalledWith("pull", { teamId: "t1", from: "notes/source.md", to: "notes/renamed.md" });
});

it.each(["path", "owner"])("changing %s clears an outstanding confirmation", async (changed) => {
  vi.spyOn(api, "copyMemoryFile").mockRejectedValue(collision());
  const view = startPull();
  await screen.findByRole("dialog");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  view.rerender(<QueryClientProvider client={client}><MemoryTransfer path={changed === "path" ? "notes/other.md" : "notes/source.md"} owner={{ ownerType: "team", ownerId: changed === "owner" ? "t2" : "t1" }} /></QueryClientProvider>);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
});

it("a conflict after confirmation asks again with the new revision", async () => {
  const copy = vi.spyOn(api, "copyMemoryFile").mockRejectedValueOnce(collision("rev-1"))
    .mockRejectedValueOnce(new ApiError(409, "Changed", { code: "MEMORY_DESTINATION_CHANGED", destinationVersion: "rev-2" }))
    .mockResolvedValue({ file: { ownerType: "user", ownerId: "u1", path: "notes/source.md" } });
  startPull();
  fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
  await screen.findByText(/changed since/);
  expect(copy).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Replace" }));
  await screen.findByText("Copied to notes/source.md in personal memory.");
  expect(copy).toHaveBeenLastCalledWith("pull", expect.objectContaining({ replacement: { expectedVersion: "rev-2" } }));
});

it.each([
  new ApiError(409, "Conflict", { error: "Unrelated conflict" }),
  new ApiError(403, "Forbidden", { code: "MEMORY_DESTINATION_EXISTS", destinationVersion: "rev-1", error: "Denied" }),
  new ApiError(409, "Conflict", { code: "MEMORY_DESTINATION_EXISTS", error: "Missing revision" }),
])("ordinary or malformed errors never offer replacement", async (error) => {
  const copy = vi.spyOn(api, "copyMemoryFile").mockRejectedValue(error);
  startPull();
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  expect(copy).toHaveBeenCalledTimes(1);
});


it("a deleted destination needs a fresh Copy choice without stale replacement authority", async () => {
  const copy = vi.spyOn(api, "copyMemoryFile").mockRejectedValueOnce(collision())
    .mockRejectedValueOnce(new ApiError(409, "Changed", { code: "MEMORY_DESTINATION_CHANGED", destinationVersion: null }))
    .mockResolvedValue({ file: { ownerType: "user", ownerId: "u1", path: "notes/source.md" } });
  startPull();
  fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
  await screen.findByText("Destination no longer exists");
  expect(copy).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await screen.findByText("Copied to notes/source.md in personal memory.");
  expect(copy).toHaveBeenLastCalledWith("pull", { from: "notes/source.md", to: "notes/source.md", teamId: "t1" });
});

it("changing the destination path clears the old confirmation", async () => {
  vi.spyOn(api, "copyMemoryFile").mockRejectedValue(collision());
  startPull();
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByLabelText("Destination path"), { target: { value: "notes/other.md" } });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("push replacement uses the selected team and confirmed path", async () => {
  vi.spyOn(api, "listTeams").mockResolvedValue({ teams: [team] });
  vi.spyOn(api, "getOrg").mockResolvedValue(org);
  const copy = vi.spyOn(api, "copyMemoryFile").mockRejectedValueOnce(collision())
    .mockResolvedValue({ file: { ownerType: "team", ownerId: "t1", path: "notes/destination.md" } });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Push to a team" }));
  const picker = screen.getByRole("button", { name: /^Destination team:/ });
  await waitFor(() => expect(picker).toHaveProperty("disabled", false));
  fireEvent.keyDown(picker, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Engineering" }));
  fireEvent.change(screen.getByLabelText("Destination path"), { target: { value: "notes/destination.md" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Push to a team" })[1]);
  await screen.findByRole("dialog");
  expect(copy).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/already exists in team Engineering/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Replace" }));
  await screen.findByText("Copied to notes/destination.md in team memory.");
  expect(copy).toHaveBeenLastCalledWith("push", { from: "notes/source.md", to: "notes/destination.md", teamId: "t1", replacement: { expectedVersion: "rev-1" } });
});


it("ignores a late collision from the previous owner context", async () => {
  let rejectOld: (error: Error) => void = () => {};
  const copy = vi.spyOn(api, "copyMemoryFile").mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
    .mockResolvedValue({ file: { ownerType: "user", ownerId: "u1", path: "notes/source.md" } });
  const view = startPull();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  view.rerender(<QueryClientProvider client={client}><MemoryTransfer path="notes/source.md" owner={{ ownerType: "team", ownerId: "t2" }} /></QueryClientProvider>);
  rejectOld(collision());
  fireEvent.click(screen.getByRole("button", { name: "Pull to personal memory" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Pull to personal memory" })[1]);
  await screen.findByText("Copied to notes/source.md in personal memory.");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(copy).toHaveBeenLastCalledWith("pull", { from: "notes/source.md", to: "notes/source.md", teamId: "t2" });
});

it("a destination team change cannot reuse the old replacement choice", async () => {
  vi.spyOn(api, "listTeams").mockResolvedValue({ teams: [team, { ...team, id: "t2", name: "Design" }] });
  vi.spyOn(api, "getOrg").mockResolvedValue(org);
  const copy = vi.spyOn(api, "copyMemoryFile").mockRejectedValueOnce(collision())
    .mockResolvedValue({ file: { ownerType: "team", ownerId: "t2", path: "notes/source.md" } });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Push to a team" }));
  const picker = screen.getByRole("button", { name: /^Destination team:/ });
  await waitFor(() => expect(picker).toHaveProperty("disabled", false));
  fireEvent.keyDown(picker, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Engineering" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Push to a team" })[1]);
  fireEvent.click(await screen.findByRole("button", { name: "Choose another path" }));
  fireEvent.keyDown(screen.getByRole("button", { name: /^Destination team:/ }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Design" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Push to a team" })[1]);
  await screen.findByText("Copied to notes/source.md in team memory.");
  expect(copy).toHaveBeenLastCalledWith("push", { from: "notes/source.md", to: "notes/source.md", teamId: "t2" });
});
