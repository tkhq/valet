// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkflowDefinition } from "@valet/workflow";
import { ChangeOrchestratorDialog } from "./change-orchestrator-dialog";
const { save, close } = vi.hoisted(() => ({ save: vi.fn(), close: vi.fn() }));
vi.mock("~/api/assistants", () => ({ useAssistants: () => ({ data: { assistants: [
  { id: "selected", name: "Reviewer", owner: { type: "team", id: "team-1" }, isDefault: false },
  { id: "foreign", name: "Other team", owner: { type: "team", id: "team-2" }, isDefault: true },
  { id: "personal", name: "Personal", owner: { type: "user", id: "u1" }, isDefault: true },
] }, isPending: false, error: null }) }));
const definition: WorkflowDefinition = { version: "dag/v1", assistantId: "archived", nodes: [{ id: "start", type: "trigger" }, { id: "end", type: "stop", outcome: "success" }], edges: [{ from: "start", to: "end" }] };
beforeEach(() => { vi.clearAllMocks(); save.mockResolvedValue(undefined); });
function show() { return render(<ChangeOrchestratorDialog definition={definition} ownerType="team" ownerId="team-1" save={save} close={close} />); }
it("recovers an unavailable target while preserving the graph and limiting choices to its owner", async () => {
  show();
  expect(screen.getByRole("button", { name: "Save orchestrator" })).toMatchObject({ disabled: true });
  expect(screen.queryByRole("option", { name: /Other team|Personal/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("Orchestrator"), { target: { value: "selected" } });
  fireEvent.click(screen.getByRole("button", { name: "Save orchestrator" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...definition, assistantId: "selected" });
});
it("keeps the recovery dialog open when the server rejects the target", async () => {
  save.mockRejectedValue(new Error("Assistant is no longer available"));
  show();
  fireEvent.change(screen.getByLabelText("Orchestrator"), { target: { value: "selected" } });
  fireEvent.click(screen.getByRole("button", { name: "Save orchestrator" }));
  await screen.findByRole("alert");
  expect(close).not.toHaveBeenCalled();
});
