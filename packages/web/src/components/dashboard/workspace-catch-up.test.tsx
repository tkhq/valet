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
it("waits for identity before showing personal activity", () => {
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
