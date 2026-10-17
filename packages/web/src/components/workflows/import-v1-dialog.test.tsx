// @vitest-environment jsdom
/**
 * The V1 import dialog: a paste it cannot read is refused with the reason, a
 * converted workflow shows its checklist before anything is created, and
 * confirming creates the workflow and the editor message that carries the
 * checklist. The import creates no schedules: each V1 schedule is a
 * checklist line. A failure after a workflow exists keeps the checklists on
 * screen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { api } from "~/api/client";

const navigate = vi.fn();
const createWorkflow = vi.fn();
const createSchedule = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));

vi.mock("~/api/workflows", () => ({
  useCreateWorkflow: () => ({ mutateAsync: createWorkflow, isPending: false }),
  useCreateSchedule: () => ({ mutateAsync: createSchedule, isPending: false }),
}));

import { ImportV1Dialog } from "./import-v1-dialog";

/** One V1 workflow with these steps and a nightly schedule, as pasted. */
function v1Paste(steps: unknown[]): string {
  return [
    JSON.stringify({ workflows: [{ id: "wf_1", name: "Nightly triage", enabled: true, data: { steps } }] }),
    JSON.stringify({
      triggers: [{ name: "Every night", enabled: true, workflowId: "wf_1", config: { type: "schedule", cron: "0 3 * * *" } }],
    }),
  ].join("\n");
}

const triage = { id: "triage", type: "agent_message", content: "Triage the open issues." };
// An "agent" step did nothing in V1, so the import leaves it out with a line.
const V1_PASTE = v1Paste([triage, { id: "plan", type: "agent", goal: "Plan the week." }]);
const SCHEDULE_LINE =
  'The import creates no schedules, so it did not create V1 schedule "Every night" (0 3 * * *, UTC). Add it in Triggers after you finish the other items in this list. Set its time zone to UTC. V1 used UTC because the schedule named no time zone.';

