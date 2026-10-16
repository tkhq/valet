// @vitest-environment jsdom
/**
 * Background work in the web UI (spec 2026-10-08, review UI placement):
 * the composer status line ("next wakeup in 26m · 1 process · +1 in other
 * threads"), its list of the work with a Cancel per row behind a confirm
 * step that names the reason, the thread card section, and the thread
 * list's timer line.
 */
import type { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListSessionWakeupsResponse } from "@valet/api/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "~/api/client";
import { qk } from "~/api/queries";
import { TooltipProvider } from "~/components/primitives";
import {
  BackgroundWorkSection,
  BackgroundWorkStatusLine,
  ThreadEventLine,
  ThreadTimerLine,
  backgroundItems,
  eventSectionDetail,
  itemDetail,
  nextEventLabel,
  sectionDetail,
  statusLine,
  statusLineText,
  threadEventWaits,
  threadTimerWaits,
  timeSince,
  timeUntil,
} from "./background-work";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

function listing(now: number): ListSessionWakeupsResponse {
  return {
    wakeups: [
      { id: "wk_1", threadId: "th-1", kind: "process", status: "running", reason: "full proof build", deadlineAt: now + 30 * HOUR, createdAt: now - HOUR },
      { id: "wk_2", threadId: "th-1", kind: "timer", status: "pending", reason: "check CI", fireAt: now + 2 * HOUR, createdAt: now },
      { id: "wk_3", threadId: "th-2", kind: "watch", status: "running", reason: "secret deploy watch", deadlineAt: now + 4 * HOUR, createdAt: now },
    ],
    leases: [
      { id: "ls_1", threadId: "th-1", ownerKind: "process", ownerId: "wk_1", reason: "full proof build", deadlineAt: now + 30 * HOUR, createdAt: now - HOUR },
      { id: "ls_2", threadId: "th-1", ownerKind: "hold", reason: "terminal work", deadlineAt: now + 3 * HOUR, createdAt: now },
    ],
  };
}

function eventListing(now: number): ListSessionWakeupsResponse {
  return {
    wakeups: [
      {
        id: "wk_e1",
        threadId: "th-1",
        kind: "event",
        status: "running",
        reason: "wait for the check run",
        deadlineAt: now + 20 * HOUR,
        subject: "github:acme/lean-proofs#42",
        subjectLabel: "acme/lean-proofs#42",
        subjectUrl: "https://github.com/acme/lean-proofs/issues/42",
        clauseCount: 2,
        createdAt: now,
      },
    ],
    leases: [],
  };
}

function wrap(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    ),
  };
}

function renderLine(threadId: string | undefined = "th-1", canCancel = true) {
  const { client, wrapper } = wrap();
  return { client, ...render(<BackgroundWorkStatusLine sessionId="s-1" threadId={threadId} canCancel={canCancel} />, { wrapper }) };
}

afterEach(() => vi.restoreAllMocks());

