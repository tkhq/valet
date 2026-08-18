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

  it("renders the templates in the order the server sent them", () => {
    // The server decides the order (`WorkflowTemplate.rank`). The gallery
    // must not re-sort it, or a template ranked first would not appear
    // first.
    templatesQuery.data = { templates: [batchAction, memorySweep] };
    render(<TemplateGallery />);

    const names = screen.getAllByText(/Batch action over inputs|Nightly memory sweep/);
    expect(names.map((n) => n.textContent)).toEqual([
      "Batch action over inputs",
      "Nightly memory sweep",
    ]);
  });

  describe("a service this organization has not configured", () => {
    const needsSlackSetup: WorkflowTemplateSummary = {
      ...triageDigest,
      requires: [
        { service: "github", connected: true },
        { service: "slack", connected: false, unconfigured: true },
      ],
    };

    it("names the setup instead of offering a link that goes nowhere", () => {
      templatesQuery.data = { templates: [needsSlackSetup] };
      render(<TemplateGallery />);

      expect(screen.queryByText("Connect Slack")).toBeNull();
      expect(screen.queryByText("Connect integrations")).toBeNull();
      expect(
        screen.getByText(
          "Slack is not configured for this organization. An admin can set this up in Settings → Organization.",
        ),
      ).toBeTruthy();
    });

    it("offers no install, because the first run would fail on the missing token", () => {
      templatesQuery.data = { templates: [needsSlackSetup] };
      render(<TemplateGallery />);

      expect(screen.queryByRole("button", { name: "Use template" })).toBeNull();
    });

    it("still links the services the reader can connect", () => {
      templatesQuery.data = {
        templates: [
          {
            ...triageDigest,
            requires: [
              { service: "github", connected: false },
              { service: "slack", connected: false, unconfigured: true },
            ],
          },
        ],
      };
      render(<TemplateGallery />);

      expect(screen.getByText("Connect GitHub")).toBeTruthy();
      expect(screen.getByText(/Slack is not configured for this organization/)).toBeTruthy();
    });
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

  describe("what install takes now, and what the run form keeps", () => {
    /**
     * Install BAKES every value it is given: the server writes it into the
     * definition and drops the field from the trigger schema, so the
     * installed workflow never asks for it again. A workflow left with no
     * trigger schema gets no run form at all.
     *
     * The server only REFUSES a missing required field for a scheduled
     * template (`resolveInstallValues`), because a scheduled run applies no
     * defaults and has nobody to ask. The dialog used to refuse for every
     * template, which forced per-run answers — a pull request number, a
     * brief, a spec — into the definition and froze the workflow on the
     * first one.
     */
    const scheduledWithField: WorkflowTemplateSummary = {
      ...batchAction,
      id: "scheduled-batch",
      schedule: { cron: "0 6 * * *", timezone: "UTC" },
    };

    it("installs a manual template with the field left empty, leaving it to each run", async () => {
      templatesQuery.data = { templates: [batchAction] };
      render(<TemplateGallery />);
      fireEvent.click(screen.getByRole("button", { name: "Use template" }));

      const install = screen.getByRole("button", { name: "Install" }) as HTMLButtonElement;
      expect(install.disabled).toBe(false);
      fireEvent.click(install);

      await waitFor(() => expect(installMutateAsync).toHaveBeenCalledTimes(1));
      // Nothing baked, so the field survives on the installed workflow.
      expect(installMutateAsync.mock.calls[0]![0]).toEqual({
        templateId: "batch-action-over-inputs",
        body: { inputs: {} },
      });
    });

    it("still refuses a scheduled template with an empty required field", () => {
      // A scheduled run has no form, so this value has to be baked. The
      // server refuses the install; the dialog refuses it first.
      templatesQuery.data = { templates: [scheduledWithField] };
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

    it("says which way each field goes, before the reader types in one", () => {
      templatesQuery.data = { templates: [batchAction] };
      render(<TemplateGallery />);
      fireEvent.click(screen.getByRole("button", { name: "Use template" }));
      expect(
        within(screen.getByRole("dialog")).getByText(
          "A field you fill in is written into the workflow. A field you leave empty is asked for each time you start the workflow.",
        ),
      ).toBeTruthy();
    });

    it("tells a scheduled template's reader why every field is needed now", () => {
      templatesQuery.data = { templates: [scheduledWithField] };
      render(<TemplateGallery />);
      fireEvent.click(screen.getByRole("button", { name: "Use template" }));
      expect(
        within(screen.getByRole("dialog")).getByText(
          "This workflow runs on a schedule. A scheduled run has no form to ask, so every required field has to be set now.",
        ),
      ).toBeTruthy();
    });
  });

  describe("a card the caller cannot install", () => {
    /**
     * The steps and the caveats live ONLY in the install dialog. A card
     * that offered no way into that dialog left its reader with two clamped
     * lines of description — and that reader is the one deciding whether to
     * connect a service, or to ask an admin for one. The first card in the
     * gallery is exactly such a card wherever the org Slack app is not set
     * up.
     */
    const blocked: WorkflowTemplateSummary = {
      ...triageDigest,
      requires: [
        { service: "github", connected: false },
        { service: "slack", connected: false, unconfigured: true },
      ],
    };

    it("still lets the reader read the steps and the limits", () => {
      templatesQuery.data = {
        templates: [{ ...blocked, caveats: ["It cannot read a GitHub team."] }],
      };
      render(<TemplateGallery />);
      expect(screen.queryByRole("button", { name: "Use template" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "What it does" }));
      const dialog = within(screen.getByRole("dialog"));
      expect(dialog.getByText("Read open pull requests")).toBeTruthy();
      expect(dialog.getByText("It cannot read a GitHub team.")).toBeTruthy();
    });

    it("refuses the install in the dialog, naming who can unblock each service", () => {
      templatesQuery.data = { templates: [blocked] };
      render(<TemplateGallery />);
      fireEvent.click(screen.getByRole("button", { name: "What it does" }));

      const dialog = within(screen.getByRole("dialog"));
      expect((dialog.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(dialog.getByText("You cannot install this yet")).toBeTruthy();
      // The caller's own gap, and the corrective action they can take.
      expect(
        dialog.getByText(
          "GitHub is not connected on your account. Connect it on the Integrations page, then install this template.",
        ),
      ).toBeTruthy();
      // The org's gap, and who can take that one.
      expect(dialog.getByText(/Slack is not configured for this organization/)).toBeTruthy();
    });

    it("offers no second control on a card that can be installed", () => {
      templatesQuery.data = { templates: [batchAction] };
      render(<TemplateGallery />);
      expect(screen.getByRole("button", { name: "Use template" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "What it does" })).toBeNull();
    });
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
