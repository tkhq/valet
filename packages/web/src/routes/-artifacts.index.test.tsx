// @vitest-environment jsdom
/**
 * `/artifacts` gallery (final-review fix wave). `GET /api/artifacts` hands
 * an org ADMIN every member's artifacts unfiltered, so ownership filtering
 * moved server-side behind `?mine=1` (a client-side `actorUserId` match
 * against `/api/me` failed open: a failed `/api/me` call compared against
 * `undefined` and silently emptied the whole gallery). This suite asserts
 * the page asks for the `mine`-filtered view and still gets revoked-row
 * filtering and per-row revoke right. Mocked the same way
 * `-workflows.index.test.tsx` mocks `@tanstack/react-router` and its data
 * hooks.
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

const revoked: ArtifactListItem = {
  ...mine,
  id: "art_revoked",
  title: "Old page",
  token: "tok-revoked",
  url: "https://valet.example/a/tok-revoked",
  revoked: true,
};

let artifactsData: { artifacts: ArtifactListItem[] } = { artifacts: [mine, revoked] };

const revokeMutate = vi.fn();
let revokePending = false;
let revokeError: Error | null = null;
const useArtifactsMock = vi.fn();

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
  useArtifacts: (...args: unknown[]) => {
    useArtifactsMock(...args);
    return { data: artifactsData, isLoading: false, error: null };
  },
  useRevokeArtifact: () => ({ mutate: revokeMutate, isPending: revokePending, error: revokeError }),
}));

import { ArtifactsPage } from "./artifacts.index";

function renderPage() {
  return render(<ArtifactsPage />);
}

beforeEach(() => {
  artifactsData = { artifacts: [mine, revoked] };
  revokePending = false;
  revokeError = null;
  revokeMutate.mockClear();
  useArtifactsMock.mockClear();
});

describe("ArtifactsPage", () => {
  it("requests the server-filtered `mine` view instead of filtering client-side", () => {
    renderPage();
    expect(useArtifactsMock).toHaveBeenCalledWith(undefined, { mine: true });
  });

  it("filters out revoked rows", () => {
    renderPage();
    expect(screen.getByText("Deploy report")).toBeTruthy();
    expect(screen.queryByText("Old page")).toBeNull();
  });

  it("shows the empty state when the mine-filtered list is empty", () => {
    artifactsData = { artifacts: [revoked] };
    renderPage();
    expect(
      screen.getByText("Nothing published yet. Ask your agent to publish a page, or share a memory doc."),
    ).toBeTruthy();
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

  it("shows a corrective error and keeps the row when revoke fails", () => {
    revokeError = new Error("network unreachable");
    renderPage();
    expect(screen.getByText("Revoke failed: network unreachable. Retry, or refresh the page.")).toBeTruthy();
    expect(screen.getByText("Deploy report")).toBeTruthy();
  });
});
