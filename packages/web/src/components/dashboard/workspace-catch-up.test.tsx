// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { OwnerFilter } from "~/api/client";
import { WorkspaceCatchUp } from "./workspace-catch-up";

let owner: OwnerFilter | undefined;
let identityError: Error | null;
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ error: identityError }) }));
vi.mock("./workspace-activity", () => ({ WorkspaceActivity: ({ owner }: { owner: OwnerFilter }) => <div>Activity for {owner.ownerType}:{owner.ownerId}</div> }));

beforeEach(() => {
  owner = { ownerType: "user", ownerId: "u" };
  identityError = null;
});
function setup(explicitOwner?: OwnerFilter) {
  return render(<WorkspaceCatchUp owner={explicitOwner} />);
}

it("shows personal activity without a generated briefing or its loading state", () => {
  setup();
  expect(screen.getByText("Activity for user:u")).toBeTruthy();
  expect(screen.queryByText(/briefing/i)).toBeNull();
});
it("uses the explicit team scope for activity", () => {
  setup({ ownerType: "team", ownerId: "team-1" });
  expect(screen.getByText("Activity for team:team-1")).toBeTruthy();
  expect(screen.queryByText(/briefing/i)).toBeNull();
});
it("briefs one goal across conversations and runs with one concise summary", async () => {
  setup();
  const article = await screen.findByRole("article", { name: briefing.title });
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(within(article).getByText(briefing.summary)).toBeTruthy();
  expect(within(article).queryByText("Next step")).toBeNull();
  expect(within(article).getByRole("link", { name: "Open thread" }).getAttribute("href")).toBe("/threads/rollout-review");
  expect(within(article).getByRole("link", { name: "Routing design" }).getAttribute("href")).toBe("/threads/design");
  expect(within(article).getByRole("link", { name: "TKAI-42 routing PR" }).getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
  expect(within(article).getByRole("link", { name: "Replay report" }).getAttribute("href")).toBe("/a/replay-report");
  expect(within(article).getByRole("list", { name: "Sources" }).querySelector("a")?.textContent).toBe("TKAI-42 routing PR");
  expect(screen.getByText("Detailed activity")).toBeTruthy();
  expect(screen.queryByText("Activity details")).toBeNull();
  expect(within(article).getByText("Review the rollout thread before release.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Replay verification" }).closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("Details · 4 sources"));
  expect(screen.getByRole("link", { name: "Replay verification" }).closest("details")?.open).toBe(true);
  expect(screen.getByRole("link", { name: "Replay verification" }).getAttribute("href")).toBe("/workflows/runs/run-verification");
});
it("links the run, not an invented conversation, when only workflow evidence exists", async () => {
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [{ ...briefing, latestThread: null, status: "updated", sources: [{ id: "run", kind: "workflow", title: "Verification run", updatedAt: 1, runId: "run" }, { id: "unknown", kind: "message", title: "Imported note", updatedAt: 1, url: "javascript:alert(1)" }] }], generatedAt: 100, coverage: "recent" });
  setup();
  expect(await screen.findByRole("link", { name: "Open run" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open run" }).getAttribute("href")).toBe("/workflows/runs/run");
  expect(screen.queryByText("No linked conversation")).toBeNull();
  expect(screen.queryByRole("link", { name: "Open thread" })).toBeNull();
  expect(screen.getByRole("link", { name: "Verification run" }).getAttribute("href")).toBe("/workflows/runs/run");
  expect(screen.queryByRole("link", { name: "Imported note" })).toBeNull();
  expect(screen.getByText("Imported note")).toBeTruthy();
  expect(screen.queryByText("Next step")).toBeNull();
  expect(screen.queryByText("Completed")).toBeNull();
});
it("never pairs a needs-attention badge with nothing to do", async () => {
  vi.mocked(api.getWorkspaceBriefings).mockResolvedValue({ briefings: [{ ...briefing, nextAction: undefined }], generatedAt: 100, coverage: "recent" });
  setup();
  expect(await screen.findByText("Review the linked sources for details.")).toBeTruthy();
  expect(screen.queryByText("Nothing waits on you.")).toBeNull();
});
it("prepares without an unscoped request while identity is unresolved", () => {
  owner = undefined;
  setup();
  expect(screen.getByText("Loading work…")).toBeTruthy();
  expect(screen.queryByText(/Activity for/)).toBeNull();
});
it("hides personal activity when identity cannot load", () => {
  identityError = new Error("denied");
  setup();
  expect(screen.getByText("Could not load your workspace. Reload to try again.")).toBeTruthy();
  expect(screen.queryByText(/Activity for/)).toBeNull();
});
