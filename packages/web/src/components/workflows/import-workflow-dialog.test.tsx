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

/** Paste `json` and move to the review step. */
function paste(json: string): void {
  fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: json } });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
}

beforeEach(() => {
  navigate.mockReset();
  createMutateAsync.mockReset();
  createMutateAsync.mockResolvedValue({ id: "wf_new" });
  vi.restoreAllMocks();
});

describe("ImportWorkflowDialog — pasted JSON", () => {
  it("previews what the definition contains before anything is created", () => {
    renderDialog();
    paste(JSON.stringify(VALID));

    expect(screen.getByText("3")).toBeTruthy(); // node count
    expect(screen.getByText(/pasted JSON/)).toBeTruthy();
    expect(screen.getByText("tool × 1")).toBeTruthy();
    expect(screen.getByText("Slack")).toBeTruthy();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it("creates the workflow under the active workspace, then opens it", async () => {
    const onOpenChange = renderDialog();
    paste(JSON.stringify(VALID));

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

  it("takes the name out of a file that carries one", () => {
    renderDialog();
    paste(JSON.stringify({ name: "Nightly deploy", definition: VALID }));

    const field = screen.getByLabelText("Name");
    expect(field instanceof HTMLInputElement && field.value).toBe("Nightly deploy");
  });

  it("refuses a broken definition with the validator's own messages, and creates nothing", () => {
    renderDialog();
    paste(
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

  it("refuses text that is not a workflow definition", () => {
    renderDialog();
    paste(JSON.stringify({ hello: "world" }));

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
    paste(JSON.stringify(VALID));
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

  it("states whose GitHub connection the read uses, before the user tries a private repository", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "Repository" }));
    expect(screen.getByText(/with your own GitHub connection/)).toBeTruthy();
    expect(screen.getByText(/Without a connection Valet reads public repositories only/)).toBeTruthy();
  });

  it("shows the server's message when the file cannot be read", async () => {
    // The server's own wording for a caller who read with no credential.
    const refusal =
      "Valet found no file at deploy.json in acme/private. Valet read the repository with no GitHub credential, so it reads public repositories only. To import from a private repository, connect GitHub in Settings → Connected accounts.";
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
