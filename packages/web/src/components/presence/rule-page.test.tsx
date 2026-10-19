// @vitest-environment jsdom
/**
 * One line of presence on its page (docs/specs/2026-10-16-presence-hub-design.md
 * Part D; acceptance P7, P8, P18): the place breadcrumb, the sentence as
 * the title, the status line with Edit and the overflow menu, the health
 * strip, the problem with the picker, How it works, Activity with its
 * chips, Diagnostics for an organization admin, and the paused copy.
 *
 * The api client is mocked at the transport, so the real query hooks run.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EventSubscriptionWire,
  ListEventReceiptsResponse,
  LineActivityEntryWire,
  LineActivityResponse,
  ListEventSubscriptionsResponse,
  ListThreadsResponse,
  PatchEventSubscriptionRequest,
  ThreadAddress,
} from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn<(to: { to: string }) => Promise<void>>();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  useNavigate: () => navigate,
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: ReactNode; className?: string }) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return <a href={href} className={className}>{children}</a>;
  },
}));

type ListThreadsOpts = { threadId?: string; archived?: boolean };
const listEventSubscriptions = vi.fn<() => Promise<ListEventSubscriptionsResponse>>();
const getLineActivity = vi.fn<(id: string, params?: { before?: string; limit?: number }) => Promise<LineActivityResponse>>();
const listEventReceipts = vi.fn<(params: { subscriptionId?: string }) => Promise<ListEventReceiptsResponse>>();
const listThreads = vi.fn<(sessionId: string, opts?: ListThreadsOpts) => Promise<ListThreadsResponse>>();
const getThreadAddress = vi.fn<(id: string) => Promise<ThreadAddress>>();
const patchEventSubscription = vi.fn<(id: string, body: PatchEventSubscriptionRequest) => Promise<EventSubscriptionWire>>();
const deleteEventSubscription = vi.fn<(id: string) => Promise<{ ok: true }>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listEventSubscriptions: () => listEventSubscriptions(),
      getLineActivity: (id: string, params?: { before?: string; limit?: number }) => getLineActivity(id, params),
      listEventReceipts: (params: { subscriptionId?: string }) => listEventReceipts(params),
      listThreads: (sessionId: string, opts?: ListThreadsOpts) => listThreads(sessionId, opts),
      getThreadAddress: (id: string) => getThreadAddress(id),
      patchEventSubscription: (id: string, body: PatchEventSubscriptionRequest) => patchEventSubscription(id, body),
      deleteEventSubscription: (id: string) => deleteEventSubscription(id),
      listPresencePlaces: async () => ({ places: [] }),
    },
  };
});

vi.mock("~/api/workflows", () => ({
  useTriggerCatalog: () => ({ data: { catalog: [] } }),
  useWorkflows: () => ({ data: { workflows: [] } }),
}));

let orgRole: "admin" | "member" = "admin";
let teams: { id: string; name: string; callerRole: "admin" | "member" | null }[] = [{ id: "sre", name: "SRE", callerRole: "member" }];
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-001", orgId: "acme", orgRole } }),
  useOrgDirectory: () => ({ data: { users: [{ userId: "u-001", email: "c@acme.test", name: "Conner", avatarUrl: null }] } }),
  useTeams: () => ({ data: { teams } }),
}));

/** The editor is its own suite's (its Where and review copy are tested
 * there); here it records the mode it opened on. */
vi.mock("~/components/presence/editor/line-editor", async () => (await import("~/components/presence/editor/test-editor-stub")).stubModule);

/** The picker lists real threads in its own suite; here one pick stands in. */
vi.mock("./thread-picker", () => ({
  ThreadPicker: ({ workspace, onPick }: {
    workspace: string;
    onPick: (policy: Extract<AssistantThreadPolicy, { mode: "existing" }>, title: string) => void;
  }) => (
    <button type="button" onClick={() => onPick({ mode: "existing", sessionId: "s-ws", threadId: "t-ops" }, "Platform Ops")}>
      Pick Platform Ops from {workspace}
    </button>
  ),
}));

