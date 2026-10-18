// @vitest-environment jsdom
/**
 * A place block on the overview (docs/specs/2026-10-16-presence-hub-design.md
 * Part B steps 4 and 5): the header links the place and shows the active
 * mark and the last activity; each row is the sentence without its place
 * clause, with the switch, the overflow menu, the inline problem, and the
 * paused line; `+ Listen for…` opens the wizard fixed on the place.
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
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "u-001", orgId: "acme", orgRole: "member" } }) }));

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

import { PlaceBlock } from "./place-block";
import type { PlaceBlockData } from "./overview-groups";

const PIN = "Pick another thread for this rule in Presence.";
const ACME = [{ field: "repo", op: "eq" as const, value: "acme/api" }];

function line(id: string, over: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id, name: id, ownerType: "user", ownerId: "u-001", eventKeys: [], filters: [],
    target: { kind: "assistant" }, enabled: true, createdBy: "u-001", createdAt: 1, updatedAt: 1, ...over,
  };
}

const R1 = line("R1", {
  name: "Reviews and checks",
  eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
  filters: ACME,
  target: { kind: "assistant", thread: { mode: "subject" } },
});
const R4 = line("R4", {
  name: "CI failures",
  eventKeys: ["github.check_run.completed"],
  filters: ACME,
  target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-u", threadId: "t-ci" } },
  problem: PIN,
});
const PAUSED = line("R5", {
  name: "Quiet checks",
  eventKeys: ["github.check_run.completed"],
  filters: ACME,
  enabled: false,
  target: { kind: "assistant", thread: { mode: "own" }, overlapPausedAt: 1 },
});

function block(over: Partial<PlaceBlockData>): PlaceBlockData {
  return {
    subject: "github:acme/api", label: "acme/api", service: "github", serviceWide: false,
    lines: [R1, R4, PAUSED], activeThreadCount: 2, lastActivityAt: Date.now() - 5 * 60_000, hasFault: true, ...over,
  };
}

function renderBlock(data: PlaceBlockData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PlaceBlock block={data} /></QueryClientProvider>);
}

beforeEach(() => {
  listThreads.mockReset();
  patchEventSubscription.mockReset();
  wizardProps.mockReset();
  listThreads.mockImplementation(async (_sessionId, opts) => ({
    threads: opts?.archived ? [{ id: "t-ci", sessionId: "s-u", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1, archivedAt: 2 }] : [],
  }));
  patchEventSubscription.mockImplementation(async (id) => ({ ...R4, id, problem: undefined }));
});

afterEach(cleanup);

describe("PlaceBlock", () => {
  it("heads the block with the place link, the active mark, and the last activity", () => {
    renderBlock(block({}));
    const region = screen.getByRole("region", { name: "acme/api" });
    expect(within(region).getByRole("link", { name: "acme/api" }).getAttribute("href")).toBe("/presence/places/github:acme/api");
    expect(within(region).getByText("2 active")).toBeTruthy();
    expect(within(region).getByText("5m ago")).toBeTruthy();
  });

  it("reads each line without its place clause, with the switch and the overflow menu", async () => {
    renderBlock(block({}));
    expect(screen.getByRole("link", { name: "When a pull request review or a check completes, work in one thread per pull request." })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "When a check completes, work in the Platform CI thread." })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Turn off Reviews and checks" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "More for Reviews and checks" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Edit", "Appears as", "Delete"]);
  });

  it("shows the problem under its row, and a pick patches the line", async () => {
    renderBlock(block({}));
    expect(await screen.findByText("Platform CI is archived. Pick another thread:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick Platform Ops from user" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", {
      thread: { mode: "existing", sessionId: "s-u", threadId: "t-ops" },
    }));
  });

  it("says a line is paused by the team", () => {
    renderBlock(block({}));
    expect(screen.getByText("Paused: the team already listens for this.")).toBeTruthy();
  });

  it("opens the wizard fixed on the place from + Listen for…", () => {
    renderBlock(block({}));
    fireEvent.click(screen.getByRole("button", { name: "+ Listen for…" }));
    expect(screen.getByText("Wizard for acme/api")).toBeTruthy();
    expect(wizardProps).toHaveBeenLastCalledWith(expect.objectContaining({
      preselectedPlace: { subject: "github:acme/api", service: "github", label: "acme/api" },
    }));
  });

  it("heads a Slack service block with no Slack row as text, and keeps a named channel list", () => {
    const twoChannels = line("B", {
      name: "Two rooms",
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#a", "#b"] }],
      target: { kind: "assistant", thread: { mode: "new" } },
    });
    const anywhere = line("A", { name: "Anywhere", eventKeys: ["slack.app_mention"], target: { kind: "assistant", thread: { mode: "new" } } });
    renderBlock(block({
      subject: "slack:*", label: "Everywhere in Slack", service: "slack", serviceWide: true,
      lines: [anywhere, twoChannels], activeThreadCount: 0, lastActivityAt: null,
    }));
    const region = screen.getByRole("region", { name: "Everywhere in Slack" });
    expect(within(region).queryByRole("link", { name: "Everywhere in Slack" })).toBeNull();
    expect(within(region).getByText("Everywhere in Slack")).toBeTruthy();
    const sentences = within(region).getAllByRole("link").map((link) => link.textContent);
    expect(sentences).toEqual([
      "When someone mentions Valet, reply in a new thread.",
      "When someone mentions Valet in #a or #b, reply in a new thread.",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "+ Listen for…" }));
    expect(wizardProps).toHaveBeenLastCalledWith(expect.objectContaining({
      preselectedPlace: { subject: "slack:*", service: "slack", label: "Slack" },
    }));
  });
});
