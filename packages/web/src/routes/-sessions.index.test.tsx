// @vitest-environment jsdom
/**
 * `/sessions` list. The row carries the three things that make the list
 * readable without opening anything — title, run state, age — and the order
 * puts the rows that are blocked on a person at the top. `<Link>` needs
 * router context, mocked here the same way `-workflows.index.test.tsx` does,
 * since these tests only care that the row links somewhere.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { SessionSummary } from "@valet/api/wire";

const sessionsQuery = vi.fn();
const refetch = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  createFileRoute: () => (config: unknown) => config,
}));

// The dialog runs its own queries; this suite is about the list.
vi.mock("~/components/new-session-dialog", () => ({
  NewSessionDialog: () => <div data-testid="new-session-dialog" />,
}));

// importOriginal: a bare replacement drops every other export this module
// tree imports. See -new-session-dialog.test.tsx for the full reason.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return { ...actual, useSessions: () => sessionsQuery() };
});

// The mock above spreads `...actual`, so this is the real predicate, not a
// stand-in. Only `useSessions` is replaced.
import { sessionsAreLive } from "~/api/queries";
import { SessionsPage, sortByAttention } from "./sessions.index";

const MINUTE = 60_000;

function session(over: Partial<SessionSummary> & Pick<SessionSummary, "id">): SessionSummary {
  return {
    workspace: "acme/api",
    status: "active",
    runState: "idle",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: Date.now() - 5 * MINUTE,
    owner: { type: "user", id: "u1" },
    ...over,
  };
}

function renderList(sessions: SessionSummary[]) {
  sessionsQuery.mockReturnValue({
    data: { sessions },
    isLoading: false,
    error: null,
    refetch,
  });
  return render(<SessionsPage />);
}

describe("sessionsAreLive", () => {
  it("keeps polling while a session is working", () => {
    expect(
      sessionsAreLive({
        sessions: [session({ id: "s_1", runState: "idle" }), session({ id: "s_2", runState: "working" })],
      }),
    ).toBe(true);
  });

  it("keeps polling while a session waits on a person", () => {
    expect(sessionsAreLive({ sessions: [session({ id: "s_1", runState: "needs_you" })] })).toBe(true);
  });

  it("stops polling for states that only a new prompt can change", () => {
    for (const runState of ["idle", "sleeping", "failed"] as const) {
      expect(sessionsAreLive({ sessions: [session({ id: "s_1", runState })] })).toBe(false);
    }
  });

  it("stops polling for an empty list", () => {
    expect(sessionsAreLive({ sessions: [] })).toBe(false);
  });
});

describe("sortByAttention", () => {
  it("puts the states that need a person above the ones that do not", () => {
    const order = sortByAttention([
      session({ id: "s_idle", runState: "idle" }),
      session({ id: "s_working", runState: "working" }),
      session({ id: "s_sleeping", runState: "sleeping" }),
      session({ id: "s_failed", runState: "failed" }),
      session({ id: "s_needs", runState: "needs_you" }),
    ]).map((s) => s.id);

    expect(order.slice(0, 3)).toEqual(["s_needs", "s_failed", "s_working"]);
  });

  it("orders sessions of equal rank by most recent activity", () => {
    const now = Date.now();
    const order = sortByAttention([
      session({ id: "s_old", runState: "idle", lastActivityAt: now - 60 * MINUTE }),
      session({ id: "s_new", runState: "idle", lastActivityAt: now - 1 * MINUTE }),
      session({ id: "s_mid", runState: "sleeping", lastActivityAt: now - 10 * MINUTE }),
    ]).map((s) => s.id);

    expect(order).toEqual(["s_new", "s_mid", "s_old"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [
      session({ id: "s_idle", runState: "idle" }),
      session({ id: "s_needs", runState: "needs_you" }),
    ];
    sortByAttention(input);
    expect(input.map((s) => s.id)).toEqual(["s_idle", "s_needs"]);
  });
});

describe("SessionsPage", () => {
  it("shows the title, the run state and the age of each session", () => {
    renderList([
      session({
        id: "s_1",
        title: "Fix the flaky bake",
        workspace: "acme/api",
        runState: "needs_you",
        lastActivityAt: Date.now() - 5 * MINUTE,
      }),
    ]);

    const row = within(screen.getAllByRole("listitem")[0]);
    expect(row.getByText("Fix the flaky bake")).toBeTruthy();
    expect(row.getByText("Needs you")).toBeTruthy();
    expect(row.getByText("5m ago")).toBeTruthy();
    expect(row.getByText("acme/api")).toBeTruthy();
  });

  it("names an untitled session rather than rendering an empty row", () => {
    renderList([session({ id: "s_1", title: undefined })]);
    expect(screen.getByText("Untitled session")).toBeTruthy();
  });

  it("renders the blocked session first, above older idle ones", () => {
    const now = Date.now();
    renderList([
      session({ id: "s_a", title: "Idle one", runState: "idle", lastActivityAt: now }),
      session({ id: "s_b", title: "Idle two", runState: "idle", lastActivityAt: now - MINUTE }),
      session({
        id: "s_c",
        title: "Blocked one",
        runState: "needs_you",
        lastActivityAt: now - 90 * MINUTE,
      }),
    ]);

    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByText("Blocked one")).toBeTruthy();
    expect(within(rows[1]).getByText("Idle one")).toBeTruthy();
  });

  it("links each row to its session detail page", () => {
    renderList([session({ id: "s_1", title: "Fix the flaky bake" })]);
    const row = screen.getByText("Fix the flaky bake").closest("a");
    expect(row?.getAttribute("to")).toBe("/sessions/$sessionId");
  });

  it("tells the user how to create the first session when the list is empty", () => {
    renderList([]);
    const empty = screen.getByText(/No standalone sessions\./);
    // The empty state points at the same control the header offers, under
    // the same name — one name for one thing.
    expect(within(empty).getByRole("button", { name: "New session" })).toBeTruthy();
  });

  it("names the corrective action when the list fails to load", () => {
    sessionsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
      refetch,
    });
    render(<SessionsPage />);

    expect(screen.getByText("The sessions did not load. Select Retry.")).toBeTruthy();
    refetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});
