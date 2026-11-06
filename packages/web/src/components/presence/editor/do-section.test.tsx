// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MAX_PROMPT_TEMPLATE_CHARS } from "@valet/shared";
import { describe, expect, it } from "vitest";
import type { CatalogService } from "~/components/events/subscription-match";
import type { HandlerOption } from "~/components/plugins/handler-settings";
import { line } from "../test-fixtures";
import { draftFromLine, newDraft, setService, toggleEvent, type Draft, type EditorMode } from "./draft";
import { DoSection, EVENT_MESSAGE_VARIABLE, eventMessageDetails, type AssistantOption } from "./do-section";

const SERVICES: CatalogService[] = [
  { service: "github", entries: [{ key: "github.check_run.completed", description: "Check", filters: [{ field: "repo" }, { field: "head_branch" }] }] },
  { service: "github", entries: [{ key: "github.pull_request.opened", description: "PR opened", filters: [{ field: "repo" }] }] },
];

const REVIEW: HandlerOption = {
  plugin: "pr-review",
  id: "review-pull-request",
  label: "PR review: Review pull request",
  description: "Review each push to a pull request.",
  events: ["github.pull_request.opened", "github.pull_request.unlisted"],
  configSchema: {
    type: "object",
    properties: { reviewDrafts: { type: "boolean", default: false, description: "Review draft pull requests too." } },
  },
};

let latest: Draft | undefined;

function Harness({ initial, mode = { kind: "create" }, assistants = [], handlers = [] }: {
  initial: Draft; mode?: EditorMode; assistants?: AssistantOption[]; handlers?: HandlerOption[];
}) {
  const [draft, setDraft] = useState(initial);
  latest = draft;
  return (
    <DoSection
      draft={draft}
      mode={mode}
      onChange={setDraft}
      services={SERVICES}
      workflows={[{ id: "wf_1", name: "Triage" }]}
      assistants={assistants}
      handlers={handlers}
    />
  );
}

function github(): Draft {
  return toggleEvent(setService(newDraft({ timezone: "UTC" }), "github"), "github.check_run.completed", SERVICES);
}

