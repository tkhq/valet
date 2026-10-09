// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PinnedWorkspaceScope, useWorkspaceScope } from "./workspace-scope";

vi.mock("@tanstack/react-router", () => ({ useSearch: () => ({}) }));
vi.mock("~/api/settings", () => ({ useOrg: () => ({ data: undefined }), useTeams: () => ({ data: undefined }) }));
vi.mock("~/components/session/assistant-rail", () => ({ eligibleTeams: () => [] }));

function Probe({ label }: { label: string }) {
  const scope = useWorkspaceScope();
  return <span>{`${label} ${scope.key} ${scope.teamId ?? "none"}`}</span>;
}

// Settings pages name their scope in the URL, so they pin it instead of
// reading the switcher. The switcher itself must not move.
it("pins a team scope for its children only", () => {
  render(
    <>
      <PinnedWorkspaceScope teamId="team-1"><Probe label="inside" /></PinnedWorkspaceScope>
      <Probe label="outside" />
    </>,
  );
  expect(screen.getByText("inside team-1 team-1")).toBeTruthy();
  expect(screen.getByText("outside user none")).toBeTruthy();
});

it("pins the personal workspace", () => {
  render(<PinnedWorkspaceScope teamId={undefined}><Probe label="inside" /></PinnedWorkspaceScope>);
  expect(screen.getByText("inside user none")).toBeTruthy();
});
