// @vitest-environment jsdom
/**
 * A place row of the overview roster (docs/specs/2026-10-16-presence-hub-design.md
 * Part B steps 4, 5, 7, and 11): the place column links the place and
 * stacks the active threads and the last activity; the sentence column
 * holds one sentence row per line without its place clause, the
 * appearance line, and `+ Listen for…`. No element of the row is a card.
 *
 * The api client is mocked at the transport, so the real query hooks run.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EventSubscriptionWire, ListThreadsResponse, PatchEventSubscriptionRequest } from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: ReactNode; className?: string }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, value), to);
    return <a href={path} className={className}>{children}</a>;
  },
}));

type ListThreadsOpts = { threadId?: string; archived?: boolean };
const listThreads = vi.fn<(sessionId: string, opts?: ListThreadsOpts) => Promise<ListThreadsResponse>>();
const patchEventSubscription = vi.fn<(id: string, body: PatchEventSubscriptionRequest) => Promise<EventSubscriptionWire>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listThreads: (sessionId: string, opts?: ListThreadsOpts) => listThreads(sessionId, opts),
      patchEventSubscription: (id: string, body: PatchEventSubscriptionRequest) => patchEventSubscription(id, body),
    },
  };
});

vi.mock("~/api/workflows", () => ({
  useTriggerCatalog: () => ({ data: { catalog: [] } }),
  useWorkflows: () => ({ data: { workflows: [] } }),
}));
vi.mock("~/api/settings", async () => (await import("./test-fixtures")).memberSettings);

const wizardProps = vi.fn();
vi.mock("~/components/events/automation-wizard", () => ({
  AutomationWizard: (props: { preselectedPlace?: { subject: string; service: string; label: string } }) => {
    wizardProps(props);
    return <p>Wizard for {props.preselectedPlace?.label}</p>;
  },
}));
vi.mock("~/components/events/edit-subscription-dialog", () => ({
  EditSubscriptionDialog: ({ sub, focus }: { sub: EventSubscriptionWire; focus?: string }) => <p>Editing {sub.name}{focus ? ` at ${focus}` : ""}</p>,
}));
vi.mock("~/components/events/team-slack-setup", () => ({
  TeamSlackSetupModal: ({ teamId }: { teamId: string }) => <p>Channel dialog for {teamId}</p>,
}));
vi.mock("./thread-picker", () => ({
  ThreadPicker: ({ workspace, onPick }: {
    workspace: string;
    onPick: (policy: Extract<AssistantThreadPolicy, { mode: "existing" }>, title: string) => void;
  }) => (
    <button type="button" onClick={() => onPick({ mode: "existing", sessionId: "s-u", threadId: "t-ops" }, "Platform Ops")}>
      Pick Platform Ops from {workspace}
    </button>
  ),
}));

import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { PlaceRow } from "./place-row";
import { PIN_UNAVAILABLE } from "./problem-badge";
import { PLATFORM_CI, line } from "./test-fixtures";
import type { PlaceBlockData } from "./overview-groups";

const ACME = [{ field: "repo", op: "eq" as const, value: "acme/api" }];

const R1 = line("R1", {
  name: "Reviews and checks",
  eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
  filters: ACME,
  target: { kind: "assistant", thread: { mode: "subject" }, appearance: { displayName: "Ops Bot" } },
});
const R4 = line("R4", {
  name: "CI failures",
  eventKeys: ["github.check_run.completed"],
  filters: ACME,
  target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-u", threadId: "t-ci" }, appearance: { displayName: "Ops Bot" } },
  problem: PIN_UNAVAILABLE,
});
const PAUSED = line("R5", {
  name: "Quiet checks",
  eventKeys: ["github.check_run.completed"],
  filters: ACME,
  enabled: false,
  target: { kind: "assistant", thread: { mode: "own" }, overlapPausedAt: 1 },
});
const OFF = line("R6", {
  name: "Old checks",
  eventKeys: ["github.check_run.completed"],
  filters: ACME,
  enabled: false,
  target: { kind: "assistant", thread: { mode: "own" } },
});

function block(over: Partial<PlaceBlockData>): PlaceBlockData {
  return {
    subject: "github:acme/api", label: "acme/api", service: "github", serviceWide: false,
    lines: [R1, R4, PAUSED], activeThreadCount: 2, lastActivityAt: Date.now() - 5 * 60_000, hasFault: true, ...over,
  };
}

function renderRow(data: PlaceBlockData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PlaceRow block={data} /></QueryClientProvider>);
}

/** The sentence row that holds a sentence link. */
function rowOf(sentence: HTMLElement): HTMLElement {
  const row = sentence.closest("[data-presence-line]");
  if (!(row instanceof HTMLElement)) throw new Error("The sentence is not in a sentence row.");
  return row;
}