describe("DoSection", () => {
  it("offers three cards with one line each, Reply only for Slack", () => {
    render(<Harness initial={github()} />);
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["Reply", "Work on it", "Run a workflow"]);
    expect((screen.getByRole("radio", { name: "Reply" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Work on it" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Start a workflow with the event as its input.")).toBeTruthy();
  });

  it("offers Reply only once a mention is picked (E7)", () => {
    const message: Draft = { ...toggleEvent(newDraft({ timezone: "UTC" }), "slack.message", SERVICES), doKind: "work" };
    const { unmount } = render(<Harness initial={message} />);
    expect((screen.getByRole("radio", { name: "Reply" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Reply answers a mention. To reply, pick the mention in When.")).toBeTruthy();
    unmount();
    render(<Harness initial={toggleEvent(message, "slack.app_mention", SERVICES)} />);
    expect((screen.getByRole("radio", { name: "Reply" }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText("Reply answers a mention. To reply, pick the mention in When.")).toBeNull();
  });

  it("shows the workflow picker for Run a workflow and hides the instructions", () => {
    render(<Harness initial={github()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Run a workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow"), { target: { value: "wf_1" } });
    expect(latest?.doKind).toBe("workflow");
    expect(latest?.workflowId).toBe("wf_1");
    expect(screen.queryByLabelText(/Instructions/)).toBeNull();
  });

  it("gives the instructions no insert menu, because they take no text from the event", () => {
    render(<Harness initial={github()} />);
    expect(screen.getByLabelText("Instructions (optional)")).toBeTruthy();
    expect(screen.getByText("Plain words. Valet also receives the event itself.")).toBeTruthy();
    // The only insert menu sits under the event message in Advanced.
    const menu = screen.getByRole("button", { name: "Insert a detail from the event" });
    expect(menu.closest("details")?.textContent).toContain("Event message (optional)");
  });

  it("inserts a detail the api accepts into the event message, at the cursor", async () => {
    render(<Harness initial={{ ...github(), promptTemplates: { userPromptTemplate: "Branch: " } }} />);
    const box = screen.getByLabelText("Event message (optional)") as HTMLTextAreaElement;
    box.setSelectionRange(8, 8);
    await userEvent.click(screen.getByRole("button", { name: "Insert a detail from the event" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "The event's summary", "The event's text", "Repository", "Head branch",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Head branch" }));
    expect(latest?.promptTemplates.userPromptTemplate).toBe("Branch: {{payload.head_branch}}");
    expect(latest?.instructions).toBe("");
  });

  it("offers only templates in the api's allow-list", () => {
    const templates = eventMessageDetails(github(), SERVICES).map((d) => d.template);
    expect(templates).toEqual(["{{event.summary}}", "{{event.body}}", "{{payload.repo}}", "{{payload.head_branch}}"]);
    for (const t of templates) expect(EVENT_MESSAGE_VARIABLE.test(t.slice(2, -2))).toBe(true);
  });

  it("shows keyboard focus on a Do card", () => {
    render(<Harness initial={github()} />);
    expect(screen.getByRole("radio", { name: "Work on it" }).closest("label")?.className).toContain("has-[:focus-visible]:ring-2");
  });

  it("requires instructions for a routine on the assistant", () => {
    render(<Harness initial={newDraft({ preselected: { schedule: true }, timezone: "UTC" })} />);
    expect(screen.getByLabelText("Instructions (required)")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Insert a detail from the event" })).toBeNull();
  });

  it("offers the assistant choice only when there is more than one", () => {
    const { unmount } = render(<Harness initial={github()} assistants={[{ value: "user", label: "Your assistant" }]} />);
    expect(screen.queryByRole("radiogroup", { name: "Assistant" })).toBeNull();
    unmount();
    render(
      <Harness
        initial={github()}
        assistants={[
          { value: "user", label: "Your assistant" },
          { value: "team", label: "Platform's assistant", teamId: "t1" },
          { value: "org", label: "The organization's assistant" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Platform's assistant" }));
    expect(latest?.assistant).toBe("team");
    expect(latest?.teamId).toBe("t1");
  });

  it("locks Do on the workflow a workflow's panel fixed (L4)", () => {
    const mode: EditorMode = { kind: "create", preselected: { fixedWorkflowId: "wf_1" } };
    const draft = toggleEvent(setService(newDraft({ timezone: "UTC", preselected: mode.preselected }), "github"), "github.check_run.completed", SERVICES);
    render(<Harness initial={draft} mode={mode} />);
    const run = screen.getByRole("radio", { name: "Run a workflow" }) as HTMLInputElement;
    expect(run.checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Work on it" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Reply" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Work on it" }));
    expect(latest?.doKind).toBe("workflow");
    const picker = screen.getByLabelText("Workflow") as HTMLSelectElement;
    expect(picker.disabled).toBe(true);
    expect(picker.selectedOptions[0]?.textContent).toBe("Triage");
    expect(screen.getByText("This line starts Triage. To pick another workflow, add the line from Presence.")).toBeTruthy();
  });

  it("only preselects a workflow without the lock", () => {
    const draft = setService(newDraft({ timezone: "UTC", preselected: { workflowId: "wf_1" } }), "github");
    render(<Harness initial={draft} mode={{ kind: "create", preselected: { workflowId: "wf_1" } }} />);
    expect((screen.getByRole("radio", { name: "Work on it" }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Workflow") as HTMLSelectElement).disabled).toBe(false);
  });

  it("shows what a stored line does as one fixed card, with how to change it inside the card", () => {
    const sub = line("l1", { eventKeys: ["github.check_run.completed"], target: { kind: "assistant", assistant: "user" } });
    render(<Harness initial={draftFromLine(sub)} mode={{ kind: "edit", line: sub }} />);
    expect(screen.queryByRole("radiogroup", { name: "Do" })).toBeNull();
    const note = screen.getByText("This stays fixed. To change it, delete this line and make a new one.");
    // The note sits in the card that names the choice, above the instructions, not floating over them.
    expect(note.parentElement?.textContent).toContain("Work on it");
    const instructions = screen.getByLabelText("Instructions (optional)");
    expect(note.compareDocumentPosition(instructions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(instructions.parentElement?.contains(note)).toBe(false);
  });

  it("counts the instructions near the api's limit and says what to do past it", () => {
    render(<Harness initial={github()} />);
    const box = screen.getByLabelText("Instructions (optional)") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "x".repeat(100) } });
    expect(screen.queryByText(/of 4,000 characters/)).toBeNull();
    fireEvent.change(box, { target: { value: "x".repeat(3_500) } });
    expect(screen.getByText("3,500 of 4,000 characters")).toBeTruthy();
    expect(box.getAttribute("aria-invalid")).not.toBe("true");
    fireEvent.change(box, { target: { value: "x".repeat(MAX_PROMPT_TEMPLATE_CHARS + 512) } });
    const error = screen.getByText(
      "Too long: 4,512 of 4,000 characters. Shorten it or move details into a skill.",
    );
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    // The note sits with the field, not in the footer.
    expect(error.parentElement?.contains(box)).toBe(true);
  });

  it("counts no limit for a routine's instructions, which the api does not cap", () => {
    const draft = setService(newDraft({ timezone: "UTC" }), "schedule");
    render(<Harness initial={{ ...draft, doKind: "work", instructions: "x".repeat(MAX_PROMPT_TEMPLATE_CHARS + 1) }} mode={{ kind: "create", preselected: { schedule: true } }} />);
    expect(screen.queryByText(/limit is 4,000/)).toBeNull();
    expect(screen.queryByText(/of 4,000 characters/)).toBeNull();
  });

  it("gives the instructions six rows at least", () => {
    const draft = setService(newDraft({ timezone: "UTC" }), "schedule");
    render(<Harness initial={{ ...draft, doKind: "work" }} mode={{ kind: "create", preselected: { schedule: true } }} />);
    expect((screen.getByLabelText("Instructions (required)") as HTMLTextAreaElement).rows).toBe(6);
  });

  it("offers Run a plugin when a plugin declares a handler, and picks its events and settings", async () => {
    render(<Harness initial={github()} handlers={[REVIEW]} />);
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["Reply", "Work on it", "Run a workflow", "Run a plugin"]);
    fireEvent.click(screen.getByRole("radio", { name: "Run a plugin" }));
    expect(latest?.doKind).toBe("plugin");
    expect(latest?.handler).toEqual({ plugin: "pr-review", handler: "review-pull-request" });
    // Only the handler's events the catalog lists.
    expect([...latest!.events]).toEqual(["github.pull_request.opened"]);
    expect(screen.queryByLabelText(/Instructions/)).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "Review drafts" }));
    expect(latest?.handlerConfig).toEqual({ reviewDrafts: true });
  });

  it("hides Run a plugin when no plugin declares a handler", () => {
    render(<Harness initial={github()} />);
    expect(screen.queryByRole("radio", { name: "Run a plugin" })).toBeNull();
  });

  it("keeps a stored plugin line's handler fixed and its settings editable", async () => {
    const stored = line("l-review", {
      eventKeys: ["github.pull_request.opened"],
      target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request", config: { reviewDrafts: true } },
    });
    render(<Harness initial={draftFromLine(stored)} mode={{ kind: "edit", line: stored }} handlers={[REVIEW]} />);
    expect(screen.getByText("Run a plugin")).toBeTruthy();
    expect((screen.getByLabelText("Plugin handler") as HTMLSelectElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("switch", { name: "Review drafts" }));
    expect(latest?.handlerConfig).toEqual({});
  });
});
