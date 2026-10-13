// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_DEBOUNCE_MS } from "~/components/search-input";
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
    artifact: { version: "1.0.0", sha: "abc123456789", checkpointId: "1.0.0@abc", status: "exact" },
  };
}

let data = makeData();

function setPagedData(): void {
  data.manifest.checkpoints = Array.from({ length: 6 }, (_, index) => ({
    kind: "released" as const,
    id: `${index + 1}.0.0@sha-${index}`,
    version: `${index + 1}.0.0`,
    releasedAt: `2026-09-0${index + 1}T12:00:00Z`,
    releasedSha: `sha-${index}`,
    previousSha: null,
    entries: [change(`Change ${index + 1}`, index === 0 ? "fix" : "feature", `sha-${index}`)],
  }));
}

let changelogPending = false;
let changelogError = false;
let searchParams: Record<string, unknown> = {};
const navigate = vi.fn();

vi.mock("~/api/changelog", () => ({
  useChangelog: () => ({ data: changelogPending ? undefined : data, isPending: changelogPending, isError: changelogError }),
}));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "user-1" } }),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useSearch: () => searchParams,
  useNavigate: () => navigate,
}));

import { ChangelogPage, readChangelogSearch } from "./changelog";

function lastNavigationSearch(): Record<string, unknown> {
  const call = navigate.mock.calls[navigate.mock.calls.length - 1];
  const [options] = (call ?? [{}]) as [{ search?: Record<string, unknown> }];
  return options.search ?? {};
}

