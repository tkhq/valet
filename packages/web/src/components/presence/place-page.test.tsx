// @vitest-environment jsdom
/**
 * The place page (docs/specs/2026-10-16-presence-hub-design.md Part C;
 * acceptance P3, P4, P5, P8): the sections in order, each line as a
 * sentence with its switch, overflow menu, and inline problem, **Listen
 * for…** opening the wizard on this place, and the threads.
 *
 * The api client is mocked at the transport, so the real query hooks run:
 * the page read carries the switcher's workspace as `scope`, and a pinned
 * thread's title comes from the thread list read.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  EventSubscriptionWire,
  ListThreadsResponse,
  PatchEventSubscriptionRequest,
  PresencePlaceDetailResponse,
} from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, search, children, className }: {
    to: string; params?: Record<string, string>; search?: Record<string, string>; children: ReactNode; className?: string;
  }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, value), to);
    const query = new URLSearchParams(search ?? {}).toString();
    return <a href={query ? `${path}?${query}` : path} className={className}>{children}</a>;
  },
}));

const getPresencePlace = vi.fn<(scope: string, subject: string) => Promise<PresencePlaceDetailResponse>>();
type ListThreadsOpts = { threadId?: string; archived?: boolean };
const listThreads = vi.fn<(sessionId: string, opts?: ListThreadsOpts) => Promise<ListThreadsResponse>>();
const patchEventSubscription = vi.fn<(id: string, body: PatchEventSubscriptionRequest) => Promise<EventSubscriptionWire>>();
const deleteEventSubscription = vi.fn<(id: string) => Promise<void>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getPresencePlace: (scope: string, subject: string) => getPresencePlace(scope, subject),
      listThreads: (sessionId: string, opts?: ListThreadsOpts) => listThreads(sessionId, opts),
      patchEventSubscription: (id: string, body: PatchEventSubscriptionRequest) => patchEventSubscription(id, body),
      deleteEventSubscription: (id: string) => deleteEventSubscription(id),
    },
  };
});

vi.mock("~/api/workflows", () => ({
  useTriggerCatalog: () => ({ data: { catalog: [] } }),
  useWorkflows: () => ({ data: { workflows: [{ id: "wf-1", name: "Incident triage" }] } }),
}));

let scopeTeamId: string | undefined;
vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: scopeTeamId ?? "user", teamId: scopeTeamId, available: ["user"], setKey: () => {} }),
}));

/** The wizard is its own suite's; here it records the place it opened on. */
const wizardProps = vi.fn();
vi.mock("~/components/presence/editor/line-editor", async () => (await import("~/components/presence/editor/test-editor-stub")).stubModule);

let meId = "u-001";
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: meId, orgId: "acme", orgRole: "member" } }),
  useOrgDirectory: () => ({ data: { users: [] } }),
  useTeams: () => ({ data: { teams: [] } }),
}));


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

import { PlacePage } from "./place-page";
import { visibleText } from "./test-fixtures";

const PIN_TEXT = "Pick another thread in Presence.";

