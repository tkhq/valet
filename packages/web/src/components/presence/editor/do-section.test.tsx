// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { CatalogService } from "~/components/events/subscription-match";
import { line } from "../test-fixtures";
import { draftFromLine, newDraft, setService, toggleEvent, type Draft, type EditorMode } from "./draft";
import { DoSection, type AssistantOption } from "./do-section";

const SERVICES: CatalogService[] = [
  { service: "github", entries: [{ key: "github.check_run.completed", description: "Check", filters: [{ field: "repo" }, { field: "head_branch" }] }] },
];

let latest: Draft | undefined;

function Harness({ initial, mode = { kind: "create" }, assistants = [] }: { initial: Draft; mode?: EditorMode; assistants?: AssistantOption[] }) {
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

  it("shows the workflow picker for Run a workflow and hides the instructions", () => {
    render(<Harness initial={github()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Run a workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow"), { target: { value: "wf_1" } });
    expect(latest?.doKind).toBe("workflow");
    expect(latest?.workflowId).toBe("wf_1");
    expect(screen.queryByLabelText(/Instructions/)).toBeNull();
  });

  it("inserts a detail from the event at the cursor", async () => {
    render(<Harness initial={{ ...github(), instructions: "Fix " }} />);
    const box = screen.getByLabelText("Instructions (optional)") as HTMLTextAreaElement;
    expect(screen.getByText("Plain words.")).toBeTruthy();
    box.setSelectionRange(4, 4);
    await userEvent.click(screen.getByRole("button", { name: "Insert a detail from the event" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Head branch" }));
    expect(latest?.instructions).toBe("Fix {{refs.head_branch}}");
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

  it("keeps what a stored line does fixed", () => {
    const sub = line("l1", { eventKeys: ["github.check_run.completed"], target: { kind: "assistant", assistant: "user" } });
    render(<Harness initial={draftFromLine(sub)} mode={{ kind: "edit", line: sub }} />);
    expect((screen.getByRole("radio", { name: "Run a workflow" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/To change what Valet does, delete this line and make a new one/)).toBeTruthy();
  });
});
