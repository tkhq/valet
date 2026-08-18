// @vitest-environment jsdom
/**
 * The template gallery, covering the states that decide whether somebody
 * ends up with a working workflow or a broken one: nothing to offer, a
 * service the caller has not connected, and an install the server refuses.
 *
 * `<Link>`/`useNavigate` need router context — mocked the same way
 * `-workflows.index.test.tsx` does, since these tests only care that
 * navigation was requested, not that the router resolved it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListWorkflowTemplatesResponse, WorkflowTemplateSummary } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const navigate = vi.fn();
const installMutateAsync = vi.fn();
const templatesQuery: {
  data: ListWorkflowTemplatesResponse | undefined;
  isLoading: boolean;
  error: Error | null;
} = { data: undefined, isLoading: false, error: null };

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
}));

vi.mock("~/api/templates", () => ({
  useWorkflowTemplates: () => templatesQuery,
  useInstallTemplate: () => ({ mutateAsync: installMutateAsync, isPending: false }),
}));

import { TemplateGallery } from "./template-gallery";

const memorySweep: WorkflowTemplateSummary = {
  id: "nightly-memory-sweep",
  name: "Nightly memory sweep",
  description: "Cleans up your memory every night: merges duplicates and prunes stale notes.",
  steps: ["Read the memory tree", "Merge duplicates and prune stale notes", "Report what changed"],
  schedule: { cron: "0 6 * * *", timezone: "UTC" },
  requires: [],
  inputs: [],
  caveats: [],
};

const triageDigest: WorkflowTemplateSummary = {
  id: "daily-triage-digest",
  name: "Daily triage digest",
  description: "Reads Linear, Slack and GitHub each morning and writes you one digest.",
  steps: ["Read open pull requests", "Read the named Slack channels", "Write the digest"],
  schedule: { cron: "0 13 * * 1-5", timezone: "UTC" },
  requires: [
    { service: "github", connected: true },
    { service: "slack", connected: false },
    { service: "linear", connected: false, dynamic: true },
  ],
  inputs: [],
  caveats: [],
};

const batchAction: WorkflowTemplateSummary = {
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
  caveats: ["Runs over at most 100 rows. The report names anything past the cap."],
};

/**
 * The same shape, but on a timer. A scheduled run arrives with no form to
 * answer, so its required value must be supplied before the install — this
 * is the one case where the dialog holds the button.
 */
