// @vitest-environment jsdom
/**
 * The editor sheet (docs/specs/2026-10-16-presence-hub-design.md Part H).
 * `~/api/*` is mocked to record the bodies Create and Save send, so each
 * case can compare the side pane's sentence with the sentence of the body.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  CreateEventSubscriptionRequest,
  CreateWorkflowScheduleRequest,
  EventSubscriptionWire,
  PatchEventSubscriptionRequest,
  PluginSummary,
  PresencePlaceWire,
  UpdateWorkflowScheduleRequest,
} from "@valet/api/wire";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "~/api/client";
import { line, routine, visibleText } from "../test-fixtures";
import { presenceSentence, routineSentence } from "../sentences";
import { applyLinePatch, applyRoutinePatch, lineFromCreate, routineFromCreate } from "./draft";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

let pendingRequest = false;
const createSubscription = vi.fn();
const patchSubscription = vi.fn();
const createSchedule = vi.fn();
const updateSchedule = vi.fn();

const catalogData = {
  services: [
    {
      service: "slack",
      entries: [
        { key: "slack.app_mention", description: "Mention", filters: [{ field: "channel", description: "" }, { field: "channel_name", description: "Channel name without #" }, { field: "user", description: "" }] },
        { key: "slack.message", description: "Message", filters: [{ field: "channel", description: "" }] },
      ],
    },
    {
      service: "github",
      entries: [
        { key: "github.pull_request.opened", description: "PR", filters: [{ field: "repo", description: "" }] },
        { key: "github.check_run.completed", description: "Check", filters: [{ field: "repo", description: "" }] },
      ],
    },
  ],
};
let subscriptions: EventSubscriptionWire[] = [];

vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: catalogData, isLoading: false, error: null }),
  useEventSubscriptions: () => ({ data: { subscriptions } }),
  useCreateEventSubscription: () => ({ mutate: createSubscription, isPending: pendingRequest }),
  usePatchEventSubscription: () => ({ mutate: patchSubscription, isPending: pendingRequest }),
  useFilterOptions: () => ({ data: { options: [], reason: "Connect first." }, isLoading: false }),
}));

function plugin(name: string): PluginSummary {
  return { name, version: "1", actionCount: 0, services: [{ service: name, type: "oauth2", configKeys: [], connected: true, connect: "oauth", actions: [] }] };
}
vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: { plugins: ["slack", "github"].map(plugin) }, isError: false }),
}));
vi.mock("~/api/rule", () => ({ usePinnedThreadTitle: () => ({}) }));
vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: { workflows: [{ id: "wf_1", name: "Triage" }] } }),
  useCreateSchedule: () => ({ mutate: createSchedule, isPending: false }),
  useUpdateSchedule: () => ({ mutate: updateSchedule, isPending: false }),
}));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-001" } }),
  useOrgDirectory: () => ({ data: { users: [] } }),
  useTeams: () => ({ data: { teams: [] } }),
  useOrg: () => ({ data: { features: { organizations: false } } }),
}));
/** The places list names a Slack channel saved without a label. */
let places: PresencePlaceWire[] = [];
vi.mock("~/api/presence", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/presence")>(),
  usePresencePlaces: () => ({ data: { places } }),
}));
vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: "user", teamId: undefined, available: ["user"], setKey: () => {} }),
}));
vi.mock("../thread-picker", () => ({
  ThreadPicker: ({ onPick }: { onPick: (p: { mode: "existing"; sessionId: string; threadId: string }, title: string) => void }) => (
    <button type="button" onClick={() => onPick({ mode: "existing", sessionId: "s-u", threadId: "t-ci" }, "Platform CI")}>Pick Platform CI</button>
  ),
}));

import { LineEditor, type EditorMode } from "./line-editor";

const INCIDENTS = { subject: "slack:T1/C1", service: "slack" as const, label: "#incidents" };

function sentence(): string {
  const cards = screen.getAllByTestId("editor-sentence");
  return visibleText(cards[0]);
}