function listener(id: string, over: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id,
    name: id,
    ownerType: "user",
    ownerId: "u-001",
    eventKeys: [],
    filters: [],
    target: { kind: "assistant" },
    enabled: true,
    createdBy: "u-001",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const R1 = listener("R1", {
  eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
  filters: [{ field: "repo", op: "eq", value: "acme/api" }],
  target: { kind: "assistant", thread: { mode: "subject" } },
});
const R4 = listener("R4", {
  name: "Failed checks",
  eventKeys: ["github.check_run.completed"],
  filters: [{ field: "repo", op: "eq", value: "acme/api" }],
  target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ci" } },
});

function conversation(threadId: string, title: string) {
  return { sessionId: "s-ws", threadId, title, lastActivityAt: 1_000 };
}

const ACME_API: PresencePlaceDetailResponse = {
  place: {
    subject: "github:acme/api", label: "acme/api", scopeLabel: "Across acme/api", service: "github",
    parent: null, listenerCount: 2, activeThreadCount: 0, lastActivityAt: 1_000,
  },
  listeners: [R1, R4],
  threads: {
    subject: [conversation("t-12", "acme/api#12"), conversation("t-13", "acme/api#13")],
    following: [],
    active: [],
  },
  activity: [{
    id: "ev-1", service: "github", eventKey: "github.check_run.completed", summary: "CI failed on main",
    refs: { repo: "acme/api" }, actor: null, occurredAt: 1_000, receivedAt: 1_000,
  }],
};

const INCIDENTS: PresencePlaceDetailResponse = {
  place: {
    subject: "slack:T1/C900", label: "#incidents", service: "slack",
    parent: "slack:T1", listenerCount: 2, activeThreadCount: 1, lastActivityAt: 2_000,
  },
  listeners: [
    listener("M", {
      ownerType: "team", ownerId: "sre", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }],
      target: { kind: "assistant", follow: true, assistant: "team", teamId: "sre", appearance: { displayName: "SRE Bot" }, thread: { mode: "new" } },
    }),
    listener("P", {
      ownerType: "team", ownerId: "sre", eventKeys: ["slack.message"],
      filters: [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }],
      target: { kind: "assistant", assistant: "team", teamId: "sre", thread: { mode: "existing", sessionId: "s-ws", threadId: "t-inc" } },
    }),
  ],
  threads: {
    subject: [],
    following: [{ ...conversation("t-inc", "t-inc"), url: "https://acme.slack.com/archives/C900/p1" }],
    active: [conversation("t-inc", "t-inc")],
  },
  activity: [],
};

function renderPage(subject: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PlacePage subject={subject} /></QueryClientProvider>);
}

beforeEach(() => {
  scopeTeamId = undefined;
  getPresencePlace.mockReset();
  listThreads.mockReset();
  patchEventSubscription.mockReset();
  deleteEventSubscription.mockReset();
  meId = "u-001";
  patchEventSubscription.mockImplementation(async (id, body) => ({ ...R4, id, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}) }));
  deleteEventSubscription.mockResolvedValue(undefined);
  listThreads.mockResolvedValue({
    threads: [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1 }],
  });
});

/** A sentence with reference tokens spans several elements; this matches the
 * innermost element whose whole text is the sentence. */
function sentenceText(sentence: string) {
  return (_content: string, element: Element | null) =>
    visibleText(element) === sentence && ![...(element?.children ?? [])].some((child) => visibleText(child) === sentence);
}

