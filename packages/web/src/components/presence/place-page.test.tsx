// @vitest-environment jsdom
/**
 * The place page (docs/specs/2026-10-16-presence-hub-design.md Part B step 3;
 * acceptance H3, H4, H5): the five sections in order, the listener
 * sentences, **Add** opening the wizard on this place, and the threads.
 *
 * The api client is mocked at the transport, so the real query hooks run:
 * the page read carries the switcher's workspace as `scope`, and a pinned
 * thread's title comes from the thread list read.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  EventSubscriptionWire,
  ListThreadsResponse,
  PresencePlaceDetailResponse,
} from "@valet/api/wire";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: ReactNode; className?: string }) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return <a href={href} className={className}>{children}</a>;
  },
}));

const getPresencePlace = vi.fn<(scope: string, subject: string) => Promise<PresencePlaceDetailResponse>>();
const listThreads = vi.fn<(sessionId: string, opts?: { fixedIds?: string[]; fixedOnly?: boolean }) => Promise<ListThreadsResponse>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getPresencePlace: (scope: string, subject: string) => getPresencePlace(scope, subject),
      listThreads: (sessionId: string, opts?: { fixedIds?: string[]; fixedOnly?: boolean }) => listThreads(sessionId, opts),
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
vi.mock("~/components/events/automation-wizard", () => ({
  AutomationWizard: (props: { preselectedPlace?: { subject: string; service: string; label: string } }) => {
    wizardProps(props);
    return <p>Wizard for {props.preselectedPlace?.label}</p>;
  },
}));

import { PlacePage } from "./place-page";

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
      target: { kind: "assistant", assistant: "team", teamId: "sre", appearance: { displayName: "SRE Bot" }, thread: { mode: "new" } },
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
  wizardProps.mockReset();
  listThreads.mockResolvedValue({
    threads: [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1 }],
  });
});

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

  it("shows the header, Listeners, Threads, and Recent activity in order (H3)", async () => {
    getPresencePlace.mockResolvedValue(ACME_API);
    renderPage("github:acme/api");
    const heading = await screen.findByRole("heading", { level: 1, name: "acme/api" });
    expect(getPresencePlace).toHaveBeenCalledWith("user", "github:acme/api");
    expect(screen.getByText("GitHub · Across acme/api")).toBeTruthy();

    const listeners = screen.getByRole("region", { name: "Listeners" });
    expect(within(listeners).getByText(
      "Listens on acme/api for pull request reviews and completed checks · works in one thread per pull request",
    )).toBeTruthy();
    expect(await within(listeners).findByText("Listens on acme/api for completed checks · works in the thread Platform CI")).toBeTruthy();
    expect(listThreads).toHaveBeenCalledWith("s-ws", { fixedIds: ["t-ci"], fixedOnly: true });

    const threads = screen.getByRole("list", { name: "Threads for acme/api" });
    expect(within(threads).getByRole("link", { name: "acme/api#12" }).getAttribute("href")).toBe("/threads/t-12");
    expect(within(threads).getByRole("link", { name: "acme/api#13" })).toBeTruthy();

    const activity = screen.getByRole("region", { name: "Recent activity" });
    expect(within(activity).getByRole("link", { name: "Completed check in acme/api" }).getAttribute("href")).toBe("/presence/events/ev-1");

    // No listener here sets an appearance, so that section is absent.
    expect(screen.queryByRole("region", { name: "Appears as" })).toBeNull();
    const order = [heading, listeners, screen.getByRole("region", { name: "Threads" }), activity];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("reads the team workspace's place, with Appears as, Following, and Active now in order (H4)", async () => {
    scopeTeamId = "sre";
    getPresencePlace.mockResolvedValue(INCIDENTS);
    renderPage("slack:T1/C900");
    await screen.findByRole("heading", { level: 1, name: "#incidents" });
    expect(getPresencePlace).toHaveBeenCalledWith("sre", "slack:T1/C900");

    const sections = ["Listeners", "Appears as", "Threads", "Recent activity"].map((name) => screen.getByRole("region", { name }));
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i - 1]!.compareDocumentPosition(sections[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const listeners = within(sections[0]!);
    expect(listeners.getByText("Listens in #incidents for mentions · replies in a new thread · as SRE Bot")).toBeTruthy();
    expect(listeners.getByText("Listens in #incidents for messages · works in the thread t-inc")).toBeTruthy();

    const appears = within(sections[1]!);
    expect(appears.getByText("SRE Bot")).toBeTruthy();
    expect(appears.getByRole("link", { name: "M" }).getAttribute("href")).toBe("/presence/listeners/M");

    expect(within(screen.getByRole("list", { name: "Active now" })).getByRole("link", { name: "t-inc" }).getAttribute("href")).toBe("/threads/t-inc");
    const following = within(screen.getByRole("list", { name: "Following" }));
    expect(following.getByRole("link", { name: "t-inc" })).toBeTruthy();
    expect(following.getByRole("link", { name: /Slack thread/ }).getAttribute("href")).toBe("https://acme.slack.com/archives/C900/p1");
  });

  it("opens the wizard on this place from Add (H5)", async () => {
    getPresencePlace.mockResolvedValue(INCIDENTS);
    renderPage("slack:T1/C900");
    fireEvent.click(await screen.findByRole("button", { name: "Add a listener in #incidents" }));
    expect(screen.getByText("Wizard for #incidents")).toBeTruthy();
    expect(wizardProps).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true,
      preselectedPlace: { subject: "slack:T1/C900", service: "slack", label: "#incidents" },
    }));
  });

  it("says when nothing listens or works here", async () => {
    getPresencePlace.mockResolvedValue({
      ...ACME_API,
      place: { ...ACME_API.place, listenerCount: 0, scopeLabel: undefined },
      listeners: [],
      threads: { subject: [], following: [], active: [] },
      activity: [],
    });
    renderPage("github:acme/api");
    expect(await screen.findByText("No listener here yet. Select Add to create one.")).toBeTruthy();
    expect(screen.getByText("No Valet thread works here yet.")).toBeTruthy();
    expect(screen.getByText("Nothing happened here in the last 30 days.")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
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