/** True when an element draws a card: a border on all four sides and rounded corners. */
function isCard(element: Element): boolean {
  const classes = [...element.classList];
  return classes.includes("border") && classes.some((name) => name.startsWith("rounded"));
}

beforeEach(() => {
  listThreads.mockReset();
  patchEventSubscription.mockReset();
  wizardProps.mockReset();
  listThreads.mockImplementation(async (_sessionId, opts) => ({
    threads: opts?.archived ? [PLATFORM_CI] : [],
  }));
  patchEventSubscription.mockImplementation(async (id) => ({ ...R4, id, problem: undefined }));
});

afterEach(cleanup);

describe("PlaceRow", () => {
  it("sets the place as one row of the two-column grid, one column at phone width, with no card", () => {
    renderRow(block({}));
    const region = screen.getByRole("region", { name: "acme/api" });
    for (const name of ["grid", "grid-cols-[200px_minmax(0,1fr)]", "max-sm:grid-cols-1", "border-b", "border-line", "last:border-0"]) {
      expect(region.classList.contains(name)).toBe(true);
    }
    expect([region, ...region.querySelectorAll("*")].filter(isCard)).toEqual([]);
  });

  it("stacks the place link, the active threads, and the last activity in the place column", () => {
    renderRow(block({}));
    const region = screen.getByRole("region", { name: "acme/api" });
    const name = within(region).getByRole("link", { name: "acme/api" });
    expect(name.getAttribute("href")).toBe("/presence/places/github:acme/api");
    expect(name.className).toContain("text-[15px]");
    const active = within(region).getByText("2 active threads");
    const ago = within(region).getByText("5m ago");
    expect(active.parentElement).toBe(ago.parentElement);
    expect(active.parentElement?.className).toContain("tabular-nums");
  });

  it("reads one active thread, and says nothing about threads when none waits", () => {
    renderRow(block({ activeThreadCount: 1 }));
    expect(screen.getByText("1 active thread")).toBeTruthy();
    cleanup();
    renderRow(block({ activeThreadCount: 0 }));
    expect(screen.queryByText(/active thread/)).toBeNull();
    expect(screen.getByText("5m ago")).toBeTruthy();
  });

  it("does not repeat the service mark: the group heading carries it", () => {
    renderRow(block({}));
    expect(screen.getByRole("region", { name: "acme/api" }).querySelector("[data-service]")).toBeNull();
  });

  it("reads each line without its place clause, with the small switch and the overflow menu", async () => {
    renderRow(block({}));
    const sentence = screen.getByRole("link", { name: "When a pull request review or a check completes, work in one thread per pull request." });
    expect(sentence.className).toContain("text-base");
    expect(within(rowOf(sentence)).getByText("Reviews and checks").className).toContain("text-muted");
    expect(await screen.findByRole("link", { name: "When a check completes, work in the Platform CI thread." })).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Turn off Reviews and checks" });
    expect(toggle.classList.contains("w-7")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "More for Reviews and checks" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Edit", "Appears as", "Delete"]);
  });

  it("mutes an off line and says Off under it", () => {
    renderRow(block({ lines: [OFF] }));
    const sentence = screen.getByRole("link", { name: "When a check completes, work in its own thread." });
    expect(sentence.className).toContain("text-muted");
    expect(within(rowOf(sentence)).getByText("Off")).toBeTruthy();
  });

  it("marks a faulted line before its sentence and opens its fix under the row; a pick patches the line", async () => {
    renderRow(block({}));
    const sentence = await screen.findByRole("link", { name: "When a check completes, work in the Platform CI thread." });
    const row = rowOf(sentence);
    const mark = row.querySelector(".bg-danger-500");
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    // The row offers the picker behind one button; the banner shows it open.
    expect(within(row).queryByText("Platform CI is archived. Pick another thread:")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Pick another thread" }));
    expect(within(row).getByText("Platform CI is archived. Pick another thread:")).toBeTruthy();
    // A line with no fault carries no mark.
    const calm = screen.getByRole("link", { name: "When a pull request review or a check completes, work in one thread per pull request." });
    expect(rowOf(calm).querySelector(".bg-danger-500")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Pick Platform Ops from user" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", {
      thread: { mode: "existing", sessionId: "s-u", threadId: "t-ops" },
    }));
  });

  it("says a line is paused by the team, in place of Off", () => {
    renderRow(block({}));
    const sentence = screen.getByRole("link", { name: "When a check completes, work in its own thread." });
    expect(within(rowOf(sentence)).getByText("Paused: the team already listens for this.")).toBeTruthy();
    expect(within(rowOf(sentence)).queryByText("Off")).toBeNull();
  });

  it("shows one Appears as line after the sentences when a line sets an appearance", () => {
    renderRow(block({}));
    expect(screen.getAllByText("Appears as Ops Bot")).toHaveLength(1);
    cleanup();
    renderRow(block({ lines: [OFF] }));
    expect(screen.queryByText(/^Appears as/)).toBeNull();
  });

  it("opens the wizard fixed on the place from a quiet + Listen for…", () => {
    renderRow(block({}));
    const add = screen.getByRole("button", { name: "+ Listen for…" });
    expect(add.className).toContain("text-xs");
    expect(add.className).toContain("text-muted");
    fireEvent.click(add);
    expect(screen.getByText("Wizard for acme/api")).toBeTruthy();
    expect(wizardProps).toHaveBeenLastCalledWith(expect.objectContaining({
      preselectedPlace: { subject: "github:acme/api", service: "github", label: "acme/api" },
    }));
  });

  it("names a Slack service place with no Slack row as text, and keeps a named channel list", () => {
    const twoChannels = line("B", {
      name: "Two rooms",
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#a", "#b"] }],
      target: { kind: "assistant", thread: { mode: "new" } },
    });
    const anywhere = line("A", { name: "Anywhere", eventKeys: ["slack.app_mention"], target: { kind: "assistant", thread: { mode: "new" } } });
    renderRow(block({
      subject: "slack:*", label: "Everywhere in Slack", service: "slack", serviceWide: true,
      lines: [anywhere, twoChannels], activeThreadCount: 0, lastActivityAt: null,
    }));
    const region = screen.getByRole("region", { name: "Everywhere in Slack" });
    expect(within(region).queryByRole("link", { name: "Everywhere in Slack" })).toBeNull();
    expect(within(region).getByText("Everywhere in Slack")).toBeTruthy();
    const sentences = within(region).getAllByRole("link").map((link) => link.textContent);
    expect(sentences).toEqual([
      "When you mention Valet, reply in a new thread.",
      "When you mention Valet in #a or #b, reply in a new thread.",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "+ Listen for…" }));
    expect(wizardProps).toHaveBeenLastCalledWith(expect.objectContaining({
      preselectedPlace: { subject: "slack:*", service: "slack", label: "Slack" },
    }));
  });
});

