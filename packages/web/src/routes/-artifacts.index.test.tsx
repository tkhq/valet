// @vitest-environment jsdom
/**
 * `/artifacts` gallery (final-review fix wave). `GET /api/artifacts` hands
 * an org ADMIN every member's artifacts, so the page must filter to rows
 * the caller themselves published — not just the non-revoked ones — before
 * the "Pages you published" header copy and the Revoke button are truthful.
 * Mocked the same way `-workflows.index.test.tsx` mocks `@tanstack/react-router`
 * and its data hooks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ArtifactListItem } from "@valet/api/wire";

const mine: ArtifactListItem = {
  id: "art_mine",
  path: "artifacts/report.md",
  title: "Deploy report",
  format: "markdown",
  icon: "📄",
  version: 1,
  sharedVersion: null,
  token: "tok-mine",
  url: "https://valet.example/a/tok-mine",
  visibility: "org",
  actorUserId: "u-1",
  revoked: false,
  createdAt: 1,
  updatedAt: 2,
};

const someoneElses: ArtifactListItem = {
  ...mine,
  id: "art_other",
  title: "Colleague's page",
  token: "tok-other",
  url: "https://valet.example/a/tok-other",
  actorUserId: "u-2",
};

const revoked: ArtifactListItem = {
  ...mine,
  id: "art_revoked",
  title: "Old page",
  token: "tok-revoked",
  url: "https://valet.example/a/tok-revoked",
  revoked: true,
};

let artifactsData: { artifacts: ArtifactListItem[] } = { artifacts: [mine, someoneElses, revoked] };
let meData: { id: string } | undefined = { id: "u-1" };
let meLoading = false;

const revokeMutate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  // `params` is spread as a real prop (an object), not through `...rest`,
  // so the row's token is readable off the rendered anchor as a plain data
  // attribute instead of stringifying to "[object Object]".
  Link: ({
    children,
    params,
    ...rest
  }: {
    children: ReactNode;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => (
    <a {...rest} data-token={params?.token}>
      {children}
    </a>
  ),
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/artifacts", () => ({
  useArtifacts: () => ({ data: artifactsData, isLoading: false, error: null }),
  useRevokeArtifact: () => ({ mutate: revokeMutate, isPending: false }),
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: meData, isLoading: meLoading, error: null }),
}));

import { ArtifactsPage } from "./artifacts.index";

function renderPage() {
  return render(<ArtifactsPage />);
}

beforeEach(() => {
  artifactsData = { artifacts: [mine, someoneElses, revoked] };
  meData = { id: "u-1" };
  meLoading = false;
  revokeMutate.mockClear();
});

describe("ArtifactsPage", () => {
  it("filters out revoked rows", () => {
    renderPage();
    expect(screen.getByText("Deploy report")).toBeTruthy();
    expect(screen.queryByText("Old page")).toBeNull();
  });

  it("filters out rows the caller does not own, even though the api returned them", () => {
    renderPage();
    expect(screen.getByText("Deploy report")).toBeTruthy();
    expect(screen.queryByText("Colleague's page")).toBeNull();
  });

  it("shows the empty state when the caller has no artifacts of their own", () => {
    artifactsData = { artifacts: [someoneElses, revoked] };
    renderPage();
    expect(
      screen.getByText("Nothing published yet. Ask your agent to publish a page, or share a memory doc."),
    ).toBeTruthy();
  });

  it("renders a loading row while `me` is still loading, instead of an empty state", () => {
    meData = undefined;
    meLoading = true;
    renderPage();
    expect(screen.queryByText(/Nothing published yet/)).toBeNull();
    expect(screen.queryByText("Deploy report")).toBeNull();
  });

  it("links each row to /a/$token with the row's token", () => {
    renderPage();
    const link = screen.getByText("Deploy report").closest("a");
    expect(link?.getAttribute("to")).toBe("/a/$token");
    expect(link?.getAttribute("data-token")).toBe("tok-mine");
  });

  it("does not revoke when the confirm dialog is dismissed", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revokeMutate).not.toHaveBeenCalled();
  });

  it("revokes the clicked row's artifact once the confirm dialog is accepted", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeMutate).toHaveBeenCalledWith({ id: "art_mine" }));
  });
});