describe("background work helpers", () => {
  it("lists wakeups and holds with their thread, and hides a process lease behind its wakeup", () => {
    const items = backgroundItems(listing(NOW));
    expect(items.map((i) => [i.id, i.threadId])).toEqual([["wk_1", "th-1"], ["wk_2", "th-1"], ["wk_3", "th-2"], ["ls_2", "th-1"]]);
    expect(backgroundItems(undefined)).toEqual([]);
  });

  it("counts the open thread's work per kind and counts the rest without names", () => {
    const line = statusLine(backgroundItems(listing(NOW)), "th-1", NOW);
    // The timer fires in 2h, before the hold's 3h deadline.
    expect(statusLineText(line)).toBe("next wakeup in 2h · 1 process · 1 timer · 1 hold · +1 in other threads");
    expect(statusLineText(line)).not.toContain("secret deploy watch");
  });

  it("puts every item in the other-thread count when another thread is open", () => {
    const line = statusLine(backgroundItems(listing(NOW)), "th-2", NOW);
    expect(statusLineText(line)).toBe("next deadline in 4h · 1 watch · +3 in other threads");
  });

  it("names the soonest event of all work when the open thread has none", () => {
    expect(statusLineText(statusLine(backgroundItems(listing(NOW)), "th-9", NOW))).toBe("next wakeup in 2h · +4 in other threads");
    expect(nextEventLabel([], NOW)).toBeUndefined();
  });

  it("uses plural nouns for counts above one", () => {
    const items = backgroundItems({
      wakeups: [
        { id: "a", threadId: "t", kind: "process", status: "running", reason: "a", createdAt: NOW },
        { id: "b", threadId: "t", kind: "process", status: "running", reason: "b", createdAt: NOW },
      ],
      leases: [],
    });
    expect(statusLineText(statusLine(items, "t", NOW))).toBe("2 processes");
  });

  it("rounds a time to the nearest unit (fix wave 4, L2)", () => {
    expect(timeUntil(NOW + 47 * HOUR, NOW)).toBe("in 2d");
    expect(timeUntil(NOW + 90 * MINUTE, NOW)).toBe("in 2h");
    expect(timeUntil(NOW + 59.6 * MINUTE, NOW)).toBe("in 1h");
    expect(timeUntil(NOW + 23.7 * HOUR, NOW)).toBe("in 1d");
    expect(timeUntil(NOW + 10 * MINUTE, NOW)).toBe("in 10m");
    expect(timeUntil(NOW + 3 * 24 * HOUR, NOW)).toBe("in 3d");
    expect(timeUntil(NOW - 1, NOW)).toBe("now");
  });

  it("shows how long a process has run, and starting while it is pending (fix wave 3, L2)", () => {
    const [proc, timer, , hold] = backgroundItems(listing(NOW));
    expect(proc && itemDetail(proc, NOW)).toBe("Process · running 1h · deadline in 1d");
    expect(timer && itemDetail(timer, NOW)).toBe("Timer · fires in 2h");
    expect(hold && itemDetail(hold, NOW)).toBe("Hold · running under 1m · deadline in 3h");
    expect(proc && itemDetail({ ...proc, status: "pending" }, NOW)).toBe("Process · starting · deadline in 1d");
    expect(timeSince(NOW - 49 * HOUR, NOW)).toBe("2d");
  });

  it("gives the card a state word per kind: waiting, held, running, starting", () => {
    const [proc, timer, , hold] = backgroundItems(listing(NOW));
    expect(timer && sectionDetail(timer, NOW)).toBe("Timer · waiting · fires in 2h");
    expect(hold && sectionDetail(hold, NOW)).toBe("Hold · held · deadline in 3h");
    expect(proc && sectionDetail(proc, NOW)).toBe("Process · running · deadline in 1d");
    expect(proc && sectionDetail({ ...proc, status: "pending" }, NOW)).toBe("Process · starting · deadline in 1d");
  });

  it("keeps the soonest timer of each thread, and only timers", () => {
    const data = listing(NOW);
    data.wakeups.push({ id: "wk_4", threadId: "th-1", kind: "timer", status: "pending", reason: "sooner", fireAt: NOW + HOUR, createdAt: NOW });
    const waits = threadTimerWaits(data);
    expect([...waits.entries()]).toEqual([["th-1", NOW + HOUR]]);
    expect(threadTimerWaits(undefined).size).toBe(0);
  });

  it("keeps an event waiter's subject, link, and clause count", () => {
    const items = backgroundItems(eventListing(NOW));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "event",
      subjectLabel: "acme/lean-proofs#42",
      subjectUrl: "https://github.com/acme/lean-proofs/issues/42",
      clauseCount: 2,
    });
  });

  it("the composer line shows a single event waiter by its subject, not a count", () => {
    const items = backgroundItems(eventListing(NOW));
    const line = statusLine(items, "th-1", NOW);
    expect(line.eventWait).toEqual({ id: "wk_e1", label: "acme/lean-proofs#42", moreCount: 0 });
    expect(statusLineText(line)).toBe("next deadline in 20h · waiting on acme/lean-proofs#42");
  });

  it("collapses several event waiters to the oldest one's subject plus a count (fix round 1)", () => {
    const data = eventListing(NOW);
    data.wakeups.push(
      { id: "wk_e2", threadId: "th-1", kind: "event", status: "running", reason: "wait 2", subjectLabel: "acme/other#1", deadlineAt: NOW + 5 * HOUR, createdAt: NOW + MINUTE },
      { id: "wk_e3", threadId: "th-1", kind: "event", status: "running", reason: "wait 3", subjectLabel: "acme/third#9", deadlineAt: NOW + 5 * HOUR, createdAt: NOW - MINUTE },
    );
    const line = statusLine(backgroundItems(data), "th-1", NOW);
    // wk_e3 is oldest (createdAt NOW - MINUTE), so it names the line; the other two collapse into "+2 more".
    expect(line.eventWait).toEqual({ id: "wk_e3", label: "acme/third#9", moreCount: 2 });
    expect(statusLineText(line)).toContain("waiting on acme/third#9 +2 more");
  });

  it("counts other threads' work the same whether the open thread has one or several event waiters", () => {
    const data = eventListing(NOW);
    data.wakeups.push(
      { id: "wk_e2", threadId: "th-1", kind: "event", status: "running", reason: "wait 2", subjectLabel: "acme/other#1", deadlineAt: NOW + 5 * HOUR, createdAt: NOW + MINUTE },
      { id: "wk_other", threadId: "th-2", kind: "watch", status: "running", reason: "other thread watch", deadlineAt: NOW + 4 * HOUR, createdAt: NOW },
    );
    const line = statusLine(backgroundItems(data), "th-1", NOW);
    expect(line.otherCount).toBe(1);
    expect(statusLineText(line)).not.toContain("acme/other#1");
  });

  it("the card section's event detail names the subject, clause count, and deadline", () => {
    const [item] = backgroundItems(eventListing(NOW));
    expect(item && eventSectionDetail(item, NOW)).toEqual({
      label: "acme/lean-proofs#42",
      clauses: "2 clauses",
      deadline: "deadline in 20h",
    });
  });

  it("keeps the first event waiter's subject label per thread", () => {
    const data = eventListing(NOW);
    const waits = threadEventWaits(data);
    expect([...waits.entries()]).toEqual([["th-1", "acme/lean-proofs#42"]]);
    expect(threadEventWaits(undefined).size).toBe(0);
  });
});

