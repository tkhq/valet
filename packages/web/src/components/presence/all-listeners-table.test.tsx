// @vitest-environment jsdom
/**
 * The **All listeners** table (docs/specs/2026-10-16-presence-hub-design.md
 * Part B step 4): every listener of the workspace, one row each, with its
 * Part C sentence. A listener over two channels is one row (Review Focus 2).
 */
import { render, screen, within } from "@testing-library/react";
import type { EventSubscriptionWire } from "@valet/api/wire";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: ReactNode }) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return <a href={href}>{children}</a>;
  },
}));

let owner: { ownerType: "user" | "team"; ownerId: string } | undefined;
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));

let subscriptions: { isPending: boolean; isError: boolean; error: Error | null; data?: { subscriptions: EventSubscriptionWire[] } };
const subscriptionCalls = vi.fn();
vi.mock("~/api/events", () => ({
  useEventSubscriptions: (o: unknown, opts: unknown) => {
    subscriptionCalls(o, opts);
    return subscriptions;
  },
}));
vi.mock("~/api/workflows", () => ({
  useTriggerCatalog: () => ({ data: { catalog: [] } }),
  useWorkflows: () => ({ data: { workflows: [{ id: "wf-1", name: "Incident triage" }] } }),
}));
vi.mock("~/api/listener", () => ({ usePinnedThreadTitles: () => ({}) }));

import { AllListenersTable } from "./all-listeners-table";
import { ListenerRow } from "./listener-rows";
import { PIN_UNAVAILABLE } from "./problem-badge";

function listener(id: string, over: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id, name: id, ownerType: "user", ownerId: "u-001", eventKeys: [], filters: [],
    target: { kind: "assistant" }, enabled: true, createdBy: "u-001", createdAt: 1, updatedAt: 1, ...over,
  };
}

const BROAD = listener("broad", {
  name: "Alerts and deploys",
  eventKeys: ["slack.app_mention"],
  filters: [{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#alerts", "#deploys"] }],
  target: { kind: "assistant", thread: { mode: "new" } },
});
const TRIAGE = listener("triage", {
  name: "Triage",
  enabled: false,
  eventKeys: ["github.check_run.completed"],
  filters: [{ field: "repo", op: "eq", value: "acme/api" }],
  target: { kind: "workflow", workflowId: "wf-1" },
});

beforeEach(() => {
  owner = { ownerType: "user", ownerId: "u-001" };
  subscriptionCalls.mockReset();
  subscriptions = { isPending: false, isError: false, error: null, data: { subscriptions: [BROAD, TRIAGE] } };
});

describe("AllListenersTable", () => {
  it("lists every listener once, with its sentence", () => {
    render(<AllListenersTable />);
    const table = screen.getByRole("table", { name: "All listeners" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Listener", "Status"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Alerts and deploys" }).getAttribute("href")).toBe("/presence/rules/broad");
    expect(within(rows[0]!).getByText("Listens in #alerts and #deploys for mentions · replies in a new thread")).toBeTruthy();
    expect(within(rows[0]!).getByText("On")).toBeTruthy();
    expect(within(rows[1]!).getByText("Listens on acme/api for completed checks · runs Incident triage")).toBeTruthy();
    expect(within(rows[1]!).getByText("Paused")).toBeTruthy();
    expect(screen.getAllByText(/#alerts/)).toHaveLength(1);
  });

  it("badges a listener with a problem in the table and in a row (Part C step 5)", () => {
    const broken = listener("broken", { name: "Pinned", problem: PIN_UNAVAILABLE });
    subscriptions = { isPending: false, isError: false, error: null, data: { subscriptions: [broken] } };
    render(<AllListenersTable />);
    const row = within(screen.getByRole("table", { name: "All listeners" })).getAllByRole("row")[1]!;
    expect(within(row).getByText("On")).toBeTruthy();
    expect(within(row).getByText("Thread archived")).toBeTruthy();
  });

  it("shows the paused and problem badges beside a listener row's sentence", () => {
    render(<ListenerRow sub={listener("broken", { enabled: false, problem: PIN_UNAVAILABLE })} sentence="Listens on acme/api for failed checks" />);
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("Thread archived")).toBeTruthy();
  });

  it("reads the switcher's workspace and waits for it", () => {
    owner = undefined;
    subscriptions = { isPending: true, isError: false, error: null };
    render(<AllListenersTable />);
    expect(subscriptionCalls).toHaveBeenLastCalledWith(undefined, { enabled: false });
    expect(screen.getByText("Loading listeners…")).toBeTruthy();
  });

  it("reads a team workspace's listeners", () => {
    owner = { ownerType: "team", ownerId: "sre" };
    render(<AllListenersTable />);
    expect(subscriptionCalls).toHaveBeenLastCalledWith({ ownerType: "team", ownerId: "sre" }, { enabled: true });
  });

  it("says when the workspace has no listeners", () => {
    subscriptions = { isPending: false, isError: false, error: null, data: { subscriptions: [] } };
    render(<AllListenersTable />);
    expect(screen.getByText("This workspace has no listeners yet. Select New listener to add one.")).toBeTruthy();
  });
});