import { RulePage } from "./rule-page";

const PIN_TEXT = "Pick another thread in Presence.";

function listener(over: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id: "R4",
    name: "Failed checks",
    ownerType: "user",
    ownerId: "u-001",
    eventKeys: ["github.check_run.completed"],
    filters: [{ field: "repo", op: "eq", value: "acme/api" }],
    target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ci" } },
    enabled: true,
    createdBy: "u-001",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const NOW = Date.now();

function activity(entries: LineActivityEntryWire[], over: Partial<LineActivityResponse> = {}): LineActivityResponse {
  return { entries, lastActedAt: null, actedLast30Days: 0, perDay: Array.from({ length: 30 }, () => 0), ...over };
}

function acted(id: string, over: Partial<LineActivityEntryWire> = {}): LineActivityEntryWire {
  return {
    id, kind: "acted", at: NOW - 60_000, eventId: `ev-${id}`, eventKey: "github.check_run.completed",
    place: "github:acme/api#14", placeLabel: "acme/api#14", ...over,
  };
}

function skipped(id: string, over: Partial<LineActivityEntryWire> = {}): LineActivityEntryWire {
  return { ...acted(id), kind: "skipped", at: NOW - 120_000, ...over };
}

/** The timeline's rows as their text, newest first. */
function activityRows(): string[] {
  const section = screen.getByRole("region", { name: "Activity" });
  return Array.from(section.querySelectorAll("li")).map((row) => row.textContent ?? "");
}

/** Opens the status line's overflow menu and picks Delete. */
async function pickDelete(name = "Failed checks") {
  await userEvent.click(await screen.findByRole("button", { name: `More for ${name}` }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
}

function renderPage(id = "R4") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><RulePage id={id} /></QueryClientProvider>);
}

beforeEach(() => {
  orgRole = "admin";
  teams = [{ id: "sre", name: "SRE", callerRole: "member" }];
  navigate.mockReset();
  for (const mock of [listEventSubscriptions, getLineActivity, listEventReceipts, listThreads, getThreadAddress, patchEventSubscription, deleteEventSubscription]) {
    mock.mockReset();
  }
  deleteEventSubscription.mockResolvedValue({ ok: true });
  getLineActivity.mockResolvedValue(activity([]));
  listEventReceipts.mockResolvedValue({ receipts: [], nextCursor: null, lastReceiptAt: null, retentionDays: 7 });
  listThreads.mockImplementation(async (_sessionId, opts) => ({
    threads: opts?.archived
      ? [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1, archivedAt: 5 }]
      : [{ id: "t-other", sessionId: "s-ws", title: "Something else", createdAt: 1, lastUserActivityAt: 1 }],
  }));
  patchEventSubscription.mockImplementation(async (id, body) => ({ ...listener({}), id, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}) }));
});

