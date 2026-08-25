// @vitest-environment jsdom
/**
 * The import dialog, covering the three outcomes that decide whether an
 * import is safe: a good definition becomes a workflow, a broken one is
 * refused with the messages that name what to fix, and a definition calling
 * a service this deployment does not have is refused by the server with the
 * validator's own wording.
 *
 * `useNavigate` needs router context — mocked the way `template-gallery.
 * test.tsx` does, since these tests care that navigation was requested, not
 * that a router resolved it. `ApiError` stays real: reading its payload is
 * exactly what is under test.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApiError, api } from "~/api/client";

const navigate = vi.fn();
const createMutateAsync = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));

vi.mock("~/api/workflows", () => ({
  useCreateWorkflow: () => ({ mutateAsync: createMutateAsync, isPending: false }),
}));

/**
 * Set by the one case that needs the parser to REJECT rather than answer.
 * `parseWorkflowImport` returns a result for every input it is given today,
 * so nothing else can drive the dialog's catch, and the catch is what keeps
 * the Review button from going dead if that ever changes.
 */
let parseRejection: Error | null = null;

vi.mock("./import-workflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./import-workflow")>();
  return {
    ...actual,
    parseWorkflowImport: async (text: string, fileName?: string) => {
      if (parseRejection !== null) throw parseRejection;
      return actual.parseWorkflowImport(text, fileName);
    },
  };
});

import { ImportWorkflowDialog } from "./import-workflow-dialog";

const VALID = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "notify", type: "tool", service: "slack", action: "send_message", params: {} },
    { id: "stop", type: "stop" },
  ],
  edges: [
    { from: "trigger", to: "notify" },
    { from: "notify", to: "stop" },
  ],
};

function renderDialog() {
  const onOpenChange = vi.fn();
  render(<ImportWorkflowDialog open onOpenChange={onOpenChange} />);
  return onOpenChange;
}

/**
 * Paste `text` and move to the review step.
 *
 * Async because the parser is: a YAML file loads its decoder on demand, so
 * `review` awaits even when `JSON.parse` answered on the first try. The wait
 * ends on whichever the outcome is — the review step's Name field, or the
 * refusal alert.
 */
async function paste(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Workflow YAML or JSON"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Name") ?? screen.queryByRole("alert")).not.toBeNull(),
  );
}

beforeEach(() => {
  navigate.mockReset();
  createMutateAsync.mockReset();
  createMutateAsync.mockResolvedValue({ id: "wf_new" });
  parseRejection = null;
  vi.restoreAllMocks();
});