function paste(text: string): void {
  render(<ImportV1Dialog open onOpenChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("V1 JSON"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
}

beforeEach(() => {
  navigate.mockReset();
  createWorkflow.mockReset().mockResolvedValue({ id: "wf_new" });
  createSchedule.mockReset().mockResolvedValue({ schedule: {} });
  vi.restoreAllMocks();
});

describe("ImportV1Dialog", () => {
  it("refuses text it cannot read, with the reason, and creates nothing", () => {
    paste("Here is my workflow: {}");

    expect(screen.getByRole("alert").textContent).toContain("outside a JSON object");
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("shows each workflow with its checklist, schedules included, before it creates anything", () => {
    paste(V1_PASTE);

    expect(screen.getByText("Nightly triage")).toBeTruthy();
    expect(screen.getByText("1 Runtime")).toBeTruthy();
    expect(screen.getByText("2 to finish")).toBeTruthy();
    expect(screen.getByText(/Step "plan" is an "agent" step, which did nothing in V1/)).toBeTruthy();
    expect(screen.getByText(SCHEDULE_LINE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 1 workflow" })).toBeTruthy();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("requires review of manual input types instead of marking a V1 equality condition Ready", () => {
    paste(JSON.stringify({ steps: [{ id: "check", type: "conditional", condition: { variable: "value", equals: 1 } }] }));

    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.getByText("1 to finish")).toBeTruthy();
    expect(screen.getByText(/A trigger input has one type/)).toBeTruthy();
  });

  it("creates the workflow and no schedule, sends the checklist to the editor, then opens it", async () => {
    const ensure = vi.spyOn(api, "ensureWorkflowConversation").mockResolvedValue({ sessionId: "sess_1", threadId: "thr_1" });
    const send = vi.spyOn(api, "sendPrompt").mockResolvedValue({ messageId: "m1", threadId: "thr_1", activityAt: 0 });
    const scheduleRoute = vi.spyOn(api, "createWorkflowSchedule").mockRejectedValue(new Error("the import must not create a schedule"));
    paste(V1_PASTE);
    fireEvent.click(screen.getByRole("button", { name: "Import 1 workflow" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/presence/workflows/$workflowId", params: { workflowId: "wf_new" } }));
    expect(createWorkflow).toHaveBeenCalledWith({
      name: "Nightly triage",
      definition: expect.objectContaining({ version: "dag/v1" }),
    });
    expect(createSchedule).not.toHaveBeenCalled();
    expect(scheduleRoute).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith("wf_new");
    expect(send).toHaveBeenCalledWith("sess_1", {
      threadId: "thr_1",
      text: expect.stringContaining(`- Step "plan" is an "agent" step`),
    });
    expect(send.mock.calls[0]?.[1].text.endsWith(`- ${SCHEDULE_LINE}`)).toBe(true);
  });

  it("names what it already created when a later call fails", async () => {
    vi.spyOn(api, "ensureWorkflowConversation").mockResolvedValue({ sessionId: "sess_1", threadId: "thr_1" });
    vi.spyOn(api, "sendPrompt").mockRejectedValue(new Error("the editor conversation is not ready"));
    paste(V1_PASTE);
    fireEvent.click(screen.getByRole("button", { name: "Import 1 workflow" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain('Valet created the workflow "Nightly triage" before this error'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps every checklist on screen when the second editor message fails", async () => {
    createWorkflow.mockReset().mockResolvedValueOnce({ id: "wf_a" }).mockResolvedValueOnce({ id: "wf_b" });
    vi.spyOn(api, "ensureWorkflowConversation").mockResolvedValue({ sessionId: "sess_1", threadId: "thr_1" });
    vi.spyOn(api, "sendPrompt")
      .mockResolvedValueOnce({ messageId: "m1", threadId: "thr_1", activityAt: 0 })
      .mockRejectedValueOnce(new Error("the editor conversation is not ready"));
    const workflow = (id: string, name: string, goal: string) => ({ id, name, enabled: true, data: { steps: [triage, { id: "plan", type: "agent", goal }] } });
    paste(JSON.stringify({ workflows: [workflow("wf_1", "First", "Plan A."), workflow("wf_2", "Second", "Plan B.")] }));
    fireEvent.click(screen.getByRole("button", { name: "Import 2 workflows" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain('The editor conversation of "Second" did not get its checklist.'));
    expect(createWorkflow).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert").textContent).toContain('Valet created the workflow "First", the workflow "Second" before this error');
    expect(screen.getByText(/\("Plan A\."\)/)).toBeTruthy();
    expect(screen.getByText(/\("Plan B\."\)/)).toBeTruthy();
    // The workflows exist, so the dialog offers no second import.
    expect(screen.queryByRole("button", { name: /^Import/ })).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(["Escape", "outside click", "close button"])("keeps a pending import open after %s so a failed checklist stays visible", async (dismissal) => {
    let rejectPrompt: (error: Error) => void = () => { throw new Error("the second prompt has not started"); };
    const pendingPrompt = new Promise<never>((_resolve, reject) => { rejectPrompt = reject; });
    createWorkflow.mockResolvedValueOnce({ id: "wf_a" }).mockResolvedValueOnce({ id: "wf_b" });
    vi.spyOn(api, "ensureWorkflowConversation").mockResolvedValue({ sessionId: "sess_1", threadId: "thr_1" });
    const send = vi.spyOn(api, "sendPrompt")
      .mockResolvedValueOnce({ messageId: "m1", threadId: "thr_1", activityAt: 0 })
      .mockReturnValueOnce(pendingPrompt);
    function Host() {
      const [open, setOpen] = useState(true);
      return <ImportV1Dialog open={open} onOpenChange={setOpen} />;
    }
    render(<Host />);
    fireEvent.change(screen.getByLabelText("V1 JSON"), { target: { value: JSON.stringify({ workflows: [
      { id: "wf_1", name: "First", data: { steps: [{ id: "plan", type: "agent", goal: "Plan A." }] } },
      { id: "wf_2", name: "Second", data: { steps: [{ id: "plan", type: "agent", goal: "Plan B." }] } },
    ] }) } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Import 2 workflows" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    if (dismissal === "Escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    else if (dismissal === "outside click") fireEvent.pointerDown(document.body);
    else fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => { rejectPrompt(new Error("the editor conversation is not ready")); });
    expect(screen.getByRole("alert").textContent).toContain('The editor conversation of "Second" did not get its checklist.');
    expect(screen.getByText(/\("Plan B\."\)/)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});