describe("PlaceRow in a team workspace (Choose channels)", () => {
  function renderTeamRow(data: PlaceBlockData) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <PinnedWorkspaceScope teamId="sre"><PlaceRow block={data} /></PinnedWorkspaceScope>
      </QueryClientProvider>,
    );
  }
  const slackRow = (over: Partial<PlaceBlockData>) => block({
    subject: "slack:T1/C900", label: "#incidents", service: "slack", lines: [], hasFault: false, ...over,
  });

  it("offers Choose channels in a Slack row's overflow, and it opens the team's channel dialog", async () => {
    renderTeamRow(slackRow({}));
    await userEvent.click(screen.getByRole("button", { name: "More for #incidents" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Choose channels" }));
    expect(screen.getByText("Channel dialog for sre")).toBeTruthy();
  });

  it("offers Choose channels on the Slack service-wide row too", async () => {
    renderTeamRow(slackRow({ subject: "slack:T1", label: "Everywhere in Slack", serviceWide: true }));
    await userEvent.click(screen.getByRole("button", { name: "More for Everywhere in Slack" }));
    expect(screen.getByRole("menuitem", { name: "Choose channels" })).toBeTruthy();
  });

  it("has no overflow on a GitHub row, or on a Slack row in the personal workspace", () => {
    renderTeamRow(block({}));
    expect(screen.queryByRole("button", { name: "More for acme/api" })).toBeNull();
    cleanup();
    renderRow(slackRow({}));
    expect(screen.queryByRole("button", { name: "More for #incidents" })).toBeNull();
  });
});
