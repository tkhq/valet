// @vitest-environment jsdom
/**
 * The editor inline on a line's or a routine's page
 * (docs/specs/2026-10-16-presence-hub-design.md Part D step 1.6, Part E
 * step 2). `~/api/*` is mocked as in the sheet's tests, so each case reads
 * the body Save sends.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { EventSubscriptionWire, PatchEventSubscriptionRequest, PluginSummary, UpdateWorkflowScheduleRequest } from "@valet/api/wire";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { line, routine, visibleText } from "../test-fixtures";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  // The page's router guards a leave; the args say when the guard is on.
  useBlocker: (options: { disabled: boolean }) => {
    blockerOn = !options.disabled;
    return { status: "idle" };
  },
}));

let blockerOn = false;
const patchSubscription = vi.fn();
const updateSchedule = vi.fn();
const catalogData = {
  services: [
    {
      service: "github",
      entries: [{ key: "github.check_run.completed", description: "Check", filters: [{ field: "repo", description: "" }] }],
    },
  ],
};

vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: catalogData, isLoading: false, error: null }),
  useEventSubscriptions: () => ({ data: { subscriptions: [] } }),
  useCreateEventSubscription: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchEventSubscription: () => ({ mutate: patchSubscription, isPending: false }),
  useFilterOptions: () => ({ data: { options: [], reason: "Connect first." }, isLoading: false }),
}));
function plugin(name: string): PluginSummary {
  return { name, version: "1", actionCount: 0, services: [{ service: name, type: "oauth2", configKeys: [], connected: true, connect: "oauth", actions: [] }] };
}
vi.mock("~/api/integrations", () => ({ usePlugins: () => ({ data: { plugins: [plugin("github")] }, isError: false }) }));
vi.mock("~/api/rule", () => ({ usePinnedThreadTitle: () => ({}) }));
vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: { workflows: [{ id: "wf_1", name: "Triage" }] } }),
  useCreateSchedule: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSchedule: () => ({ mutate: updateSchedule, isPending: false }),
}));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-001" } }),
  useOrgDirectory: () => ({ data: { users: [] } }),
  useTeams: () => ({ data: { teams: [] } }),
  useOrg: () => ({ data: { features: { organizations: false } } }),
}));
vi.mock("~/api/presence", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/presence")>(),
  usePresencePlaces: () => ({ data: { places: [] } }),
}));
vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: "user", teamId: undefined, available: ["user"], setKey: () => {} }),
}));
vi.mock("../thread-picker", () => ({ ThreadPicker: () => null }));

import { InlineEditor } from "./inline-editor";

const CHECK_LINE: EventSubscriptionWire = line("l1", {
  name: "CI failures",
  eventKeys: ["github.check_run.completed"],
  filters: [{ field: "repo", op: "eq", value: "acme/api" }],
  target: { kind: "assistant", assistant: "user", thread: { mode: "own" } },
  updatedAt: 1_000,
});

function form(): HTMLElement {
  return screen.getByRole("region", { name: "How it works" });
}

function bar() {
  return screen.queryByRole("region", { name: "Unsaved changes" });
}

beforeEach(() => {
  patchSubscription.mockReset();
  updateSchedule.mockReset();
  blockerOn = false;
});

describe("InlineEditor", () => {
  it("shows every section open, with no toggle and no bar while clean", () => {
    render(<InlineEditor mode={{ kind: "edit", line: CHECK_LINE }} readOnly={false} />);
    const sections = [...form().querySelectorAll<HTMLElement>("[data-section]")];
    expect(sections.map((section) => section.dataset.section)).toEqual(["when", "do", "where", "appears", "name"]);
    expect(sections.every((section) => section.querySelector("[data-section-body]") !== null)).toBe(true);
    expect(within(form()).queryAllByRole("button", { name: /^(Change|Close) / })).toEqual([]);
    expect(bar()).toBeNull();
    expect(blockerOn).toBe(false);
  });

  it("shows the bar on a change, and Cancel drops it", () => {
    render(<InlineEditor mode={{ kind: "edit", line: CHECK_LINE }} readOnly={false} />);
    fireEvent.click(screen.getByRole("radio", { name: "A new thread each time" }));
    const changes = bar();
    if (changes === null) throw new Error("No bar after a change.");
    expect(visibleText(within(changes).getByTestId("editor-sentence"))).toBe("When a check completes on acme/api, work in a new thread each time.");
    expect(blockerOn).toBe(true);
    fireEvent.click(within(changes).getByRole("button", { name: "Cancel" }));
    expect(bar()).toBeNull();
    expect((screen.getByRole("radio", { name: "Its own thread" }) as HTMLInputElement).checked).toBe(true);
    expect(patchSubscription).not.toHaveBeenCalled();
  });

  it("saves only the change, then reads clean and takes the refetched row", () => {
    const onSaved = vi.fn();
    patchSubscription.mockImplementation((_vars: unknown, handlers: { onSuccess: (resp: { id: string }) => void }) => handlers.onSuccess({ id: "l1" }));
    const { rerender } = render(<InlineEditor mode={{ kind: "edit", line: CHECK_LINE }} readOnly={false} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("radio", { name: "A new thread each time" }));
    fireEvent.click(within(bar() ?? document.body).getByRole("button", { name: "Save" }));
    const { id, body } = patchSubscription.mock.calls[0]?.[0] as { id: string; body: PatchEventSubscriptionRequest };
    expect(id).toBe("l1");
    expect(body).toEqual({ thread: { mode: "new" } });
    expect(onSaved).toHaveBeenCalledWith({ kind: "line", id: "l1" });
    expect(bar()).toBeNull();
    // The refetch hands the page the stored row; the clean form reads it.
    const stored = { ...CHECK_LINE, name: "CI failures, fresh", target: { ...CHECK_LINE.target, thread: { mode: "new" as const } }, updatedAt: 2_000 };
    rerender(<InlineEditor mode={{ kind: "edit", line: stored }} readOnly={false} onSaved={onSaved} />);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("CI failures, fresh");
    expect((screen.getByRole("radio", { name: "A new thread each time" }) as HTMLInputElement).checked).toBe(true);
  });

  it("keeps the reader's change when a refetch arrives, and diffs against the copy it read", () => {
    const { rerender } = render(<InlineEditor mode={{ kind: "edit", line: CHECK_LINE }} readOnly={false} />);
    fireEvent.click(screen.getByRole("radio", { name: "A new thread each time" }));
    rerender(<InlineEditor mode={{ kind: "edit", line: { ...CHECK_LINE, name: "Renamed elsewhere", updatedAt: 3_000 } }} readOnly={false} />);
    expect((screen.getByRole("radio", { name: "A new thread each time" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(bar() ?? document.body).getByRole("button", { name: "Save" }));
    const { body } = patchSubscription.mock.calls[0]?.[0] as { body: PatchEventSubscriptionRequest };
    expect(body).toEqual({ thread: { mode: "new" } });
  });

  it("shows a read-only viewer the form, disabled, with no bar", () => {
    render(<InlineEditor mode={{ kind: "edit", line: CHECK_LINE }} readOnly />);
    expect(form().querySelector("fieldset")?.disabled).toBe(true);
    expect(bar()).toBeNull();
  });

  it("edits a routine's instructions in a box that fits them, and saves them", () => {
    updateSchedule.mockImplementation((_vars: unknown, handlers: { onSuccess: () => void }) => handlers.onSuccess());
    render(<InlineEditor mode={{ kind: "edit-routine", routine: routine("S1") }} readOnly={false} />);
    const box = screen.getByLabelText("Instructions (required)") as HTMLTextAreaElement;
    expect(box.rows).toBe(6);
    expect(box.value).toBe("Summarize");
    // The Do choice is fixed on a stored routine, and its card says so.
    expect(screen.getByText("This stays fixed. To change it, delete this routine and make a new one.")).toBeTruthy();
    fireEvent.change(box, { target: { value: "Summarize open incidents." } });
    fireEvent.click(within(bar() ?? document.body).getByRole("button", { name: "Save" }));
    const { id, body } = updateSchedule.mock.calls[0]?.[0] as { id: string; body: UpdateWorkflowScheduleRequest };
    expect(id).toBe("S1");
    expect(body).toMatchObject({ prompt: "Summarize open incidents." });
  });
});