const nightlySweep: WorkflowTemplateSummary = {
  id: "nightly-sweep",
  name: "Nightly sweep",
  description: "Sweeps every night.",
  steps: ["Sweep"],
  schedule: { cron: "0 6 * * *", timezone: "UTC" },
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

beforeEach(() => {
  navigate.mockReset();
  installMutateAsync.mockReset();
  installMutateAsync.mockResolvedValue({ workflowId: "wf_new", workflowName: "Batch action" });
  templatesQuery.data = undefined;
  templatesQuery.isLoading = false;
  templatesQuery.error = null;
});

describe("TemplateGallery", () => {
  it("says there is nothing to install when the plugins ship no templates", () => {
    templatesQuery.data = { templates: [] };
    render(<TemplateGallery />);

    expect(screen.getByText(/no templates available/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use template" })).toBeNull();
  });

  it("names the corrective action when the list cannot be loaded", () => {
    templatesQuery.error = new Error("boom");
    render(<TemplateGallery />);

    expect(screen.getByText(/check that the server is running, then reload/i)).toBeTruthy();
  });

  it("shows what a template does, what it touches, and when it runs", () => {
    templatesQuery.data = { templates: [memorySweep] };
    render(<TemplateGallery />);

    expect(screen.getByText("Nightly memory sweep")).toBeTruthy();
    expect(screen.getByText(/merges duplicates and prunes stale notes/i)).toBeTruthy();
    expect(screen.getByText("Every day at 6:00 AM UTC")).toBeTruthy();
    // A template needing nothing draws no service chain. The card used to
    // spell that out in a footer line; absence of the chain says it, and the
    // Use-template button says the template is ready.
    expect(screen.queryByText("No integrations needed")).toBeNull();
    expect(screen.getByRole("button", { name: "Use template" })).toBeTruthy();
  });

  it("refuses to install a template whose services are not connected, and routes to connecting them", () => {
    templatesQuery.data = { templates: [triageDigest] };
    render(<TemplateGallery />);

    // The prose that repeated this is gone; the control still names the work.
    expect(screen.queryByRole("button", { name: "Use template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use template" })).toBeNull();

    const connect = screen.getByText("Connect integrations").closest("a");
    expect(connect?.getAttribute("to") ?? connect?.getAttribute("href")).toBe("/integrations");
  });

  it("names the one service to connect when only one is missing", () => {
    templatesQuery.data = {
      templates: [
        {
          ...triageDigest,
          requires: [
            { service: "github", connected: true },
            { service: "slack", connected: false },
          ],
        },
      ],
    };
    render(<TemplateGallery />);

    // One missing service names itself on the button rather than in a
    // sentence above it.
    expect(screen.getByText("Connect Slack")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use template" })).toBeNull();
  });

  it("shows the steps and the limits before installing", () => {
    templatesQuery.data = { templates: [batchAction] };
    render(<TemplateGallery />);
    fireEvent.click(screen.getByRole("button", { name: "Use template" }));

    // Scoped to the dialog: the card behind it carries the same cadence.
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Judge each row")).toBeTruthy();
    expect(dialog.getByText(/runs over at most 100 rows/i)).toBeTruthy();
    expect(dialog.getByText("Runs when you start it")).toBeTruthy();
  });

  it("installs a template that runs on demand without answering its fields first", async () => {
    // The field is declared `required`, but this template runs when a person
    // starts it, so the run form asks for it. Holding the install button
    // would stop somebody installing a template to read it and edit it.
    templatesQuery.data = { templates: [batchAction] };
    render(<TemplateGallery />);
    fireEvent.click(screen.getByRole("button", { name: "Use template" }));

    expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // No asterisk either: nothing here is required to install.
    const field = screen.getByLabelText("What to do with each row") as HTMLInputElement;
    expect(field.placeholder).toBe("Tier this account as enterprise, mid-market or SMB");

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(installMutateAsync).toHaveBeenCalledTimes(1));
    expect(installMutateAsync.mock.calls[0]![0]).toEqual({
      templateId: "batch-action-over-inputs",
      body: { inputs: {} },
    });
  });

  it("holds the install of a SCHEDULED template until its required field is answered", async () => {
    // A timer brings no form, so this value has nowhere else to come from.
    templatesQuery.data = { templates: [nightlySweep] };
    render(<TemplateGallery />);
    fireEvent.click(screen.getByRole("button", { name: "Use template" }));

    expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("What to do with each row *"), {
      target: { value: "Tier each account" },
    });
    expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("sends the values a person did supply, and opens the installed workflow", async () => {
    templatesQuery.data = { templates: [batchAction] };
    render(<TemplateGallery />);
    fireEvent.click(screen.getByRole("button", { name: "Use template" }));

    fireEvent.change(screen.getByLabelText("What to do with each row"), {
      target: { value: "Tier each account" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(installMutateAsync).toHaveBeenCalledTimes(1));
    expect(installMutateAsync.mock.calls[0]![0]).toEqual({
      templateId: "batch-action-over-inputs",
      body: { inputs: { instruction: "Tier each account" } },
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_new" },
      }),
    );
  });

  it("keeps the dialog open with the server's message when the install fails", async () => {
    templatesQuery.data = { templates: [batchAction] };
    installMutateAsync.mockRejectedValue(
      new ApiError(400, "POST /api/templates/batch-action-over-inputs/install → 400", {
        error: "Connect Gmail in Integrations, then install this template again.",
      }),
    );
    render(<TemplateGallery />);
    fireEvent.click(screen.getByRole("button", { name: "Use template" }));
    fireEvent.change(screen.getByLabelText("What to do with each row"), {
      target: { value: "Tier each account" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(
        screen.getByText("Connect Gmail in Integrations, then install this template again."),
      ).toBeTruthy(),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  });
});
