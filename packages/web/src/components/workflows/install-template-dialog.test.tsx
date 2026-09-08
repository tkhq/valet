// @vitest-environment jsdom
/**
 * Who owns a workflow installed from a template.
 *
 * The nav's workspace switcher is the only control that answers this, so
 * the dialog has to send its team id with the install. Dropping it is not
 * visible in the dialog: the install succeeds, and the workflow lands in
 * the installer's own workspace instead of the team's. The team's Workflows
 * page then reads empty, the server's team-readiness gate never runs, and a
 * second install into another team is numbered "(2)" because both landed on
 * the same personal owner.
 *
 * The input-less template has its own case. The body used to be built as
 * `inputs.length > 0 ? { inputs } : {}`, so an owner field added carelessly
 * survives only on templates that ask a question.
 *
 * `useNavigate` and `useWorkspaceScope` are mocked the way
 * `new-workflow-dialog.test.tsx` does, since these tests care that the
 * install carried the right owner, not that a router or a provider resolved
 * it. `ApiError` stays real: reading the server's refusal off its payload is
 * what the last case is about.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { WorkflowTemplateSummary } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const navigate = vi.fn();
const installMutateAsync = vi.fn();

/** The active workspace, rewritten per test before the dialog renders. */
let teamId: string | undefined;

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));

vi.mock("~/api/templates", () => ({
  useInstallTemplate: () => ({ mutateAsync: installMutateAsync, isPending: false }),
}));

vi.mock("~/lib/workspace-scope", () => ({
  useWorkspaceScope: () => ({ teamId }),
}));

import { InstallTemplateDialog } from "./install-template-dialog";

/** Runs when a person starts it, and asks one question. */
const withInput: WorkflowTemplateSummary = {
  id: "batch-action-over-inputs",
  name: "Batch action over inputs",
  description: "Runs one judgement over every row you paste in.",
  steps: ["Take the rows", "Judge each row", "Roll the results up"],
  schedule: null,
  requires: [],
  inputs: [
    {
      name: "instruction",
      type: "string",
      label: "What to do with each row",
      placeholder: "Tier this account as enterprise, mid-market or SMB",
      required: true,
    },
  ],
  caveats: [],
};

/** The same install with nothing to type: the case that carries no body. */
const withoutInputs: WorkflowTemplateSummary = {
  id: "nightly-memory-sweep",
  name: "Nightly memory sweep",
  description: "Cleans up your memory every night: merges duplicates and prunes stale notes.",
  steps: ["Read the memory tree", "Merge duplicates and prune stale notes", "Report what changed"],
  schedule: { cron: "0 6 * * *", timezone: "UTC" },
  requires: [],
  inputs: [],
  caveats: [],
};

interface InstallCall {
  templateId: string;
  body?: { inputs?: Record<string, unknown>; teamId?: string };
}

function renderDialog(template: WorkflowTemplateSummary) {
  const onOpenChange = vi.fn();
  render(<InstallTemplateDialog template={template} open onOpenChange={onOpenChange} />);
  return onOpenChange;
}

function installCall(): InstallCall {
  return installMutateAsync.mock.calls[0]![0] as InstallCall;
}

beforeEach(() => {
  navigate.mockReset();
  installMutateAsync.mockReset();
  installMutateAsync.mockResolvedValue({ workflowId: "wf_new", workflowName: "Installed" });
  teamId = undefined;
});

describe("InstallTemplateDialog", () => {
  it("installs into the team the workspace switcher names", async () => {
    teamId = "team_ops";
    renderDialog(withInput);
    fireEvent.change(screen.getByLabelText("What to do with each row"), {
      target: { value: "Tier each account" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(installMutateAsync).toHaveBeenCalledTimes(1));
    expect(installCall().body).toEqual({
      inputs: { instruction: "Tier each account" },
      teamId: "team_ops",
    });
  });

  it("names no team in personal scope", async () => {
    renderDialog(withInput);
    fireEvent.change(screen.getByLabelText("What to do with each row"), {
      target: { value: "Tier each account" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(installMutateAsync).toHaveBeenCalledTimes(1));
    const body = installCall().body;
    expect(body).toEqual({ inputs: { instruction: "Tier each account" } });
    expect(body && "teamId" in body).toBe(false);
  });

  it("installs into the team even when the template asks nothing", async () => {
    teamId = "team_ops";
    renderDialog(withoutInputs);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(installMutateAsync).toHaveBeenCalledTimes(1));
    expect(installCall().body).toEqual({ teamId: "team_ops" });
  });

  it("sends no body at all for a personal install of a template that asks nothing", async () => {
    renderDialog(withoutInputs);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(installMutateAsync).toHaveBeenCalledTimes(1));
    expect(installCall().body).toEqual({});
  });

  it("keeps the dialog open with the server's refusal of a team install", async () => {
    teamId = "team_ops";
    installMutateAsync.mockRejectedValue(
      new ApiError(400, "POST /api/templates/nightly-memory-sweep/install → 400", {
        error: "Connect Gmail for this team in Integrations, then install this template.",
      }),
    );
    const onOpenChange = renderDialog(withoutInputs);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(
        screen.getByText("Connect Gmail for this team in Integrations, then install this template."),
      ).toBeTruthy(),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
