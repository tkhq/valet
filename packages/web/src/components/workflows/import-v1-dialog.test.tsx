// @vitest-environment jsdom
/**
 * The V1 import dialog: a paste it cannot read is refused with the reason, a
 * converted workflow shows its checklist before anything is created, and
 * confirming creates the workflow and the editor message that carries the
 * checklist. The import creates no schedules: each V1 schedule is a
 * checklist line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  'The import creates no schedules, so it did not create V1 schedule "Every night" (0 3 * * *). Add it in Triggers after you finish the other items in this list.';

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

  it("creates the workflow and no schedule, sends the checklist to the editor, then opens it", async () => {
    const ensure = vi.spyOn(api, "ensureWorkflowConversation").mockResolvedValue({ sessionId: "sess_1", threadId: "thr_1" });
    const send = vi.spyOn(api, "sendPrompt").mockResolvedValue({ messageId: "m1", threadId: "thr_1", activityAt: 0 });
    const scheduleRoute = vi.spyOn(api, "createWorkflowSchedule").mockRejectedValue(new Error("the import must not create a schedule"));
    paste(V1_PASTE);
    fireEvent.click(screen.getByRole("button", { name: "Import 1 workflow" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/workflows/$workflowId", params: { workflowId: "wf_new" } }));
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
});