function sectionNames(): string[] {
  return [...document.querySelectorAll("[data-section]")].map((s) => s.getAttribute("data-section") ?? "");
}

function openSections(): string[] {
  return [...document.querySelectorAll("[data-section]")]
    .filter((s) => within(s as HTMLElement).queryByRole("button", { name: /^Close / }) !== null)
    .map((s) => s.getAttribute("data-section") ?? "");
}

function summary(id: string): string {
  const section = document.querySelector(`[data-section="${id}"]`);
  return section?.querySelector("p")?.textContent ?? "";
}

function renderEditor(mode: EditorMode, onOpenChange = vi.fn(), onSaved = vi.fn()) {
  render(<LineEditor open onOpenChange={onOpenChange} mode={mode} onSaved={onSaved} />);
  return { onOpenChange, onSaved };
}

const CHECK_LINE = line("l1", {
  name: "CI failures",
  eventKeys: ["github.check_run.completed"],
  filters: [{ field: "repo", op: "eq", value: "acme/api" }],
  target: { kind: "assistant", assistant: "user", thread: { mode: "own" } },
  updatedAt: Date.now() - 3 * 86_400_000,
});

beforeEach(() => {
  createSubscription.mockReset();
  patchSubscription.mockReset();
  createSchedule.mockReset();
  updateSchedule.mockReset();
  subscriptions = [];
  pendingRequest = false;
  places = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LineEditor", () => {
  it("lists the sections in order; on create When opens and the rest read defaults", () => {
    renderEditor({ kind: "create" });
    expect(sectionNames()).toEqual(["when", "do", "where", "appears", "name"]);
    expect(openSections()).toEqual(["when"]);
    expect(screen.getByRole("heading", { name: "New" })).toBeTruthy();
    expect(summary("do")).toBe("reply");
    expect(summary("where")).toBe("in a new thread each time");
    expect(summary("appears")).toBe("Valet, the workspace's name and avatar");
    expect(summary("name")).toBe("No name yet");
  });

  it("keeps one section open at a time", () => {
    renderEditor({ kind: "create" });
    fireEvent.click(screen.getByRole("button", { name: "Change Do" }));
    expect(openSections()).toEqual(["do"]);
    fireEvent.click(screen.getByRole("button", { name: "Change Name" }));
    expect(openSections()).toEqual(["name"]);
    fireEvent.click(screen.getByRole("button", { name: "Close Name" }));
    expect(openSections()).toEqual([]);
  });

  it("on edit shows every section summarized under the line's name", () => {
    renderEditor({ kind: "edit", line: CHECK_LINE });
    expect(openSections()).toEqual([]);
    expect(screen.getByRole("heading", { name: "CI failures" })).toBeTruthy();
    expect(summary("when")).toBe("a check completes on acme/api");
    expect(summary("do")).toBe("work on it");
    expect(summary("where")).toBe("in its own thread");
    expect(summary("name")).toBe("CI failures");
    expect(screen.getByText("Edited 3 days ago")).toBeTruthy();
  });

  it("creates a line whose stored sentence is the side pane's sentence, named by the suggestion", () => {
    const { onSaved } = renderEditor({ kind: "create" });
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    fireEvent.click(screen.getByLabelText("A check completes"));
    expect(summary("name")).toBe("Check completes on any repository");
    const shown = sentence();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const body = createSubscription.mock.calls[0]?.[0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("Check completes on any repository");
    expect(body.target).toEqual({ kind: "assistant", assistant: "user", follow: false, deliveryPolicy: "always", pauseOnOverlap: true, thread: { mode: "subject" } });
    expect(shown).toBe(presenceSentence(lineFromCreate(body), catalogData.services, [], {}));
    createSubscription.mock.calls[0]?.[1].onSuccess({ id: "sub_new" });
    expect(onSaved).toHaveBeenCalledWith({ kind: "line", id: "sub_new" });
  });

  it("disables Create with its reason until the draft is ready", () => {
    renderEditor({ kind: "create" });
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Pick at least one event.")).toBeTruthy();
    const aside = screen.getByRole("complementary", { name: "Preview" });
    expect(aside.textContent).toContain("No event is picked yet. Pick at least one in When.");
    expect(aside.textContent).toContain("This line has no name yet. Give it one in Name.");
    fireEvent.click(screen.getByLabelText("Someone mentions Valet"));
    expect(screen.getByText("Add a channel, or choose Any channel.")).toBeTruthy();
  });

  it("creates a routine with the cron the day and time control makes", () => {
    renderEditor({ kind: "create", preselected: { schedule: true } });
    fireEvent.click(screen.getByLabelText("Sat"));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "07:30" } });
    expect(screen.getByText("Give the routine instructions.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change Do" }));
    fireEvent.change(screen.getByLabelText("Instructions (required)"), { target: { value: "Summarize overnight changes" } });
    const shown = sentence();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const body = createSchedule.mock.calls[0]?.[0] as CreateWorkflowScheduleRequest;
    expect(body.cron).toBe("30 7 * * 1,2,3,4,5,6");
    expect(body.name).toBe("Summarize overnight changes");
    expect(body.target).toEqual({ kind: "assistant", prompt: "Summarize overnight changes" });
    expect(shown).toBe(routineSentence(routineFromCreate(body), [], {}));
  });

  it("saves only the thread when Where moves to a pinned thread (Review Focus 3)", () => {
    renderEditor({ kind: "edit", line: CHECK_LINE });
    fireEvent.click(screen.getByRole("button", { name: "Change Where" }));
    fireEvent.click(screen.getByRole("radio", { name: "Pick a thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick Platform CI" }));
    expect(summary("where")).toBe("in the Platform CI thread");
    const shown = sentence();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const { id, body } = patchSubscription.mock.calls[0]?.[0] as { id: string; body: PatchEventSubscriptionRequest };
    expect(id).toBe("l1");
    expect(body).toEqual({ thread: { mode: "existing", sessionId: "s-u", threadId: "t-ci" } });
    expect(shown).toBe(presenceSentence(applyLinePatch(CHECK_LINE, body), catalogData.services, [], { "t-ci": { title: "Platform CI" } }));
    expect(shown).toBe("When a check completes on acme/api, work in the Platform CI thread.");
  });

  it("diffs the patch against the line as it was at open, not a refetched row (E3)", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<LineEditor open onOpenChange={onOpenChange} mode={{ kind: "edit", line: CHECK_LINE }} />);
    // Another tab renames the line; a refetch hands the launcher the new row.
    rerender(<LineEditor open onOpenChange={onOpenChange} mode={{ kind: "edit", line: { ...CHECK_LINE, name: "Renamed elsewhere", updatedAt: Date.now() } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Where" }));
    fireEvent.click(screen.getByRole("radio", { name: "A new thread each time" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const { body } = patchSubscription.mock.calls[0]?.[0] as { body: PatchEventSubscriptionRequest };
    expect(body).toEqual({ thread: { mode: "new" } });
  });

  it("opens the section a launcher names, and only that one", () => {
    renderEditor({ kind: "edit", line: CHECK_LINE, initialSection: "where" });
    expect(openSections()).toEqual(["where"]);
  });

  it("scrolls to the named section and focuses its first control (E4)", () => {
    // jsdom has no scrollIntoView; record where it is called.
    const scrolled: Element[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) { scrolled.push(this); },
    });
    try {
      renderEditor({ kind: "edit", line: CHECK_LINE, initialSection: "do" });
      expect(scrolled).toEqual([document.querySelector('[data-section="do"]')]);
      // The Do cards of a stored line are fixed, so the first control is the instructions.
      expect(document.activeElement).toBe(screen.getByLabelText("Instructions (optional)"));
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("starts a Slack mention line for a preselected team (the team Slack setup)", () => {
    renderEditor({ kind: "create", preselected: { team: { id: "t_platform", name: "Platform" } } });
    expect(screen.getByRole("button", { name: "Slack" }).getAttribute("aria-pressed")).toBe("true");
    expect(summary("when")).toContain("mentions Valet");
    fireEvent.click(screen.getByRole("button", { name: "Change Do" }));
    expect((screen.getByRole("radio", { name: "Platform's assistant" }) as HTMLInputElement).checked).toBe(true);
    // The setup fixes the team's assistant: the other choices are off.
    expect((screen.getByRole("radio", { name: "Your assistant" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("submits a dedicated prefix response with future-channel consent and no inferred exclusions", () => {
    subscriptions = [line("conditional", { eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }, { field: "text", op: "contains", value: "urgent" }],
      target: { kind: "assistant", assistant: "team", teamId: "t_platform", follow: true },
    })];
    renderEditor({ kind: "create", preselected: {
      team: { id: "t_platform", name: "Platform" }, channelNamePattern: { prefix: "lead-" },
    } });
    expect(screen.getByLabelText(/^Any channel/)).toHaveProperty("checked", true);
    expect(sentence()).toContain("channel name that starts with lead-");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createSubscription).toHaveBeenCalledWith(expect.objectContaining({
      eventKeys: ["slack.app_mention"], anyChannel: true, audience: "organization",
      filters: [{ field: "channel_name", op: "prefix", value: "lead-" }],
      target: expect.objectContaining({ kind: "assistant", assistant: "team", teamId: "t_platform", follow: true }),
    }), expect.anything());
  });

  it("follows one Slack thread from a pasted link, with the old wizard's body", () => {
    renderEditor({ kind: "create" });
    fireEvent.click(screen.getByRole("radio", { name: "A reply in one Slack thread" }));
    expect(screen.getByText("Paste the thread's link.")).toBeTruthy();
    const link = screen.getByLabelText("Paste the thread's link");
    fireEvent.change(link, { target: { value: "https://acme.slack.com/archives/C123ABC" } });
    expect(screen.getByRole("alert").textContent).toBe("That is not a Slack message link. Copy the link from the message's menu.");
    fireEvent.change(link, { target: { value: "https://acme.slack.com/archives/C123ABC/p1750000000123456" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(summary("when")).toBe("a reply in one Slack thread in C123ABC");
    fireEvent.click(screen.getByRole("button", { name: "Change Name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Follow rollout thread" } });
    expect(sentence()).toBe("When someone replies in the Slack thread in C123ABC, work in its own thread.");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const body = createSubscription.mock.calls[0]?.[0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("Follow rollout thread");
    expect(body.eventKeys).toEqual(["slack.message"]);
    expect(body.filters).toEqual([
      { field: "channel", op: "eq", value: "C123ABC" },
      { field: "thread_ts", op: "eq", value: "1750000000.123456" },
    ]);
    expect(body.target).toEqual({ kind: "assistant", assistant: "user", follow: false, deliveryPolicy: "always", pauseOnOverlap: true, thread: { mode: "own" } });
  });

  it("opens a stored thread follow with its channel and thread under the link field", () => {
    renderEditor({
      kind: "edit",
      line: line("t1", {
        name: "Rollout thread",
        eventKeys: ["slack.message"],
        filters: [{ field: "channel", op: "eq", value: "C123ABC" }, { field: "thread_ts", op: "eq", value: "1750000000.123456" }],
        target: { kind: "assistant", assistant: "user", follow: false, thread: { mode: "own" } },
      }),
      initialSection: "when",
    });
    expect(summary("when")).toBe("a reply in one Slack thread in C123ABC");
    expect(screen.getByLabelText("Paste the thread's link")).toBeTruthy();
    // The hint names the thread's start time, never the raw ts or channel id (E10).
    const hint = screen.getByText(/^Follows the thread started /);
    expect(hint.textContent).not.toContain("1750000000");
    expect(hint.textContent).not.toContain("C123ABC");
    expect(screen.getByRole("button", { name: /^Remove channel is C123ABC/ })).toBeTruthy();
  });

  it("names a channel saved without a label from the places list", () => {
    places = [{
      subject: "slack:T1/C1", label: "#incidents", service: "slack",
      parent: "slack:T1", listenerCount: 1, activeThreadCount: 0, lastActivityAt: null,
    }];
    renderEditor({
      kind: "edit",
      line: line("l2", {
        name: "Incident mentions",
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "C1" }],
        target: { kind: "assistant", assistant: "user", thread: { mode: "own" } },
      }),
    });
    expect(visibleText(screen.getAllByTestId("editor-sentence")[0]?.querySelector('[data-ref="place"]'))).toBe("#incidents");
  });

  it("fixes the service when launched from a place", () => {
    renderEditor({ kind: "create", preselected: { place: INCIDENTS } });
    expect(sentence()).toContain("#incidents");
    const services = screen.getByRole("group", { name: "Service" });
    expect(within(services).getAllByRole("button").map((b) => b.textContent)).toEqual(["Slack"]);
  });

  it("drops an added condition on a service change and the sentence names no place (Review Focus 4)", () => {
    renderEditor({ kind: "create" });
    fireEvent.click(screen.getByLabelText("Someone mentions Valet"));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a condition" }));
    fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: "channel" } });
    fireEvent.change(screen.getByLabelText("Condition value"), { target: { value: "C1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(visibleText(screen.getAllByTestId("editor-sentence")[0]?.querySelector('[data-ref="place"]'))).toBe("C1");
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(screen.queryByText("channel is C1")).toBeNull();
    expect(sentence()).not.toContain("C1");
    expect(screen.getAllByTestId("editor-sentence")[0]?.querySelector('[data-ref="place"]')).toBeNull();
    fireEvent.click(screen.getByLabelText("A check completes"));
    expect(screen.getAllByTestId("editor-sentence")[0]?.querySelector('[data-ref="place"]')).toBeNull();
  });

  describe("a workflow routine's run input", () => {
    const WORKFLOW_ROUTINE = routine("S9", {
      name: "Nightly triage",
      workflowId: "wf_1",
      detail: { targetKind: "workflow", prompt: undefined, input: { env: "prod" } },
    });

    it("shows the stored input and saves an edit", () => {
      renderEditor({ kind: "edit-routine", routine: WORKFLOW_ROUTINE, initialSection: "do" });
      const field = screen.getByLabelText("Run input (JSON)") as HTMLTextAreaElement;
      expect(JSON.parse(field.value)).toEqual({ env: "prod" });
      fireEvent.change(field, { target: { value: '{"env": "staging"}' } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      const { body } = updateSchedule.mock.calls[0]?.[0] as { body: UpdateWorkflowScheduleRequest };
      expect(body).toEqual({ input: { env: "staging" } });
    });

    it("clears the stored input when the field is emptied", () => {
      renderEditor({ kind: "edit-routine", routine: WORKFLOW_ROUTINE, initialSection: "do" });
      fireEvent.change(screen.getByLabelText("Run input (JSON)"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      const { body } = updateSchedule.mock.calls[0]?.[0] as { body: UpdateWorkflowScheduleRequest };
      expect(body).toEqual({ input: null });
    });

    it("blocks Save while the input is not valid JSON", () => {
      renderEditor({ kind: "edit-routine", routine: WORKFLOW_ROUTINE, initialSection: "do" });
      fireEvent.change(screen.getByLabelText("Run input (JSON)"), { target: { value: "{env" } });
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText("The run input is not valid JSON.")).toBeTruthy();
    });

    it("sends the input on create", () => {
      renderEditor({ kind: "create", preselected: { schedule: true, workflowId: "wf_1" } });
      fireEvent.click(screen.getByRole("button", { name: "Change Do" }));
      fireEvent.change(screen.getByLabelText("Run input (JSON)"), { target: { value: '{"env": "prod"}' } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const body = createSchedule.mock.calls[0]?.[0] as CreateWorkflowScheduleRequest;
      expect(body.target).toEqual({ kind: "workflow", workflowId: "wf_1", input: { env: "prod" } });
    });
  });

  it("closes on Esc at once with no changes (Review Focus 5)", () => {
    const { onOpenChange } = renderEditor({ kind: "edit", line: CHECK_LINE });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe("returns focus to the button that opened it (L5)", () => {
    function Launcher({ mode }: { mode: EditorMode }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open editor</button>
          <LineEditor open={open} onOpenChange={setOpen} mode={mode} />
        </>
      );
    }

    function openFromButton(mode: EditorMode): HTMLElement {
      render(<Launcher mode={mode} />);
      const button = screen.getByRole("button", { name: "Open editor" });
      button.focus();
      fireEvent.click(button);
      expect(screen.getByRole("dialog")).toBeTruthy();
      return button;
    }

    it("after Esc on a clean draft", async () => {
      const button = openFromButton({ kind: "edit", line: CHECK_LINE });
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(button));
    });

    it("after Discard", async () => {
      const button = openFromButton({ kind: "edit", line: CHECK_LINE });
      fireEvent.click(screen.getByRole("button", { name: "Change Name" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Renamed" } });
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(button));
    });

    it("after Cancel on a clean draft", async () => {
      const button = openFromButton({ kind: "edit", line: CHECK_LINE });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(button));
    });
  });

  it("ignores Esc while a request is pending (E8)", () => {
    pendingRequest = true;
    const { onOpenChange } = renderEditor({ kind: "edit", line: CHECK_LINE });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard your changes?")).toBeNull();
  });

  it("asks before Esc discards changes (Review Focus 5)", () => {
    const { onOpenChange } = renderEditor({ kind: "edit", line: CHECK_LINE });
    fireEvent.click(screen.getByRole("button", { name: "Change Name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "CI" } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Discard your changes?")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard your changes?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("turns a proposal on in review mode and names the line it replaces", () => {
    const proposal = line("proposal-1", { name: "New CI", enabled: false, eventKeys: ["github.check_run.completed"], target: { kind: "assistant", assistant: "user", thread: { mode: "own" } } });
    subscriptions = [line("l0", { name: "Old CI", enabled: true })];
    renderEditor({ kind: "review", line: proposal, replaces: { id: "l0", name: "Old CI" } });
    expect(screen.getByRole("note").textContent).toBe("Proposed by the assistant. Turning it on turns off Old CI.");
    const shown = sentence();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    const { body } = patchSubscription.mock.calls[0]?.[0] as { body: PatchEventSubscriptionRequest };
    expect(body).toEqual({ enabled: true });
    expect(shown).toBe(presenceSentence(applyLinePatch(proposal, body), catalogData.services, [], {}));
  });

  it.each([
    ["deleted", [] as EventSubscriptionWire[], "The line this proposal replaces is gone. Delete this proposal and make a new line."],
    [
      "already off",
      [line("l0", { name: "Old CI", enabled: false })],
      "Old CI is already off. Turning this on could leave two versions replying. Delete this proposal and ask the assistant for a new one.",
    ],
  ])("offers no Turn on when the replaced line is %s", (_case, rows, text) => {
    subscriptions = rows;
    const proposal = line("proposal-2", {
      name: "New CI", enabled: false, eventKeys: ["github.check_run.completed"],
      target: { kind: "assistant", assistant: "user", thread: { mode: "own" }, replaces: "l0" },
    });
    renderEditor({ kind: "review", line: proposal, ...(rows.length > 0 ? { replaces: { id: "l0", name: "Old CI" } } : {}) });
    expect(screen.getByRole("note").textContent).toBe(`Proposed by the assistant. ${text}`);
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("edits a routine and reads the patched routine", () => {
    const r = routine("r1", { name: "Morning summary", detail: { cron: "0 9 * * 1-5" } });
    renderEditor({ kind: "edit-routine", routine: r });
    expect(summary("when")).toBe("Every weekday at 9:00");
    expect(sectionNames()).toEqual(["when", "do", "where", "name"]);
    fireEvent.click(screen.getByRole("button", { name: "Change When" }));
    fireEvent.click(screen.getByLabelText("Sun"));
    const shown = sentence();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const { body } = updateSchedule.mock.calls[0]?.[0] as { body: UpdateWorkflowScheduleRequest };
    expect(body).toEqual({ cron: "0 9 * * 0,1,2,3,4,5" });
    expect(shown).toBe(routineSentence(applyRoutinePatch(r, body), [], {}));
  });

  it("shows a 409 collision in the side pane with Create anyway", () => {
    renderEditor({ kind: "create" });
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    fireEvent.click(screen.getByLabelText("A check completes"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const other = line("l2", { name: "Review follow-up", eventKeys: ["github.check_run.completed"], filters: [{ field: "repo", op: "eq", value: "acme/api" }] });
    const collisions = { blocking: [{ subscription: other, relation: "equal" as const, sharedKeys: ["github.check_run.completed"] }], overlapping: [] };
    act(() => createSubscription.mock.calls[0]?.[1].onError(new ApiError(409, "collision", { error: "collides", collisions })));
    const aside = screen.getByRole("complementary", { name: "Preview" });
    expect(aside.textContent).toContain("Review follow-up also acts on completed checks for acme/api. Both will run.");
    // One phrase for the way out: the button's own label (L8).
    expect(aside.textContent).toContain("or select Create anyway. Then both lines run.");
    expect(aside.textContent).not.toContain("keep both");
    fireEvent.click(screen.getByRole("button", { name: "Create anyway" }));
    expect(createSubscription.mock.calls[1]?.[0]).toMatchObject({ allowCollision: true });
  });

  describe("a save that stored the line with overlaps (E2)", () => {
    function createWithOverlap() {
      const handlers = renderEditor({ kind: "create" });
      fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
      fireEvent.click(screen.getByLabelText("A check completes"));
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const other = line("l2", { name: "Review follow-up", eventKeys: ["github.check_run.completed"] });
      const collisions = { blocking: [], overlapping: [{ subscription: other, relation: "partial" as const, sharedKeys: ["github.check_run.completed"] }] };
      act(() => createSubscription.mock.calls[0]?.[1].onSuccess({ id: "sub_new", collisions }));
      return handlers;
    }

    it("freezes the form and offers one Done that reports the line once", () => {
      const { onSaved, onOpenChange } = createWithOverlap();
      expect(screen.getByText("Saved.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
      const check = screen.getByLabelText("A check completes") as HTMLInputElement;
      expect(check.closest("fieldset")?.disabled).toBe(true);
      // A change would clear the notice and bring Create back; the frozen form takes none.
      fireEvent.click(check);
      expect(screen.getByText("Saved.")).toBeTruthy();
      expect(onSaved).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onSaved).toHaveBeenCalledWith({ kind: "line", id: "sub_new" });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(createSubscription).toHaveBeenCalledTimes(1);
    });

    it("closes on Esc with no discard prompt, and reports the line", () => {
      const { onSaved, onOpenChange } = createWithOverlap();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      expect(screen.queryByText("Discard your changes?")).toBeNull();
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("stacks the panes on a phone with the sentence as a sticky header", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderEditor({ kind: "edit", line: CHECK_LINE });
    expect(screen.getByRole("dialog").getAttribute("data-layout")).toBe("phone");
    const header = screen.getByTestId("editor-phone-header");
    expect(header.className).toContain("sticky");
    expect(visibleText(within(header).getByTestId("editor-sentence"))).toBe("When a check completes on acme/api, work in its own thread.");
    expect(screen.getAllByTestId("editor-sentence")).toHaveLength(1);
    expect(screen.queryByRole("complementary", { name: "Preview" })).toBeNull();
    // The form comes before the rest of the side pane.
    const name = document.querySelector('[data-section="name"]');
    const save = screen.getByRole("button", { name: "Save" });
    expect(name !== null && (name.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });
});