describe("RulePage", () => {
  it("reads the sentence with the pinned thread's title, from the archived list when the open list misses it", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "When a check completes on acme/api, work in the Platform CI thread." })).toBeTruthy();
    expect(listThreads).toHaveBeenCalledWith("s-ws", { threadId: "t-ci" });
    expect(listThreads).toHaveBeenCalledWith("s-ws", { threadId: "t-ci", archived: true });
  });

  it("reads an open pin's title from the first read alone", async () => {
    listThreads.mockResolvedValue({
      threads: [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1 }],
    });
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "When a check completes on acme/api, work in the Platform CI thread." })).toBeTruthy();
    expect(listThreads).toHaveBeenCalledTimes(1);
  });

  it("turns the listener off and on", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    const toggle = await screen.findByRole("switch", { name: "Turn off Failed checks" });
    expect(screen.getByText("On")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", { enabled: false }));
  });

  it("turns a paused listener on", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ enabled: false })] });
    renderPage();
    fireEvent.click(await screen.findByRole("switch", { name: "Turn on Failed checks" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", { enabled: true }));
  });

  it("opens the editor on this line from Edit", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: edit Failed checks");
  });

  it("shows the place breadcrumb and the sentence as the title with tokens (P7)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    const title = await screen.findByRole("heading", { level: 1, name: "When a check completes on acme/api, work in the Platform CI thread." });
    // The title reads the place and the pinned thread as tokens; the place links its page.
    expect(within(title).getByRole("link", { name: "acme/api" }).getAttribute("href")).toBe("/presence/places/github:acme/api");
    expect(within(title).getByRole("link", { name: "Platform CI" }).getAttribute("href")).toBe("/threads/t-ci");
    // The service mark leads the title.
    expect(title.parentElement?.querySelector('[data-service="github"][data-size="lg"]')).not.toBeNull();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Presence›acme/api›Failed checks");
    expect(within(crumbs).getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence");
    expect(within(crumbs).getByRole("link", { name: "acme/api" }).getAttribute("href")).toBe("/presence/places/github:acme/api");
  });

  it("orders the page: title, status line, health strip, problem, How it works, Activity, Diagnostics (Part D step 1)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ problem: PIN_TEXT })] });
    renderPage();
    const status = await screen.findByText("set up by", { exact: false });
    const title = screen.getByRole("heading", { level: 1 });
    const strip = await screen.findByRole("region", { name: "Health" });
    const problem = screen.getByRole("region", { name: "Problem" });
    const how = screen.getByRole("region", { name: "How it works" });
    const timeline = screen.getByRole("region", { name: "Activity" });
    const diagnostics = screen.getByText("Diagnostics", { selector: "summary > span" });
    const order = [title, status, strip, problem, how, timeline, diagnostics];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The fact strip, Deliveries, and Receipts are gone.
    expect(screen.queryByLabelText("Facts")).toBeNull();
    expect(screen.queryByRole("region", { name: "Deliveries" })).toBeNull();
    expect(screen.queryByText("Receipts")).toBeNull();
    expect(screen.queryByText("Runs in")).toBeNull();
  });

  it("reads the status line: name, who set it up and when, the switch, Edit, and the menu", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ createdAt: NOW - 3 * 86_400_000 })] });
    renderPage();
    const setUp = await screen.findByText("set up by", { exact: false });
    const status = setUp.parentElement;
    if (status === null) throw new Error("The status line has no row.");
    expect(within(status).getByText("Failed checks")).toBeTruthy();
    expect(setUp.textContent).toBe("set up by Conner 3d ago");
    expect(within(status).getByRole("switch", { name: "Turn off Failed checks" })).toBeTruthy();
    expect(within(status).getByText("On")).toBeTruthy();
    expect(within(status).getByRole("button", { name: "Edit" })).toBeTruthy();
    await userEvent.click(within(status).getByRole("button", { name: "More for Failed checks" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Appears as", "Delete"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Appears as" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: edit Failed checks at appears");
  });

  it("names someone as the creator the directory does not hold", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ createdBy: "u-gone" })] });
    renderPage();
    expect((await screen.findByText("set up by", { exact: false })).textContent).toMatch(/^set up by someone /);
  });

  it("reads never and 0 for a line that never acted (Review Focus 2)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    const strip = await screen.findByRole("region", { name: "Health" });
    expect(within(strip).getByText("never")).toBeTruthy();
    expect(within(strip).getByText("0")).toBeTruthy();
    expect(within(strip).getByRole("img", { name: "Activity over the last 30 days" }).querySelectorAll("span")).toHaveLength(30);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByText("Nothing yet. Activity appears here when an event reaches this line.")).toBeTruthy();
    expect(getLineActivity).toHaveBeenCalledWith("R4", { limit: 50 });
  });

  it("names the fault in the health strip", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ problem: PIN_TEXT })] });
    getLineActivity.mockResolvedValue(activity([], { lastActedAt: NOW - 2 * 3_600_000, actedLast30Days: 14 }));
    renderPage();
    const strip = await screen.findByRole("region", { name: "Health" });
    expect(within(strip).getByText("Needs attention")).toBeTruthy();
    expect(await within(strip).findByText("Platform CI is archived")).toBeTruthy();
    expect(within(strip).getByText("14")).toBeTruthy();
    expect(within(strip).getByText("2h ago")).toBeTruthy();
  });

  it("explains When, Do, and Where, and each Change opens the editor", async () => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({
        filters: [{ field: "repo", op: "eq", value: "acme/api" }, { field: "branch", op: "eq", value: "main" }],
        target: { kind: "assistant", appearance: { displayName: "SRE Bot" }, thread: { mode: "subject" } },
      })],
    });
    renderPage();
    const how = await screen.findByRole("region", { name: "How it works" });
    const columns = Array.from(how.querySelectorAll<HTMLElement>("[data-section]"));
    expect(columns.map((column) => column.textContent)).toEqual([
      "Whena check completes on acme/apiOnly the main branch.Change",
      "Dowork on it as SRE BotValet reads the event and acts in the thread. It appears as SRE Bot.Change",
      "Wherein one thread per pull requestEach pull request gets its own thread; every event for it lands there.Change",
    ]);
    fireEvent.click(within(how).getByRole("button", { name: "Change Where" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: edit Failed checks at where");
  });

  it("opens the editor on the section each Change names", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    const how = await screen.findByRole("region", { name: "How it works" });
    for (const section of ["When", "Do", "Where"]) {
      fireEvent.click(within(how).getByRole("button", { name: `Change ${section}` }));
      expect(screen.getByTestId("line-editor").textContent).toBe(`Editor: edit Failed checks at ${section.toLowerCase()}`);
    }
  });

  it("explains a pinned thread as one place for the history", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    const how = await screen.findByRole("region", { name: "How it works" });
    expect(within(how).getByText("Every event lands in this one thread, so the history stays in one place.")).toBeTruthy();
  });

  it("explains a mention line: it replies where it was mentioned, a fresh thread each time", async () => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }],
        target: { kind: "assistant", follow: true, appearance: { displayName: "Ops Bot" }, thread: { mode: "new" } },
      })],
    });
    renderPage();
    const how = await screen.findByRole("region", { name: "How it works" });
    expect(within(how).getByText("Valet reads the message and replies. It appears as Ops Bot.")).toBeTruthy();
    expect(within(how).getByText("Valet replies where it was mentioned. Every event starts a fresh thread.")).toBeTruthy();
  });

  it("explains a workflow line's Where as a run", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ target: { kind: "workflow", workflowId: "wf-1" } })] });
    renderPage();
    const how = await screen.findByRole("region", { name: "How it works" });
    expect(within(how).getByText("A workflow run has no thread. Open the run from Activity to follow it.")).toBeTruthy();
  });

  it("lists acted and skipped entries; the chips keep one kind (P18)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ problem: PIN_TEXT })] });
    getLineActivity.mockResolvedValue(activity([
      acted("d-2", { outcome: { status: "delivered", attempts: 1, thread: { sessionId: "s-ws", threadId: "t-ci", title: "Platform CI" } }, tookMs: 120_000 }),
      skipped("receipt:r-1", { place: "github:acme/web#8", placeLabel: "acme/web#8", reason: "filters", reasonText: "the repository filter" }),
      acted("d-1", { at: NOW - 180_000, outcome: { status: "dead", attempts: 3, deadText: PIN_TEXT } }),
    ]));
    renderPage();
    await screen.findByText(/worked in/);
    await waitFor(() => expect(activityRows()[2]).toContain("could not reach Platform CI, it is archived"));
    expect(activityRows()[0]).toContain("Completed check on acme/api#14 → worked in Platform CI2 min");
    expect(activityRows()[1]).toContain("Completed check on acme/web#8 → skipped, not for this line: the repository filter");
    expect(activityRows()[2]).toContain("Completed check on acme/api#14 → could not reach Platform CI, it is archivedgave up");
    const section = screen.getByRole("region", { name: "Activity" });
    await userEvent.click(within(section).getByRole("button", { name: "Skipped" }));
    expect(activityRows()).toHaveLength(1);
    expect(activityRows()[0]).toContain("skipped, not for this line");
    await userEvent.click(within(section).getByRole("button", { name: "Acted" }));
    expect(activityRows()).toHaveLength(2);
  });

  it("reads the strip's acted count as the Acted chip's entries: a dead entry counts (S9)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    // The api counts every acted delivery, dead ones too, as the timeline lists them.
    getLineActivity.mockResolvedValue(activity([
      acted("d-2", { outcome: { status: "delivered", attempts: 1, thread: { sessionId: "s-ws", threadId: "t-ci", title: "Platform CI" } }, tookMs: 40_000 }),
      acted("d-1", { at: NOW - 180_000, outcome: { status: "dead", attempts: 3, deadText: "error: HTTP 500" } }),
    ], { lastActedAt: NOW - 60_000, actedLast30Days: 2, perDay: [...Array.from({ length: 29 }, () => 0), 2] }));
    renderPage();
    await waitFor(() => expect(activityRows()).toHaveLength(2));
    const strip = screen.getByRole("region", { name: "Health" });
    expect(strip.querySelector('[data-fact="count"] [data-fact-value]')?.textContent).toBe("2");
    expect(within(strip).getByText("last acted")).toBeTruthy();
    await userEvent.click(within(screen.getByRole("region", { name: "Activity" })).getByRole("button", { name: "Acted" }));
    expect(activityRows()).toHaveLength(2);
  });

  it("shows a member only the skipped entries the api returns to a member, and no Diagnostics (Review Focus 1)", async () => {
    orgRole = "member";
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    // The api leaves out the acme/web skip for a member; the page shows what it gets.
    getLineActivity.mockResolvedValue(activity([skipped("receipt:r-2", { reason: "off" })]));
    renderPage();
    await screen.findByText(/skipped, the line was off/);
    expect(activityRows()).toHaveLength(1);
    expect(screen.queryByText(/acme\/web/)).toBeNull();
    expect(screen.queryByText("Diagnostics")).toBeNull();
    expect(listEventReceipts).not.toHaveBeenCalled();
  });

  it("shows an admin the skips outside the line's place, and Diagnostics", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    getLineActivity.mockResolvedValue(activity([
      skipped("receipt:r-1", { place: "github:acme/web#8", placeLabel: "acme/web#8", reason: "filters", reasonText: "the repository filter" }),
      skipped("receipt:r-2", { reason: "off" }),
    ]));
    renderPage();
    expect(await screen.findByRole("link", { name: "acme/web#8" })).toBeTruthy();
    expect(activityRows()).toHaveLength(2);
    expect(screen.getByText("Diagnostics", { selector: "summary > span" })).toBeTruthy();
  });

  it("loads the next page from Show earlier", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    getLineActivity.mockImplementation(async (_id, params) => (params?.before === "c-1"
      ? activity([acted("d-old", { at: NOW - 5 * 86_400_000, outcome: { status: "delivered", attempts: 1 } })])
      : activity([acted("d-new", { outcome: { status: "delivered", attempts: 1 } })], { nextCursor: "c-1" })));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Show earlier" }));
    await waitFor(() => expect(activityRows()).toHaveLength(2));
    expect(getLineActivity).toHaveBeenCalledWith("R4", { limit: 50, before: "c-1" });
  });

  it.each([
    ["a Reply line reads replied in", true, "replied in t-inc"],
    ["a mention line that works on it reads worked in", false, "worked in t-inc"],
  ])("follows the stored action in Activity: %s", async (_name, follow, words) => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }],
        target: { kind: "assistant", ...(follow ? { follow: true } : {}), thread: { mode: "new" } },
      })],
    });
    getLineActivity.mockResolvedValue(activity([acted("d-m", {
      eventKey: "slack.app_mention", place: "slack:T1/C900", placeLabel: "#incidents",
      outcome: { status: "delivered", attempts: 1, thread: { sessionId: "s", threadId: "t-inc", title: "t-inc" } },
    })]));
    renderPage();
    await waitFor(() => expect(activityRows()).toHaveLength(1));
    expect(activityRows()[0]).toContain(`Mention in #incidents → ${words}`);
  });

  it("reads a dead entry's error once, in the right column, as a sentence (S14)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    getLineActivity.mockResolvedValue(activity([acted("d-dead", { outcome: { status: "dead", attempts: 3, deadText: "error: HTTP 500 from the assistant" } })]));
    renderPage();
    await waitFor(() => expect(activityRows()).toHaveLength(1));
    expect(activityRows()[0]).toContain("Completed check on acme/api#14 → gave up after 3 triesHTTP 500 from the assistant.");
    expect(activityRows()[0]).not.toMatch(/error:/i);
  });

  it("fetches past empty pages by itself, three times, then offers Show earlier (S13)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    getLineActivity.mockImplementation(async (_id, params) => activity([], { nextCursor: `c-${Number(params?.before?.slice(2) ?? "0") + 1}` }));
    renderPage();
    expect(await screen.findByText("Nothing in the newest entries. To look further back, select Show earlier.")).toBeTruthy();
    await waitFor(() => expect(getLineActivity).toHaveBeenCalledTimes(4));
    expect(screen.getByRole("button", { name: "Show earlier" })).toBeTruthy();
    expect(getLineActivity).toHaveBeenCalledTimes(4);
  });

  it("names the fix when the activity does not load", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    getLineActivity.mockRejectedValue("offline");
    renderPage();
    expect(await screen.findByText("Could not load the activity. Reload the page to try again.")).toBeTruthy();
  });

  it("links a Slack channel line's breadcrumb to its channel", async () => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }],
        target: { kind: "assistant", thread: { mode: "new" } },
      })],
    });
    renderPage();
    const title = await screen.findByRole("heading", { level: 1, name: /#incidents/ });
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    const link = within(crumbs).getByRole("link", { name: "#incidents" });
    expect(link.getAttribute("href")).toBe("/presence/places/slack:C900");
    expect(crumbs.textContent).toBe("Presence›#incidents›Failed checks");
    // The title's place token links the same page as the crumb.
    expect(within(title).getByRole("link", { name: "#incidents" }).getAttribute("href")).toBe("/presence/places/slack:C900");
  });

  it("names an unlabeled channel by its id in both the crumb and the title (S16)", async () => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "C123" }],
        target: { kind: "assistant", thread: { mode: "new" } },
      })],
    });
    renderPage();
    const title = await screen.findByRole("heading", { level: 1, name: /C123/ });
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Presence›C123›Failed checks");
    expect(within(crumbs).getByRole("link", { name: "C123" })).toBeTruthy();
    expect(within(title).getByRole("link", { name: "C123" })).toBeTruthy();
  });

  it("puts only Presence before the line for a line with no one place", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ filters: [] })] });
    renderPage();
    await screen.findByRole("heading", { level: 1, name: /^When a check completes on any repository/ });
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Presence›Failed checks");
    expect(within(crumbs).getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence");
  });

  it("lists this line's intake trail under Diagnostics for an administrator", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    listEventReceipts.mockResolvedValue({
      receipts: [{
        id: "rc-1", service: "github", externalId: null, metadata: {}, eventKey: "github.check_run.completed", eventId: "ev-1",
        stages: [{ stage: "subscription_match", outcome: "filter_excluded", detail: "", at: 1_000 }],
        subscriptions: [{ id: "R4", ownerType: "user", ownerId: "u-001", target: "assistant", outcome: "filter_excluded" }],
        createdAt: 1_000, updatedAt: 1_000,
      }],
      nextCursor: null, lastReceiptAt: 1_000, retentionDays: 7,
    });
    renderPage();
    const summary = await screen.findByText("Diagnostics", { selector: "summary > span" });
    const receipts = summary.closest("details");
    if (receipts === null) throw new Error("Diagnostics is not a disclosure");
    expect(within(receipts).getByText("How each event came in and was matched, step by step.")).toBeTruthy();
    expect(receipts.open).toBe(false);
    expect(await within(receipts).findByText("Completed check · excluded by its filters")).toBeTruthy();
    // The last stage reads in words, not as its identifier.
    expect(within(receipts).getByText(/Presence matching: Excluded by filters/)).toBeTruthy();
    expect(within(receipts).queryByText(/filter_excluded/)).toBeNull();
    expect(listEventReceipts).toHaveBeenCalledWith({ subscriptionId: "R4", limit: 10 });
  });

  it("shows a member no Diagnostics, and reads none", async () => {
    orgRole = "member";
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    await screen.findByRole("switch", { name: "Turn off Failed checks" });
    expect(screen.queryByText("Diagnostics")).toBeNull();
    expect(listEventReceipts).not.toHaveBeenCalled();
  });

  it("shows the archived text and the picker; a pick repins the line (P7, P8)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ problem: PIN_TEXT })] });
    renderPage();
    const problem = await screen.findByRole("region", { name: "Problem" });
    expect(await within(problem).findByText("Platform CI is archived. Pick another thread:")).toBeTruthy();
    fireEvent.click(within(problem).getByRole("button", { name: "Pick Platform Ops from user" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", {
      thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ops" },
    }));
  });

  it("lists a team listener's threads in the picker and shows no problem without one", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ ownerType: "team", ownerId: "sre", problem: PIN_TEXT })] });
    renderPage();
    expect(await screen.findByRole("button", { name: "Pick Platform Ops from sre" })).toBeTruthy();
  });

  it("shows no problem for a healthy listener", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    await screen.findByRole("switch", { name: "Turn off Failed checks" });
    expect(screen.queryByRole("region", { name: "Problem" })).toBeNull();
    expect(screen.queryByText("Thread archived")).toBeNull();
  });

  it("says a team listener paused this personal listener", async () => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({ enabled: false, target: { kind: "assistant", thread: { mode: "new" }, overlapPausedAt: 5 } })],
    });
    renderPage();
    expect(await screen.findByText("Paused: the team already listens for this.")).toBeTruthy();
  });

  it("names the team that paused the line, and Keep both turns it on and stops the pause", async () => {
    const paused = listener({ enabled: false, target: { kind: "assistant", thread: { mode: "new" }, overlapPausedAt: 5, pauseOnOverlap: true } });
    const teamLine = listener({ id: "T1", name: "SRE checks", ownerType: "team", ownerId: "sre", target: { kind: "assistant", assistant: "team", teamId: "sre" } });
    listEventSubscriptions.mockResolvedValue({ subscriptions: [paused, teamLine] });
    renderPage();
    expect(await screen.findByText("Paused: SRE already listens for this.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", { pauseOnOverlap: false, enabled: true }));
  });

  it("deletes the line after the confirm, then opens Presence", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    await pickDelete();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Valet stops listening for this here. Its past activity stays.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteEventSubscription).toHaveBeenCalledWith("R4"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/presence" }));
  });

  it("names the team in a team line's Delete confirm and marks the line Team", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ ownerType: "team", ownerId: "sre" })] });
    renderPage();
    expect(await screen.findByText("Team")).toBeTruthy();
    await pickDelete();
    expect(await screen.findByText("This is SRE's line. Valet stops listening for this here. Its past activity stays.")).toBeTruthy();
  });

  it("keeps a team line read-only for a viewer outside the team and names who can change it", async () => {
    teams = [{ id: "sre", name: "SRE", callerRole: null }];
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ ownerType: "team", ownerId: "sre" })] });
    renderPage();
    expect(await screen.findByText("Only members of SRE can change this.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("switch", { name: "Turn off Failed checks" }).hasAttribute("disabled")).toBe(true);
    for (const name of ["Change When", "Change Do", "Change Where"]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
    await userEvent.click(screen.getByRole("button", { name: "More for Failed checks" }));
    for (const item of screen.getAllByRole("menuitem")) expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("names the team when its picker is hidden from a viewer outside the team", async () => {
    teams = [];
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ ownerType: "team", ownerId: "sre", problem: PIN_TEXT })] });
    renderPage();
    expect(await screen.findByText("Only members of the team can change this.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Pick Platform Ops/ })).toBeNull();
  });

  it("lets any member change an org line, as the server does", async () => {
    orgRole = "member";
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({ ownerType: "org", ownerId: "acme", createdBy: "u-002", target: { kind: "assistant", assistant: "org" } })],
    });
    renderPage();
    expect(await screen.findByText("Org")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Change When" }).hasAttribute("disabled")).toBe(false);
    await pickDelete();
    expect(await screen.findByText("This is the organization's line. Valet stops listening for this here. Its past activity stays.")).toBeTruthy();
  });

  it("reviews a proposal: what it turns off, Turn on in review, and Delete", async () => {
    const live = listener({ id: "R1", name: "Incident replies" });
    const proposal = listener({
      id: "proposal-abc", name: "Incident replies v2", enabled: false,
      target: { kind: "assistant", thread: { mode: "new" }, replaces: "R1" },
    });
    listEventSubscriptions.mockResolvedValue({ subscriptions: [live, proposal] });
    renderPage("proposal-abc");
    const section = await screen.findByRole("region", { name: "Proposal" });
    expect(within(section).getByText("Proposed by the assistant.")).toBeTruthy();
    expect(section.textContent).toContain("Turning it on turns off Incident replies.");
    expect(within(section).getByRole("link", { name: "Incident replies" }).getAttribute("href")).toBe("/presence/rules/R1");
    // The proposal sits above the health strip, and its switch gives way to Turn on.
    const strip = await screen.findByRole("region", { name: "Health" });
    expect(section.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Turn on" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: review Incident replies v2 replaces Incident replies");
    fireEvent.click(within(section).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteEventSubscription).toHaveBeenCalledWith("proposal-abc"));
  });

  it.each([
    ["deleted", [] as EventSubscriptionWire[]],
    ["off", [listener({ id: "R1", name: "Incident replies", enabled: false })]],
  ])("offers Delete only for a proposal whose replaced line is %s (S6)", async (_state, others) => {
    const proposal = listener({
      id: "proposal-abc", name: "Incident replies v2", enabled: false,
      target: { kind: "assistant", thread: { mode: "new" }, replaces: "R1" },
    });
    listEventSubscriptions.mockResolvedValue({ subscriptions: [...others, proposal] });
    renderPage("proposal-abc");
    const section = await screen.findByRole("region", { name: "Proposal" });
    expect(section.textContent).toContain("The line this proposal replaces is gone. Delete this proposal and make a new line.");
    expect(section.textContent).not.toContain("Turning it on turns off");
    expect(within(section).queryByRole("button", { name: "Turn on" })).toBeNull();
    expect(within(section).getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("reads a line that is only off as off, not as a proposal", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ enabled: false, updatedAt: 9 })] });
    renderPage();
    await screen.findByRole("switch", { name: "Turn on Failed checks" });
    expect(screen.queryByRole("region", { name: "Proposal" })).toBeNull();
  });

  it("names the fix when the listener is not in the list", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [] });
    renderPage("gone");
    expect(await screen.findByText("This page does not exist, or you cannot see it.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Presence" }).getAttribute("href")).toBe("/presence");
  });
});
