// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangelogEntry, GetChangelogResponse } from "@valet/api/wire";

function change(title: string, category: ChangelogEntry["category"], commitSha: string): ChangelogEntry {
  return {
    title,
    description: `${title} description`,
    category,
    sources: { commitSha, pullRequest: 42 },
    followUp: false,
  };
}

function makeData(): GetChangelogResponse {
  return {
    manifest: {
      schema: "valet-changelog/v2",
      generatedAt: "2026-09-09T12:00:00Z",
      checkpoints: [
        {
          kind: "released",
          id: "1.0.0@abc",
          version: "1.0.0",
          releasedAt: "2026-09-09T12:00:00Z",
          releasedSha: "abc",
          previousSha: null,
          entries: [change("Repair login", "fix", "fixabc123456"), change("Open the changelog", "feature", "abc123456789")],
        },
      ],
    },
    artifact: { version: "1.0.0", sha: "abc", checkpointId: "1.0.0@abc", status: "exact" },
  };
}

let data = makeData();

vi.mock("~/api/changelog", () => ({
  useChangelog: () => ({ data, isPending: false, isError: false }),
}));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "user-1" } }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, createFileRoute: () => () => ({}) };
});

import { ChangelogPage } from "./changelog";

describe("ChangelogPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    data = makeData();
  });

  it("groups features first, keeps source links, and marks the release read", async () => {
    render(<ChangelogPage />);
    expect(screen.getByRole("heading", { name: "Changelog" })).toBeTruthy();
    const typeHeadings = screen.getAllByRole("heading", { level: 3 });
    expect(typeHeadings.map((heading) => heading.textContent)).toEqual(["Features", "Fixes"]);
    expect(screen.getByText("Open the changelog description")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "PR #42" })[0]?.getAttribute("href")).toContain("/pull/42");
    expect(screen.getByRole("link", { name: "Commit abc123456789" }).getAttribute("href")).toContain(
      "/commit/abc123456789",
    );
    await waitFor(() => {
      expect(window.localStorage.getItem("valet:changelog-seen:user-1")).toBe("1.0.0@abc");
    });
    expect(await screen.findByText("New")).toBeTruthy();
  });

  it("filters and searches entries with a clear empty state", () => {
    render(<ChangelogPage />);
    fireEvent.change(screen.getByLabelText("Filter by change type"), { target: { value: "fix" } });
    expect(screen.getByText("Repair login")).toBeTruthy();
    expect(screen.queryByText("Open the changelog")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search changes"), { target: { value: "missing" } });
    expect(screen.getByText("No changes match these filters.")).toBeTruthy();
  });

  it("sorts and paginates whole release sections, then resets the page after filtering", () => {
    data.manifest.checkpoints = Array.from({ length: 6 }, (_, index) => ({
      kind: "released" as const,
      id: `${index + 1}.0.0@sha-${index}`,
      version: `${index + 1}.0.0`,
      releasedAt: `2026-09-0${index + 1}T12:00:00Z`,
      releasedSha: `sha-${index}`,
      previousSha: null,
      entries: [change(`Change ${index + 1}`, index === 0 ? "fix" : "feature", `sha-${index}`)],
    }));
    render(<ChangelogPage />);

    expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe("6.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "1.0.0" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter by change type"), { target: { value: "fix" } });
    expect(screen.queryByText("Page 2 of 2")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "1.0.0" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter by change type"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Sort releases"), { target: { value: "oldest" } });
    expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe("1.0.0");
    expect(within(screen.getByRole("navigation", { name: "Changelog pages" })).getByText("Page 1 of 2")).toBeTruthy();
  });

  it("shows an unreleased build with its links and empty state", () => {
    data.manifest.checkpoints.unshift({
      kind: "unreleased",
      id: "unreleased@def123456789",
      buildSha: "def123456789",
      builtAt: "2026-09-10T12:00:00Z",
      previousSha: "abc",
      buildUrl: "https://github.com/tkhq/valet/actions/runs/1",
      entries: [],
    });
    render(<ChangelogPage />);
    expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe("Unreleased");
    expect(screen.getByRole("link", { name: "Build def123456" }).getAttribute("href")).toContain(
      "/commit/def123456789",
    );
    expect(screen.getByRole("link", { name: "Build" }).getAttribute("href")).toContain("/actions/runs/1");
    expect(screen.getByText("No user-facing changes are pending in this build.")).toBeTruthy();
  });
});
