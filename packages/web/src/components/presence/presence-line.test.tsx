// @vitest-environment jsdom
/**
 * The sentence row (docs/specs/2026-10-16-presence-hub-design.md Part B
 * step 5, Part C steps 2 and 3): the row's grid and hover wash, the small
 * switch that patches the line, the read-only rule, and Delete with its
 * confirm. The roster cases (off, faulted, paused) are in place-row.test.tsx.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventSubscriptionWire, PatchEventSubscriptionRequest } from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: ReactNode; className?: string }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, value), to);
    return <a href={path} className={className}>{children}</a>;
  },
}));

const patchEventSubscription = vi.fn<(id: string, body: PatchEventSubscriptionRequest) => Promise<EventSubscriptionWire>>();
const deleteEventSubscription = vi.fn<(id: string) => Promise<{ ok: true }>>();
const listEventSubscriptions = vi.fn<() => Promise<{ subscriptions: EventSubscriptionWire[] }>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      patchEventSubscription: (id: string, body: PatchEventSubscriptionRequest) => patchEventSubscription(id, body),
      deleteEventSubscription: (id: string) => deleteEventSubscription(id),
      listEventSubscriptions: () => listEventSubscriptions(),
    },
  };
});
vi.mock("~/api/workflows", () => ({ useWorkflows: () => ({ data: { workflows: [] } }) }));
let teams: { id: string; name: string; callerRole: "admin" | "member" | null }[] = [];
vi.mock("~/api/settings", async () => ({
  ...(await import("./test-fixtures")).memberSettings,
  useTeams: () => ({ data: { teams } }),
}));
vi.mock("~/components/presence/editor/line-editor", async () => (await import("~/components/presence/editor/test-editor-stub")).stubModule);

import { ApiError } from "~/api/client";
import { PresenceLine } from "./presence-line";
import { line } from "./test-fixtures";

function mention(over: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return line("R1", {
    name: "Incident mentions", eventKeys: ["slack.app_mention"], target: { kind: "assistant", thread: { mode: "new" } }, ...over,
  });
}

function renderLine(sub: EventSubscriptionWire) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PresenceLine sub={sub} sentence="When someone mentions Valet, reply in a new thread." />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  teams = [];
  listEventSubscriptions.mockReset();
  listEventSubscriptions.mockResolvedValue({ subscriptions: [] });
  patchEventSubscription.mockReset();
  deleteEventSubscription.mockReset();
  patchEventSubscription.mockImplementation(async (id, body) => ({ ...mention({}), id, enabled: body.enabled ?? true }));
  deleteEventSubscription.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("PresenceLine", () => {
  it("sets the sentence and its controls as a two-column row with the ink wash on hover", () => {
    renderLine(mention({}));
    const sentence = screen.getByRole("link", { name: "When someone mentions Valet, reply in a new thread." });
    expect(sentence.getAttribute("href")).toBe("/presence/rules/R1");
    const row = sentence.closest("[data-presence-line]");
    for (const name of ["grid", "grid-cols-[minmax(0,1fr)_auto]", "hover:bg-ink-wash", "rounded-md", "-mx-2", "px-2"]) {
      expect(row?.classList.contains(name)).toBe(true);
    }
    expect(row?.classList.contains("border")).toBe(false);
    expect(screen.getByRole("button", { name: "More for Incident mentions" }).className).toContain("h-6");
  });

  it("turns the line off from the small switch", async () => {
    renderLine(mention({}));
    await userEvent.click(screen.getByRole("switch", { name: "Turn off Incident mentions" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R1", { enabled: false }));
  });

  it("offers Turn on anyway when the server refuses the switch over an overlap", async () => {
    const text = 'This line covers everything "Old mentions" already handles on the same events, so both would fire together. Narrow its filters, or turn it on with "Turn on anyway".';
    patchEventSubscription.mockRejectedValueOnce(new ApiError(409, text, { error: text, collisions: { blocking: [], overlapping: [] } }));
    renderLine(mention({ enabled: false }));
    await userEvent.click(screen.getByRole("switch", { name: "Turn on Incident mentions" }));
    expect((await screen.findByRole("alert")).textContent).toContain(text);
    await userEvent.click(screen.getByRole("button", { name: "Turn on anyway" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenLastCalledWith("R1", { enabled: true, allowCollision: true }));
  });

  it("shows any other switch refusal as an error, with no Turn on anyway", async () => {
    patchEventSubscription.mockRejectedValueOnce(new ApiError(400, "nope", { error: "Connect Linear first." }));
    renderLine(mention({ enabled: false }));
    await userEvent.click(screen.getByRole("switch", { name: "Turn on Incident mentions" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Connect Linear first.");
    expect(screen.queryByRole("button", { name: "Turn on anyway" })).toBeNull();
  });

  it("keeps another member's personal line read-only", async () => {
    renderLine(mention({ ownerId: "u-002" }));
    expect(screen.getByRole("switch", { name: "Turn off Incident mentions" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "More for Incident mentions" }));
    for (const item of screen.getAllByRole("menuitem")) expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("deletes the line after the confirm", async () => {
    renderLine(mention({}));
    await userEvent.click(screen.getByRole("button", { name: "More for Incident mentions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText("Valet stops listening for this here. Its past activity stays.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteEventSubscription).toHaveBeenCalledWith("R1"));
  });

  it("marks a team line Team and names the team in its Delete confirm", async () => {
    teams = [{ id: "sre", name: "SRE", callerRole: "member" }];
    renderLine(mention({ ownerType: "team", ownerId: "sre" }));
    expect(screen.getByText("Team")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "More for Incident mentions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText("This is SRE's line. Valet stops listening for this here. Its past activity stays.")).toBeTruthy();
  });

  it("marks an org line Org and a personal line not at all", () => {
    renderLine(mention({ ownerType: "org", ownerId: "acme" }));
    expect(screen.getByText("Org")).toBeTruthy();
    cleanup();
    renderLine(mention({}));
    expect(screen.queryByText("Team")).toBeNull();
    expect(screen.queryByText("Org")).toBeNull();
  });

  it("keeps a team line read-only for a viewer outside the team", async () => {
    teams = [{ id: "sre", name: "SRE", callerRole: null }];
    renderLine(mention({ ownerType: "team", ownerId: "sre" }));
    expect(screen.getByRole("switch", { name: "Turn off Incident mentions" }).hasAttribute("disabled")).toBe(true);
  });

  it("says Proposed, not Off, under a proposal", () => {
    renderLine(mention({ id: "proposal-1", enabled: false, target: { kind: "assistant", replaces: "R0" } }));
    expect(screen.getByText("Proposed")).toBeTruthy();
    expect(screen.queryByText("Off")).toBeNull();
  });

  it("names the pausing team, and Keep both turns the line on and stops the pause", async () => {
    teams = [{ id: "sre", name: "SRE", callerRole: "member" }];
    const paused = mention({ enabled: false, target: { kind: "assistant", overlapPausedAt: 5, pauseOnOverlap: true } });
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [paused, line("T1", { ownerType: "team", ownerId: "sre", eventKeys: ["slack.app_mention"], target: { kind: "assistant", assistant: "team", teamId: "sre" } })],
    });
    renderLine(paused);
    expect(await screen.findByText("Paused: SRE already listens for this.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep both" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R1", { pauseOnOverlap: false, enabled: true }));
  });

  it("offers Turn on anyway when the server refuses Keep both over an overlap", async () => {
    const text = 'This line covers everything "Old mentions" already handles on the same events, so both would fire together. Narrow its filters, or turn it on with "Turn on anyway".';
    patchEventSubscription.mockRejectedValueOnce(new ApiError(409, text, { error: text, collisions: { blocking: [], overlapping: [] } }));
    const paused = mention({ enabled: false, target: { kind: "assistant", overlapPausedAt: 5, pauseOnOverlap: true } });
    listEventSubscriptions.mockResolvedValue({ subscriptions: [paused] });
    renderLine(paused);
    await userEvent.click(screen.getByRole("button", { name: "Keep both" }));
    expect((await screen.findByRole("alert")).textContent).toContain(text);
    await userEvent.click(screen.getByRole("button", { name: "Turn on anyway" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenLastCalledWith("R1", { pauseOnOverlap: false, enabled: true, allowCollision: true }));
  });

  it("says the team when two teams could have paused the line", async () => {
    teams = [{ id: "sre", name: "SRE", callerRole: "member" }, { id: "ops", name: "Ops", callerRole: "member" }];
    const paused = mention({ enabled: false, target: { kind: "assistant", overlapPausedAt: 5 } });
    const team = (id: string) => line(id, { ownerType: "team", ownerId: id, eventKeys: ["slack.app_mention"], target: { kind: "assistant", assistant: "team", teamId: id } });
    listEventSubscriptions.mockResolvedValue({ subscriptions: [paused, team("sre"), team("ops")] });
    renderLine(paused);
    await waitFor(() => expect(listEventSubscriptions).toHaveBeenCalled());
    expect(screen.getByText("Paused: the team already listens for this.")).toBeTruthy();
  });

  it("keeps the picker behind Pick another thread under the row", async () => {
    renderLine(mention({ problem: "Pick another thread in Presence.", target: { kind: "assistant", thread: { mode: "existing", sessionId: "s", threadId: "t" } } }));
    expect(screen.queryByRole("group", { name: "Problem" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Pick another thread" }));
    expect(screen.getByRole("group", { name: "Problem" })).toBeTruthy();
  });
});