function sectionsInOrder(names: readonly string[]) {
  const sections = names.map((name) => screen.getByRole("region", { name }));
  for (let i = 1; i < sections.length; i++) {
    expect(sections[i - 1]!.compareDocumentPosition(sections[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  return sections;
}

describe("PlacePage", () => {
  it("titles the page by a neutral word, never the raw key, until the place loads or when it fails", async () => {
    let fail: (err: Error) => void = () => {};
    getPresencePlace.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    renderPage("slack:T1/C900");
    expect(screen.getByRole("heading", { level: 1, name: "Loading…" })).toBeTruthy();
    expect(screen.queryByText("slack:T1/C900")).toBeNull();
    fail(new Error("boom"));
    expect(await screen.findByRole("heading", { level: 1, name: "Not available" })).toBeTruthy();
    expect(screen.queryByText("slack:T1/C900")).toBeNull();
  });

  it("sends the reader back to Presence when the place does not load", async () => {
    getPresencePlace.mockReturnValue(Promise.reject("offline"));
    renderPage("slack:T1/C900");
    expect(await screen.findByText("Could not load this place. Open Presence and pick the place again.")).toBeTruthy();
  });

  it("shows the header, Valet here, Threads, and Recent activity in order (P3)", async () => {
    getPresencePlace.mockResolvedValue(ACME_API);
    renderPage("github:acme/api");
    const heading = await screen.findByRole("heading", { level: 1, name: "acme/api" });
    expect(getPresencePlace).toHaveBeenCalledWith("user", "github:acme/api");
    // The subtitle is the service alone.
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByText(/Across acme\/api/)).toBeNull();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Presence›acme/api");

    const [here, threadsSection, activity] = sectionsInOrder(["Valet here", "Threads", "Recent activity"]);
    expect(heading.compareDocumentPosition(here!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const r1 = within(here!).getByText(sentenceText("When a pull request review or a check completes on acme/api, work in one thread per pull request."));
    expect(r1.closest("a")?.getAttribute("href")).toBe("/presence/rules/R1");
    // The place and the pinned thread read as tokens inside the line's link.
    expect(visibleText(r1.querySelector('[data-ref="place"]'))).toBe("acme/api");
    expect(await within(here!).findByText(sentenceText("When a check completes on acme/api, work in the Platform CI thread."))).toBeTruthy();
    expect(listThreads).toHaveBeenCalledWith("s-ws", { threadId: "t-ci" });

    const subjectThreads = within(threadsSection!).getByRole("list", { name: "One thread per pull request" });
    expect(within(subjectThreads).getByRole("link", { name: "acme/api#12" }).getAttribute("href")).toBe("/threads/t-12");
    expect(within(subjectThreads).getByRole("link", { name: "acme/api#13" })).toBeTruthy();

    expect(within(activity!).getByRole("link", { name: "Completed check in acme/api" }).getAttribute("href")).toBe("/presence/events/ev-1");
    // View all opens Activity filtered to this place by its key.
    expect(within(activity!).getByRole("link", { name: "View all" }).getAttribute("href")).toBe("/presence/activity?place=github%3Aacme%2Fapi");
    // The header carries the service's large mark.
    expect(heading.parentElement?.querySelector('[data-service="github"][data-size="lg"]')).not.toBeNull();

    // No line here sets an appearance, so that section is absent.
    expect(screen.queryByRole("region", { name: "Appears as" })).toBeNull();
  });

  it("names a Linear team's subject threads by issue", async () => {
    getPresencePlace.mockResolvedValue({
      ...ACME_API,
      place: { ...ACME_API.place, subject: "linear:team/ENG", label: "ENG", service: "linear" },
      listeners: [],
      threads: { subject: [conversation("t-42", "ENG-42")], following: [], active: [] },
    });
    renderPage("linear:team/ENG");
    expect(await screen.findByRole("list", { name: "One thread per issue" })).toBeTruthy();
  });

  it("shows ten activity rows at most", async () => {
    const events = Array.from({ length: 12 }, (_, i) => ({ ...ACME_API.activity[0]!, id: `ev-${i}` }));
    getPresencePlace.mockResolvedValue({ ...ACME_API, activity: events });
    renderPage("github:acme/api");
    const activity = await screen.findByRole("region", { name: "Recent activity" });
    expect(within(activity).getAllByRole("link", { name: "Completed check in acme/api" })).toHaveLength(10);
  });

  it("names a recent event by this page's place, not the event's channel id", async () => {
    getPresencePlace.mockResolvedValue({
      ...INCIDENTS,
      activity: [{
        id: "ev-m", service: "slack", eventKey: "slack.app_mention", summary: "app mentioned in C900 by U1",
        refs: { channel: "C900" }, actor: null, occurredAt: 1_000, receivedAt: 1_000,
      }],
    });
    renderPage("slack:T1/C900");
    const activity = await screen.findByRole("region", { name: "Recent activity" });
    expect(within(activity).getByRole("link", { name: "Mention in #incidents" })).toBeTruthy();
    expect(within(activity).queryByText(/in C900$/)).toBeNull();
  });

  it("names an archived pinned thread, as the line's page does", async () => {
    // The open list leaves the archived thread out; the archived list has it.
    listThreads.mockImplementation(async (_sessionId, opts) => ({
      threads: opts?.archived
        ? [{ id: "t-ci", sessionId: "s-ws", title: "Old CI", createdAt: 1, lastUserActivityAt: 1 }]
        : [],
    }));
    getPresencePlace.mockResolvedValue(ACME_API);
    renderPage("github:acme/api");
    const here = await screen.findByRole("region", { name: "Valet here" });
    expect(await within(here).findByText(sentenceText("When a check completes on acme/api, work in the Old CI thread."))).toBeTruthy();
    expect(listThreads).toHaveBeenCalledWith("s-ws", { threadId: "t-ci", archived: true });
  });

  it("reads the team workspace's place, with Threads, Appears as, and Recent activity in order (P4)", async () => {
    scopeTeamId = "sre";
    getPresencePlace.mockResolvedValue(INCIDENTS);
    renderPage("slack:T1/C900");
    await screen.findByRole("heading", { level: 1, name: "#incidents" });
    expect(getPresencePlace).toHaveBeenCalledWith("sre", "slack:T1/C900");

    const [here, , appearsAs] = sectionsInOrder(["Valet here", "Threads", "Appears as", "Recent activity"]);
    expect(within(here!).getByText(sentenceText("When someone mentions Valet in #incidents, reply in a new thread, as SRE Bot."))).toBeTruthy();
    expect(within(here!).getByText(sentenceText("When someone posts a message in #incidents, work in the t-inc thread."))).toBeTruthy();

    expect(within(appearsAs!).getByText("SRE Bot")).toBeTruthy();
    expect(within(appearsAs!).getByRole("link", { name: "M" }).getAttribute("href")).toBe("/presence/rules/M");

    expect(within(screen.getByRole("list", { name: "Active now" })).getByRole("link", { name: "t-inc" }).getAttribute("href")).toBe("/threads/t-inc");
    const following = within(screen.getByRole("list", { name: "Following" }));
    expect(following.getByRole("link", { name: "t-inc" })).toBeTruthy();
    expect(following.getByRole("link", { name: /Slack thread/ }).getAttribute("href")).toBe("https://acme.slack.com/archives/C900/p1");
  });

  it("reads the place once when the URL's key differs from the place's key", async () => {
    getPresencePlace.mockResolvedValue(INCIDENTS);
    renderPage("slack:C900");
    expect(await screen.findByRole("heading", { level: 1, name: "#incidents" })).toBeTruthy();
    await screen.findByRole("button", { name: "Listen for…" });
    expect(getPresencePlace.mock.calls).toEqual([["user", "slack:C900"]]);
  });

  it("opens the editor on this place from Listen for… (P5)", async () => {
    getPresencePlace.mockResolvedValue(INCIDENTS);
    renderPage("slack:T1/C900");
    fireEvent.click(await screen.findByRole("button", { name: "Listen for…" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: create place slack:T1/C900");
  });

  it("turns a line off and on from its switch", async () => {
    getPresencePlace.mockResolvedValue({ ...ACME_API, listeners: [R4, { ...R1, enabled: false }] });
    renderPage("github:acme/api");
    fireEvent.click(await screen.findByRole("switch", { name: "Turn off Failed checks" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", { enabled: false }));
    fireEvent.click(screen.getByRole("switch", { name: "Turn on R1" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R1", { enabled: true }));
  });

  it("offers Edit, Appears as, and Delete in a line's overflow menu", async () => {
    const user = userEvent.setup();
    getPresencePlace.mockResolvedValue(ACME_API);
    renderPage("github:acme/api");

    await user.click(await screen.findByRole("button", { name: "More for Failed checks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: edit Failed checks");
  });

  it("opens the editor on Appears as from Appears as", async () => {
    const user = userEvent.setup();
    getPresencePlace.mockResolvedValue(ACME_API);
    renderPage("github:acme/api");

    await user.click(await screen.findByRole("button", { name: "More for Failed checks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Appears as" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: edit Failed checks at appears");
  });

  it("asks before Delete, then deletes the line", async () => {
    const user = userEvent.setup();
    getPresencePlace.mockResolvedValue(ACME_API);
    renderPage("github:acme/api");

    await user.click(await screen.findByRole("button", { name: "More for Failed checks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete \"Failed checks\"?" });
    expect(within(dialog).getByText("Valet stops listening for this here. Its past activity stays.")).toBeTruthy();
    expect(deleteEventSubscription).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteEventSubscription).toHaveBeenCalledWith("R4"));
  });

  it("opens a line's picker from Pick another thread; a pick repins the line (P3, P8)", async () => {
    getPresencePlace.mockResolvedValue({ ...ACME_API, listeners: [R1, { ...R4, problem: PIN_TEXT }] });
    renderPage("github:acme/api");
    const here = await screen.findByRole("region", { name: "Valet here" });
    // The row keeps the picker closed until the reader asks for it.
    expect(within(here).queryByRole("group", { name: "Problem" })).toBeNull();
    fireEvent.click(within(here).getByRole("button", { name: "Pick another thread" }));
    const problem = within(here).getByRole("group", { name: "Problem" });
    expect(await within(problem).findByText("Platform CI is archived. Pick another thread:")).toBeTruthy();
    fireEvent.click(within(problem).getByRole("button", { name: "Pick Platform Ops from user" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", {
      thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ops" },
    }));
  });

  it("says a team line paused this personal line", async () => {
    getPresencePlace.mockResolvedValue({
      ...ACME_API,
      listeners: [{ ...R1, enabled: false, target: { kind: "assistant", thread: { mode: "subject" }, overlapPausedAt: 5 } }],
    });
    renderPage("github:acme/api");
    const here = await screen.findByRole("region", { name: "Valet here" });
    expect(within(here).getByRole("status").textContent).toBe("Paused: the team already listens for this.");
  });

  it("hides the picker and disables the controls on another member's personal line", async () => {
    const user = userEvent.setup();
    meId = "u-002";
    getPresencePlace.mockResolvedValue({ ...ACME_API, listeners: [{ ...R4, problem: PIN_TEXT }] });
    renderPage("github:acme/api");
    const here = await screen.findByRole("region", { name: "Valet here" });
    expect(await within(here).findByText("Platform CI is archived. Pick another thread:")).toBeTruthy();
    expect(within(here).queryByRole("button", { name: /^Pick / })).toBeNull();
    expect(within(here).getByText("Only its owner can change this.")).toBeTruthy();
    expect(within(here).getByRole("switch", { name: "Turn off Failed checks" })).toHaveProperty("disabled", true);
    await user.click(within(here).getByRole("button", { name: "More for Failed checks" }));
    for (const name of ["Edit", "Appears as", "Delete"]) {
      expect((await screen.findByRole("menuitem", { name })).getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("says when nothing is set up or works here", async () => {
    getPresencePlace.mockResolvedValue({
      ...ACME_API,
      place: { ...ACME_API.place, listenerCount: 0, scopeLabel: undefined },
      listeners: [],
      threads: { subject: [], following: [], active: [] },
      activity: [],
    });
    renderPage("github:acme/api");
    const here = await screen.findByRole("region", { name: "Valet here" });
    expect(within(here).getByText("Nothing is set up here yet.")).toBeTruthy();
    expect(within(here).getByRole("button", { name: "Listen for…" })).toBeTruthy();
    expect(screen.getByText("No Valet thread works here yet.")).toBeTruthy();
    expect(screen.getByText("Nothing happened here in the last 30 days.")).toBeTruthy();
  });

  it("shows the server's refusal when the read fails", async () => {
    const { ApiError } = await import("~/api/client");
    const text = "Valet is not present in that place in this workspace. Open Places to see where it is.";
    getPresencePlace.mockRejectedValue(new ApiError(404, text, { error: text }));
    renderPage("github:acme/nothing");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Valet is not present in that place in this workspace. Open Places to see where it is.",
    );
  });
});