describe("ChangelogPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    data = makeData();
    changelogPending = false;
    changelogError = false;
    searchParams = {};
    navigate.mockReset();
  });

  it("parses valid URL state and drops invalid values", () => {
    expect(readChangelogSearch({ category: "fix", sort: "oldest", q: "login", page: "3" })).toEqual({
      category: "fix",
      sort: "oldest",
      q: "login",
      page: 3,
    });
    expect(readChangelogSearch({ category: "unknown", sort: "sideways", page: -2 })).toEqual({
      category: undefined,
      sort: undefined,
      q: undefined,
      page: undefined,
    });
  });

  it("shows and copies the running commit from the artifact metadata", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ChangelogPage />);

    const runningCommit = screen.getByRole("link", { name: "Running commit abc123456789" });
    expect(runningCommit.textContent).toBe("abc123456");
    expect(runningCommit.getAttribute("href")).toContain("/commit/abc123456789");
    expect(runningCommit.getAttribute("title")).toBe("abc123456789");
    fireEvent.click(screen.getByRole("button", { name: "Copy running commit" }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("abc123456789");
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
      expect(JSON.parse(window.localStorage.getItem("valet:changelog-seen:user-1") ?? "")).toEqual({
        checkpointId: "1.0.0@abc",
        unreleasedEntryCommitShas: [],
      });
    });
    expect(await screen.findAllByText("New")).toHaveLength(3);
  });

  it("does not mark entries new for malformed persisted read state", () => {
    window.localStorage.setItem("valet:changelog-seen:user-1", "{");
    render(<ChangelogPage />);

    expect(screen.queryAllByText("New")).toHaveLength(0);
  });

  it("restores filters and search from a shared URL", () => {
    searchParams = { category: "fix" };
    const view = render(<ChangelogPage />);
    expect(screen.getByText("Repair login")).toBeTruthy();
    expect(screen.queryByText("Open the changelog")).toBeNull();

    searchParams = { q: "missing" };
    view.rerender(<ChangelogPage />);
    expect(screen.getByText("No changes match these filters.")).toBeTruthy();
  });

  it("writes control changes to the URL and resets the page", async () => {
    searchParams = { page: 2 };
    render(<ChangelogPage />);
    fireEvent.change(screen.getByLabelText("Filter by change type"), { target: { value: "fix" } });
    expect(lastNavigationSearch()).toMatchObject({ category: "fix", page: undefined });

    fireEvent.change(screen.getByLabelText("Sort releases"), { target: { value: "oldest" } });
    expect(lastNavigationSearch()).toMatchObject({ sort: "oldest", page: undefined });

    fireEvent.change(screen.getByLabelText("Search changes"), { target: { value: "login" } });
    await act(async () => new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 10)));
    expect(lastNavigationSearch()).toMatchObject({ q: "login", page: undefined });
  });

  it("keeps a shared page position while changelog data loads", () => {
    setPagedData();
    searchParams = { page: 2 };
    changelogPending = true;
    const view = render(<ChangelogPage />);
    expect(screen.getByText("Loading changelog…")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();

    changelogPending = false;
    view.rerender(<ChangelogPage />);
    expect(screen.getByRole("heading", { level: 2, name: "1.0.0" })).toBeTruthy();
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
  });

  it("restores sorting and whole-section pagination from the URL", async () => {
    setPagedData();
    searchParams = { page: 2 };
    const view = render(<ChangelogPage />);

    expect(screen.getByRole("heading", { level: 2, name: "1.0.0" })).toBeTruthy();
    const pager = screen.getByRole("navigation", { name: "Pages of changelog" });
    expect(within(pager).getByText("Page 2 of 2")).toBeTruthy();
    fireEvent.click(within(pager).getByRole("button", { name: "Previous" }));
    expect(lastNavigationSearch()).toMatchObject({ page: undefined });

    searchParams = { sort: "oldest" };
    view.rerender(<ChangelogPage />);
    expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe("1.0.0");

    searchParams = { page: 99 };
    view.rerender(<ChangelogPage />);
    await waitFor(() => expect(lastNavigationSearch()).toMatchObject({ page: 2 }));
    expect(screen.getByRole("heading", { level: 2, name: "1.0.0" })).toBeTruthy();
  });

  it("marks only newly added unreleased entries until the next visit under StrictMode", async () => {
    data.manifest.checkpoints.unshift({
      kind: "unreleased",
      id: "unreleased@def123456789",
      buildSha: "def123456789",
      builtAt: "2026-09-10T12:00:00Z",
      previousSha: "abc",
      entries: [change("Added after visit", "feature", "new123456789"), change("Already seen", "feature", "old123456789")],
    });
    window.localStorage.setItem(
      "valet:changelog-seen:user-1",
      JSON.stringify({
        checkpointId: "unreleased@abc123456789",
        unreleasedEntryCommitShas: ["old123456789"],
      }),
    );

    const firstVisit = render(
      <StrictMode>
        <ChangelogPage />
      </StrictMode>,
    );
    const newEntry = screen.getByText("Added after visit").closest("li");
    if (!newEntry) throw new Error("The new entry must render in a list row.");
    expect(within(newEntry).getByText("New")).toBeTruthy();
    const seenEntry = screen.getByText("Already seen").closest("li");
    if (!seenEntry) throw new Error("The seen entry must render in a list row.");
    expect(within(seenEntry).queryByText("New")).toBeNull();

    searchParams = { q: "Added after" };
    firstVisit.rerender(
      <StrictMode>
        <ChangelogPage />
      </StrictMode>,
    );
    const filteredEntry = screen.getByText("Added after visit").closest("li");
    if (!filteredEntry) throw new Error("The filtered entry must render in a list row.");
    expect(within(filteredEntry).getByText("New")).toBeTruthy();

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem("valet:changelog-seen:user-1") ?? "")).toMatchObject({
        checkpointId: "unreleased@def123456789",
        unreleasedEntryCommitShas: ["new123456789", "old123456789"],
      });
    });
    firstVisit.unmount();

    render(<ChangelogPage />);
    expect(screen.queryAllByText("New")).toHaveLength(0);
  });

  it("labels the filters and keeps them in keyboard order", async () => {
    const user = userEvent.setup();
    render(<ChangelogPage />);

    const filters = screen.getByRole("group", { name: "Changelog filters" });
    const search = within(filters).getByLabelText("Search changes");
    const category = within(filters).getByLabelText("Change type");
    const sort = within(filters).getByLabelText("Sort releases");
    expect(category).toBe(screen.getByRole("combobox", { name: "Filter by change type" }));
    expect(sort).toBe(screen.getByRole("combobox", { name: "Sort releases" }));
    search.focus();
    await user.tab();
    expect(document.activeElement).toBe(category);
    await user.tab();
    expect(document.activeElement).toBe(sort);
  });

  it("keeps long entry text, timestamps, and source links available", () => {
    const entry = change("LongTitle".repeat(30), "feature", "long123456789");
    entry.description = "A long description with all details preserved. ".repeat(20);
    entry.authoredAt = "2026-09-09T10:00:00Z";
    data.manifest.checkpoints[0].entries = [entry];
    render(<ChangelogPage />);

    const row = screen.getByRole("heading", { level: 4, name: entry.title }).closest("li");
    if (!row) throw new Error("The long entry must render in a list row.");
    expect(within(row).getByText(entry.description.trim()).textContent).toBe(entry.description);
    expect(row.querySelector("time")?.getAttribute("datetime")).toBe(entry.authoredAt);
    expect(within(row).getByRole("link", { name: "PR #42" }).getAttribute("href")).toContain("/pull/42");
    expect(within(row).getByRole("link", { name: "Commit long123456789" }).getAttribute("href")).toContain("/commit/long123456789");
  });

  it("announces loading and load errors", () => {
    changelogPending = true;
    const view = render(<ChangelogPage />);
    expect(screen.getByRole("status").textContent).toContain("Loading changelog");

    changelogPending = false;
    changelogError = true;
    view.rerender(<ChangelogPage />);
    expect(screen.getByRole("alert").textContent).toBe("Could not load the changelog. Reload the page to try again.");
  });

  it("keeps filters available for no matches and handles an empty manifest", () => {
    searchParams = { q: "missing" };
    const view = render(<ChangelogPage />);
    expect(screen.getByRole("status").textContent).toContain("No changes match these filters.");
    expect(screen.getByRole("group", { name: "Changelog filters" })).toBeTruthy();

    data.manifest.checkpoints = [];
    view.rerender(<ChangelogPage />);
    expect(screen.getByText("No release checkpoints are available for this build.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Changelog filters" })).toBeNull();
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
