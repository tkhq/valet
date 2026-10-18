// @vitest-environment jsdom
/**
 * A routine as a row of the roster's `On a schedule` group
 * (docs/specs/2026-10-16-presence-hub-design.md Part B step 6): the place
 * column holds the schedule in words without the timezone, the timezone
 * when it is not UTC, and `Next <time>` or `Off`. The sentence column holds
 * `<name>: <do>.` with the prompt under it, and the controls Fire now, the
 * small switch, and the overflow menu.
 *
 * The api client is mocked at the transport, so the real mutation hooks run.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UpdateWorkflowScheduleRequest, WorkflowScheduleResponse, WorkflowTriggerItem } from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: ReactNode; className?: string }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, value), to);
    return <a href={path} className={className}>{children}</a>;
  },
}));

const runWorkflowScheduleNow = vi.fn<(id: string) => Promise<{ ok: true }>>();
const updateWorkflowSchedule = vi.fn<(id: string, body: UpdateWorkflowScheduleRequest) => Promise<WorkflowScheduleResponse>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      runWorkflowScheduleNow: (id: string) => runWorkflowScheduleNow(id),
      updateWorkflowSchedule: (id: string, body: UpdateWorkflowScheduleRequest) => updateWorkflowSchedule(id, body),
    },
  };
});
vi.mock("~/api/settings", async () => (await import("./test-fixtures")).memberSettings);
vi.mock("~/components/workflows/trigger-dialog", () => ({
  TriggerDialog: ({ editing }: { editing?: { name: string } }) => <p>Editing {editing?.name}</p>,
}));

import { RoutineRosterRow, routineNext } from "./routine-row";
import { formatDateTime } from "~/lib/format-when";
import type { Routine } from "./routines-pane";

const NEXT = Date.UTC(2026, 9, 19, 16, 0);

function routine(over: Partial<Routine["detail"]> & { enabled?: boolean } = {}): Routine {
  const { enabled = true, ...detail } = over;
  const item = {
    kind: "schedule", id: "S1", name: "Morning summary", enabled,
    detail: {
      cron: "0 9 * * 1-5", timezone: "America/Los_Angeles", targetKind: "assistant", prompt: "Summarize the night's incidents.",
      thread: { mode: "own" }, nextFireAt: NEXT, lastFiredAt: null, ownerType: "user", ownerId: "u-001", ...detail,
    },
  } satisfies WorkflowTriggerItem;
  return item;
}

function renderRow(item: Routine) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RoutineRosterRow routine={item} sentence="Morning summary: work in its own thread." now={NEXT - 3_600_000} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  runWorkflowScheduleNow.mockReset();
  updateWorkflowSchedule.mockReset();
  runWorkflowScheduleNow.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("RoutineRosterRow", () => {
  it("puts the schedule, the timezone, and the next time in the place column", () => {
    renderRow(routine());
    const row = screen.getByRole("region", { name: "Morning summary" });
    expect(row.classList.contains("grid-cols-[200px_minmax(0,1fr)]")).toBe(true);
    const name = within(row).getByText("Every weekday at 9:00");
    expect(name.className).toContain("text-[15px]");
    const zone = within(row).getByText("America/Los_Angeles");
    const next = within(row).getByText(`Next ${formatDateTime(NEXT)}`);
    expect(zone.parentElement).toBe(next.parentElement);
  });

  it("formats Next as a date and a time without seconds", () => {
    const now = NEXT - 3_600_000;
    expect(routineNext(routine(), now, { locale: "en-US", timeZone: "UTC" })).toBe("Next Oct 19, 2026, 4:00 PM");
    expect(routineNext(routine({ nextFireAt: now }), now)).toBe("Due now");
    expect(routineNext(routine({ enabled: false }), now)).toBe("Off");
  });

  it("leaves out a UTC timezone and reads Off for a routine that is off", () => {
    renderRow(routine({ timezone: "UTC", enabled: false }));
    const row = screen.getByRole("region", { name: "Morning summary" });
    expect(within(row).queryByText("UTC")).toBeNull();
    expect(within(row).getByText("Off")).toBeTruthy();
    expect(within(row).queryByText(/^Next /)).toBeNull();
    expect(within(row).getByRole("link", { name: "Morning summary: work in its own thread." }).className).toContain("text-muted");
  });

  it("reads the sentence with the prompt under it, and the controls on the row", async () => {
    renderRow(routine());
    const sentence = screen.getByRole("link", { name: "Morning summary: work in its own thread." });
    expect(sentence.getAttribute("href")).toBe("/presence/routines/S1");
    expect(sentence.className).toContain("text-base");
    expect(screen.getByText("Summarize the night's incidents.").className).toContain("text-muted");
    expect(screen.getByRole("switch", { name: "Turn off Morning summary" }).classList.contains("w-7")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Fire Morning summary now" }));
    await waitFor(() => expect(runWorkflowScheduleNow).toHaveBeenCalledWith("S1"));
    expect(await screen.findByText("Fired Morning summary. It runs now.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "More for Morning summary" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Edit", "Delete"]);
  });
});