describe("BackgroundWorkStatusLine", () => {
  it("renders nothing while the session has no background work", async () => {
    const list = vi.spyOn(api, "listSessionWakeups").mockResolvedValue({ wakeups: [], leases: [] });
    const { container } = renderLine();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("appears with work and disappears when the work ends", async () => {
    const list = vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    const { client } = renderLine();
    const line = await screen.findByRole("button", { name: /^Background work: / });
    expect(line.textContent).toContain("next wakeup in 2h");
    expect(line.textContent).toContain("1 process");
    expect(line.textContent).toContain("1 hold");
    expect(line.textContent).toContain("+1 in other threads");

    list.mockResolvedValue({ wakeups: [], leases: [] });
    await act(() => client.invalidateQueries({ queryKey: qk.wakeups("s-1") }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Background work: / })).toBeNull());
  });

  it("never names work on other threads in the line", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    renderLine();
    const line = await screen.findByRole("button", { name: /^Background work: / });
    expect(line.textContent).not.toContain("secret deploy watch");
    expect(line.getAttribute("aria-label")).not.toContain("secret deploy watch");
  });

  it("lists the open thread's work first, then the rest, and opens on the keyboard", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    const user = userEvent.setup();
    renderLine();
    const line = await screen.findByRole("button", { name: /^Background work: / });
    line.focus();
    await user.keyboard("{Enter}");
    const own = await screen.findByRole("list", { name: "This thread" });
    const other = screen.getByRole("list", { name: "In other threads" });
    expect(within(own).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent)).toEqual([
      "full proof build",
      "check CI",
      "terminal work",
    ]);
    expect(within(other).getByText("secret deploy watch")).toBeTruthy();
    // The open thread's list comes before the other threads' list.
    expect(own.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("cancels a row after a confirm that names the reason", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    const cancel = vi.spyOn(api, "cancelSessionWakeup").mockResolvedValue({ cancelled: { id: "wk_1", kind: "process" } });
    const user = userEvent.setup();
    renderLine();

    await user.click(await screen.findByRole("button", { name: /^Background work: / }));
    await user.click(await screen.findByRole("button", { name: "Cancel full proof build" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('This stops "full proof build". The agent gets a message that you stopped it.')).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Stop it" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith("s-1", "wk_1"));
  });

  it("hides Cancel from a person who may not stop the work", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    const user = userEvent.setup();
    renderLine("th-1", false);
    await user.click(await screen.findByRole("button", { name: /^Background work: / }));
    expect(await screen.findByText("terminal work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Cancel / })).toBeNull();
  });

  it("shows an event waiter as 'waiting on <subject label>' with the event icon", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(eventListing(Date.now()));
    renderLine("th-1");
    const line = await screen.findByRole("button", { name: /^Background work: / });
    expect(line.textContent).toContain("waiting on acme/lean-proofs#42");
    expect(line.querySelector("svg.lucide-bell")).toBeTruthy();
  });
});

describe("BackgroundWorkSection", () => {
  function renderSection(threadId: string, canCancel = true) {
    const { wrapper } = wrap();
    return render(<BackgroundWorkSection sessionId="s-1" threadId={threadId} canCancel={canCancel} />, { wrapper });
  }

  it("lists only this thread's work, with state and time", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    renderSection("th-1");
    const section = within(await screen.findByRole("region", { name: "Background work" }));
    expect(section.getByText("full proof build")).toBeTruthy();
    expect(section.getByText("Timer · waiting · fires in 2h")).toBeTruthy();
    expect(section.getByText("Hold · held · deadline in 3h")).toBeTruthy();
    expect(section.queryByText("secret deploy watch")).toBeNull();
  });

  it("is hidden when the thread has no background work", async () => {
    const list = vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    renderSection("th-9");
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Background work" })).toBeNull();
  });

  it("opens the confirm from Cancel and stops the work", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    const cancel = vi.spyOn(api, "cancelSessionWakeup").mockResolvedValue({ cancelled: { id: "ls_2", kind: "hold" } });
    const user = userEvent.setup();
    renderSection("th-1");
    await user.click(await screen.findByRole("button", { name: "Cancel terminal work" }));
    const dialog = await screen.findByRole("dialog", { name: "Stop this background work?" });
    await user.click(within(dialog).getByRole("button", { name: "Stop it" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("s-1", "ls_2"));
  });

  it("hides Cancel from a person who may not stop the work", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(listing(Date.now()));
    renderSection("th-1", false);
    await screen.findByRole("region", { name: "Background work" });
    expect(screen.queryByRole("button", { name: /^Cancel / })).toBeNull();
  });

  it("shows an event waiter's subject as a link, its clause count, and its deadline", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(eventListing(Date.now()));
    renderSection("th-1");
    const section = within(await screen.findByRole("region", { name: "Background work" }));
    const link = section.getByRole("link", { name: "acme/lean-proofs#42" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/lean-proofs/issues/42");
    expect(section.getByText(/2 clauses/)).toBeTruthy();
    expect(section.getByText(/deadline in 20h/)).toBeTruthy();
  });

  it("shows an event waiter's subject as plain text when the plugin gives no link", async () => {
    const data = eventListing(Date.now());
    data.wakeups[0] = { ...data.wakeups[0]!, subjectUrl: undefined };
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(data);
    renderSection("th-1");
    const section = within(await screen.findByRole("region", { name: "Background work" }));
    expect(section.getByText(/acme\/lean-proofs#42/)).toBeTruthy();
    expect(section.queryByRole("link", { name: "acme/lean-proofs#42" })).toBeNull();
  });
});

describe("ThreadTimerLine", () => {
  it("says the thread waits and when the next wakeup is", () => {
    const { wrapper } = wrap();
    render(<ThreadTimerLine fireAt={Date.now() + 26 * MINUTE + 10_000} />, { wrapper });
    expect(screen.getByText("Waiting · next wakeup in 26m")).toBeTruthy();
  });
});

describe("ThreadEventLine", () => {
  it("names the subject it waits on", () => {
    render(<ThreadEventLine label="acme/lean-proofs#42" />);
    expect(screen.getByText("Waiting on acme/lean-proofs#42")).toBeTruthy();
  });
});
