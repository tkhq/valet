// @vitest-environment jsdom
/**
 * The V1 import dialog: a paste it cannot read is refused with the reason, a
 * converted workflow shows its checklist before anything is created, and
 * confirming creates the workflow, its schedule, and the editor message that
 * carries the checklist.
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

const V1_PASTE = [
  JSON.stringify({
    workflows: [
      {
        id: "wf_1",
        name: "Nightly triage",
        enabled: true,
        data: {
          steps: [
            { id: "triage", type: "agent_message", content: "Triage the open issues." },
            { id: "notify", type: "tool", tool: "send_message", arguments: { targetSessionId: "s1", content: "done" } },
          ],
        },
      },
    ],
  }),
  JSON.stringify({
    triggers: [{ name: "Every night", enabled: true, workflowId: "wf_1", config: { type: "schedule", cron: "0 3 * * *" } }],
  }),
].join("\n");

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

  it("shows each workflow with its schedule and checklist before it creates anything", () => {
    paste(V1_PASTE);

    expect(screen.getByText("Nightly triage")).toBeTruthy();
    expect(screen.getByText("Schedules: Every night (0 3 * * *)")).toBeTruthy();
    expect(screen.getByText(/sent "done" to V1 session s1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 1 workflow" })).toBeTruthy();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("creates the workflow and its schedule, sends the checklist to the editor, then opens it", async () => {
    const ensure = vi.spyOn(api, "ensureWorkflowConversation").mockResolvedValue({ sessionId: "sess_1", threadId: "thr_1" });
    const send = vi.spyOn(api, "sendPrompt").mockResolvedValue({ messageId: "m1", threadId: "thr_1", activityAt: 0 });
    paste(V1_PASTE);
    fireEvent.click(screen.getByRole("button", { name: "Import 1 workflow" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/workflows/$workflowId", params: { workflowId: "wf_new" } }));
    expect(createWorkflow).toHaveBeenCalledWith({
      name: "Nightly triage",
      definition: expect.objectContaining({ version: "dag/v1" }),
    });
    expect(createSchedule).toHaveBeenCalledWith({
      name: "Every night",
      cron: "0 3 * * *",
      timezone: undefined,
      target: { kind: "workflow", workflowId: "wf_new" },
    });
    expect(ensure).toHaveBeenCalledWith("wf_new");
    expect(send).toHaveBeenCalledWith("sess_1", {
      threadId: "thr_1",
      text: expect.stringContaining('- Step "notify" sent "done" to V1 session s1'),
    });
  });

  it("names what it already created when a later call fails", async () => {
    vi.spyOn(api, "ensureWorkflowConversation").mockResolvedValue({ sessionId: "sess_1", threadId: "thr_1" });
    vi.spyOn(api, "sendPrompt").mockResolvedValue({ messageId: "m1", threadId: "thr_1", activityAt: 0 });
    createSchedule.mockRejectedValue(new Error("cron is invalid"));
    paste(V1_PASTE);
    fireEvent.click(screen.getByRole("button", { name: "Import 1 workflow" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain('Valet created the workflow "Nightly triage" before this error'));
    expect(navigate).not.toHaveBeenCalled();
  });
});