describe("ImportWorkflowDialog — a pasted file", () => {
  it("previews what the definition contains before anything is created", async () => {
    renderDialog();
    await paste(JSON.stringify(VALID));

    expect(screen.getByText("3")).toBeTruthy(); // node count
    expect(screen.getByText(/pasted file/)).toBeTruthy();
    expect(screen.getByText("tool × 1")).toBeTruthy();
    expect(screen.getByText("Slack")).toBeTruthy();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it("creates the workflow under the active workspace, then opens it", async () => {
    const onOpenChange = renderDialog();
    await paste(JSON.stringify(VALID));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nightly deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMutateAsync).toHaveBeenCalledWith({ name: "Nightly deploy", definition: VALID });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_new" },
      }),
    );
  });

  it("takes the name out of a file that carries one", async () => {
    renderDialog();
    await paste(JSON.stringify({ name: "Nightly deploy", definition: VALID }));

    const field = screen.getByLabelText("Name");
    expect(field instanceof HTMLInputElement && field.value).toBe("Nightly deploy");
  });

  it("refuses a broken definition with the validator's own messages, and creates nothing", async () => {
    renderDialog();
    await paste(
      JSON.stringify({
        version: "dag/v1",
        nodes: [{ id: "trigger", type: "trigger" }],
        edges: [{ from: "trigger", to: "ghost" }],
      }),
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("ghost");
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it("says what the file carries and the import does not create", async () => {
    // The create route writes a name and a definition. A schedule dropped in
    // silence imports as a workflow that never runs.
    renderDialog();
    await paste(
      [
        "valet: workflow/v1",
        "name: Nightly triage",
        "schedule:",
        '  cron: "0 3 * * *"',
        "definition:",
        "  version: dag/v1",
        "  nodes:",
        "    - id: trigger",
        "      type: trigger",
        "  edges: []",
        "",
      ].join("\n"),
    );

    expect(screen.getByText(/The file also carries a schedule/)).toBeTruthy();
    expect(screen.getByText(/Arm a schedule or an event trigger in Triggers/)).toBeTruthy();
  });

  it("shows a message when the parser throws instead of answering", async () => {
    parseRejection = new Error("Converting circular structure to JSON");
    renderDialog();

    await paste(JSON.stringify(VALID));

    expect(screen.getByRole("alert").textContent).toContain(
      "Converting circular structure to JSON",
    );
    // The person is told what to do next, and the Review button still works.
    expect(screen.getByRole("alert").textContent).toContain("try again");
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("refuses text that is not a workflow definition", async () => {
    renderDialog();
    await paste(JSON.stringify({ hello: "world" }));

    expect(screen.getByRole("alert").textContent).toContain("nodes");
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it("shows the server's refusal verbatim when the definition names an unknown service", async () => {
    const unknownService =
      'node "notify": unknown tool.service "slock" — use list_tools to see available services';
    createMutateAsync.mockRejectedValue(
      new ApiError(400, "POST /workflows → 400", {
        error: "invalid workflow definition",
        errors: [unknownService],
      }),
    );

    renderDialog();
    await paste(JSON.stringify(VALID));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(unknownService));
    // The create route validates before it writes, so the refusal left nothing behind.
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("ImportWorkflowDialog — repository", () => {
  it("reads the named file and reviews it", async () => {
    const read = vi.spyOn(api, "getWorkflowImportFile").mockResolvedValue({
      repo: "acme/automations",
      path: "workflows/deploy.json",
      ref: "release",
      content: JSON.stringify(VALID),
    });

    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "Repository" }));
    // `selector` disambiguates the field from the tab panel, which the
    // "Repository" tab labels.
    fireEvent.change(screen.getByLabelText("Repository", { selector: "input" }), {
      target: { value: "acme/automations" },
    });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "workflows/deploy.json" } });
    fireEvent.change(screen.getByLabelText("Branch, tag or commit"), {
      target: { value: "release" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Read file" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toBeTruthy());
    expect(read).toHaveBeenCalledWith({
      repo: "acme/automations",
      path: "workflows/deploy.json",
      ref: "release",
    });
    const field = screen.getByLabelText("Name");
    expect(field instanceof HTMLInputElement && field.value).toBe("deploy");
    expect(screen.getByText(/acme\/automations\/workflows\/deploy.json/)).toBeTruthy();
  });

  it("states the public-repository limit before the user tries a private one", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "Repository" }));
    expect(screen.getByText(/public repositories only/)).toBeTruthy();
  });

  it("shows the server's message when the file cannot be read", async () => {
    const refusal =
      "Valet found no file at deploy.json in acme/private. Valet reads public repositories only, so a private repository, a wrong branch and a misspelled path look the same here.";
    vi.spyOn(api, "getWorkflowImportFile").mockRejectedValue(
      new ApiError(404, "GET /workflows/import/repo-file → 404", { error: refusal }),
    );

    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "Repository" }));
    fireEvent.change(screen.getByLabelText("Repository", { selector: "input" }), {
      target: { value: "acme/private" },
    });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "deploy.json" } });
    fireEvent.click(screen.getByRole("button", { name: "Read file" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(refusal));
    expect(createMutateAsync).not.toHaveBeenCalled();
  });
});
