// @vitest-environment jsdom
/**
 * The **Needs attention** banner (docs/specs/2026-10-16-presence-hub-design.md
 * Part B step 2, Part F step 4, INV-H6): each fault kind renders its fix
 * inline, and a pick from the banner's picker patches the line.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EventSubscriptionWire, ListThreadsResponse, PatchEventSubscriptionRequest, WorkflowTriggerItem } from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
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
vi.mock("~/api/settings", async () => (await import("./test-fixtures")).memberSettings);
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

import { AttentionBanner } from "./attention-banner";
import { PIN_UNAVAILABLE } from "./problem-badge";
import { PLATFORM_CI, line } from "./test-fixtures";
import type { Fault } from "./use-faults";
import type { Routine } from "./routine-helpers";


const R4 = line("R4", {
  name: "CI failures", eventKeys: ["github.check_run.completed"],
  filters: [{ field: "repo", op: "eq", value: "acme/api" }],
  target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-u", threadId: "t-ci" } },
  problem: PIN_UNAVAILABLE,
});

const S2 = {
  kind: "schedule", id: "S2", name: "Morning summary", enabled: false,
  detail: {
    cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", nextFireAt: 1, lastFiredAt: null,
    ownerType: "user", ownerId: "u-001", disabledReason: "The pinned thread is archived.",
  },
} satisfies WorkflowTriggerItem;
const S2_ROUTINE: Routine = S2;

const FAULTS: Fault[] = [
  { kind: "line", sub: R4, text: "Platform CI is archived. Pick another thread:", lead: "In acme/api," },
  { kind: "routine", routine: S2_ROUTINE, text: "Morning summary is off: The pinned thread is archived." },
  {
    kind: "delivery", eventId: "ev-14", subscriptionId: "R7",
    text: "Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver",
  },
];

function renderBanner(faults: Fault[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AttentionBanner faults={faults} /></QueryClientProvider>);
}

beforeEach(() => {
  listThreads.mockReset();
  patchEventSubscription.mockReset();
  listThreads.mockImplementation(async (_sessionId, opts) => ({
    threads: opts?.archived ? [PLATFORM_CI] : [],
  }));
  patchEventSubscription.mockImplementation(async (id) => ({ ...R4, id, problem: undefined }));
});

afterEach(cleanup);

describe("AttentionBanner", () => {
  it("renders nothing with no fault", () => {
    const { container } = renderBanner([]);
    expect(container.textContent).toBe("");
  });

  it("is a ruled section with a danger mark and a muted heading, not a box", () => {
    renderBanner(FAULTS);
    const banner = screen.getByRole("region", { name: "Needs attention" });
    for (const name of ["border-t", "border-line", "pt-3.5"]) expect(banner.classList.contains(name)).toBe(true);
    for (const name of ["border", "rounded-md", "bg-danger-wash"]) expect(banner.classList.contains(name)).toBe(false);
    const heading = within(banner).getByRole("heading", { name: "Needs attention" });
    expect(heading.className).toContain("text-xs");
    expect(heading.className).toContain("text-muted");
    expect(heading.querySelector(".bg-danger-500")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("names the place before a line's fault", async () => {
    renderBanner(FAULTS.slice(0, 1));
    const problem = await screen.findByText("Platform CI is archived. Pick another thread:");
    expect(problem.textContent).toBe("In acme/api, Platform CI is archived. Pick another thread:");
    expect(within(problem).getByText("In acme/api,").className).toContain("text-muted");
  });

  it("leads a service-wide line with its service row, and a dead delivery with its place", async () => {
    const anywhere = line("A", {
      name: "Mentions anywhere", eventKeys: ["slack.app_mention"], problem: "Reconnect Slack in Integrations.",
    });
    renderBanner([
      { kind: "line", sub: anywhere, text: "Reconnect Slack in Integrations.", lead: "Everywhere in Slack," },
      {
        kind: "delivery", eventId: "ev-14", subscriptionId: "R7", lead: "In acme/api,",
        text: "Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver",
      },
    ]);
    const items = within(screen.getByRole("region", { name: "Needs attention" })).getAllByRole("listitem");
    expect((await within(items[0]!).findByText("Reconnect Slack in Integrations.")).textContent)
      .toBe("Everywhere in Slack, Reconnect Slack in Integrations.");
    expect(items[1]!.textContent).toBe("In acme/api, Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver");
    expect(within(items[1]!).getByText("In acme/api,").className).toContain("text-muted");
    expect(within(items[1]!).getByRole("link").textContent).toBe(
      "Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver",
    );
  });

  it("renders each fault with its fix, and no bare count", async () => {
    renderBanner(FAULTS);
    const banner = screen.getByRole("region", { name: "Needs attention" });
    expect(within(banner).getByRole("heading", { name: "Needs attention" })).toBeTruthy();
    const items = within(banner).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // The line: the same inline problem the sentence row shows, with the picker.
    expect(await within(items[0]!).findByText("Platform CI is archived. Pick another thread:")).toBeTruthy();
    expect(within(items[0]!).getByRole("group", { name: "Problem" })).toBeTruthy();
    expect(within(items[0]!).getByRole("button", { name: "Pick Platform Ops from user" })).toBeTruthy();
    // The routine: its reason and an Edit link to its page.
    expect(items[1]!.textContent).toBe("Morning summary is off: The pinned thread is archived.Edit");
    expect(within(items[1]!).getByRole("link", { name: "Edit" }).getAttribute("href")).toBe("/presence/routines/S2");
    // The dead delivery: the Activity row text, linked to its event.
    const event = within(items[2]!).getByRole("link");
    expect(event.textContent).toBe("Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver");
    expect(event.getAttribute("href")).toBe("/presence/events/ev-14");
    expect(banner.textContent).not.toMatch(/\b3 problems\b/);
  });

  it("patches the line with a pick from the banner", async () => {
    renderBanner(FAULTS.slice(0, 1));
    fireEvent.click(screen.getByRole("button", { name: "Pick Platform Ops from user" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", {
      thread: { mode: "existing", sessionId: "s-u", threadId: "t-ops" },
    }));
  });
});
