// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

function snapshot(version = 3) {
  return {
    artifact: { id: "a1", title: "Project brief", token: "reader-token", url: "https://example.invalid/a/reader-token",
      path: "brief.md", format: "markdown" as const, icon: "", version: 3, sharedVersion: 2,
      visibility: "org" as const, ownerType: "user", actorUserId: "u1", revoked: false, createdAt: 0, updatedAt: 0 },
    version, content: version === 1 ? "# Old brief\nOld goal" : "# Project brief\nOne goal\nOne goal",
    rendered: version === 1 ? "<h1>Old brief</h1>" : "<h1>Project brief</h1><p>One goal</p>",
    description: "", icon: "", canEdit: true, sourceSessionId: "session-1", sourceThreadId: "thread-1",
  };
}
let latest: ReturnType<typeof snapshot> | undefined;
let historical: ReturnType<typeof snapshot> | undefined;
let pending = false;
let failed = false;
let historyFailed = false;
const refetch = vi.fn();
const requestEdit = vi.fn();
const restore = vi.fn();
vi.mock("~/api/artifacts", () => ({
  useArtifactEditor: (_id: string, version?: number) => ({ data: version === undefined ? latest : historical, isPending: pending, isError: failed, refetch }),
  useArtifactVersions: () => ({ data: { versions: [
    { version: 3, title: "Project brief", format: "markdown", actorUserId: "u1", createdAt: 3 },
    { version: 1, title: "Old brief", format: "markdown", actorUserId: "u1", createdAt: 1 },
  ] }, isPending: false, isError: historyFailed, refetch }),
  useRequestArtifactEdit: () => ({ mutateAsync: requestEdit, isPending: false }),
  useRestoreArtifact: () => ({ mutateAsync: restore, isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children }: { to: string; params?: { token: string }; children: ReactNode }) =>
    <a href={params ? `/a/${params.token}` : to}>{children}</a>,
}));
// Conversation transport and sandbox lifetimes are covered by SessionView tests.
vi.mock("~/components/session/assistant-panel", () => ({
  AssistantPanel: () => <label>Conversation draft<textarea aria-label="Conversation draft" defaultValue="" /></label>,
}));
vi.mock("~/lib/mermaid", () => ({ renderMermaid: vi.fn() }));
import { ArtifactEditor } from "./artifact-editor";

function selectSource(start = 16, end = 24) {
  fireEvent.click(screen.getByRole("tab", { name: "Source" }));
  const source = screen.getByRole("textbox", { name: "Artifact source" });
  fireEvent.select(source, { target: { selectionStart: 0, selectionEnd: 0 } });
  fireEvent.select(source, { target: { selectionStart: start, selectionEnd: end } });
}
function describeChange() {
  fireEvent.change(screen.getByRole("textbox", { name: "Edit selection with Valet" }), { target: { value: "Make this clearer" } });
}
function sendFrameMessage(data: unknown) {
  const frame = screen.getAllByTitle("Project brief").find((element) => element instanceof HTMLIFrameElement);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing preview frame");
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data }));
}

describe("artifact authoring editor", () => {
  beforeEach(() => {
    cleanup(); vi.clearAllMocks(); latest = snapshot(); historical = snapshot(1);
    pending = false; failed = false; historyFailed = false;
    requestEdit.mockResolvedValue({ requestId: "request-1", sent: true });
    restore.mockResolvedValue({ ...snapshot(4), artifact: { ...snapshot().artifact, version: 4 } });
  });

  it("submits the exact source occurrence and clears a delivered request", async () => {
    render(<ArtifactEditor id="a1" />); selectSource(25, 33); describeChange();
    expect(screen.getByRole("textbox", { name: "Artifact source" }).hasAttribute("readonly")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send edit" }));
    await waitFor(() => expect(requestEdit).toHaveBeenCalledWith({ baseVersion: 3, instruction: "Make this clearer", selection: { text: "One goal", start: 25, end: 33 } }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("sent to Valet"));
    const instruction = screen.getByRole("textbox", { name: "Edit selection with Valet" });
    if (!(instruction instanceof HTMLTextAreaElement)) throw new Error("Missing instruction field");
    expect(instruction.value).toBe("");
    expect(screen.getByRole("button", { name: "Send edit" }).hasAttribute("disabled")).toBe(true);
  });

  it("retains the selected fragment and instruction when delivery fails", async () => {
    requestEdit.mockRejectedValue(new Error("The selection is ambiguous."));
    render(<ArtifactEditor id="a1" />); selectSource(); describeChange();
    fireEvent.click(screen.getByRole("button", { name: "Send edit" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Try again"));
    expect(screen.getByRole("textbox", { name: "Edit selection with Valet" }).textContent).toBe("Make this clearer");
    expect(screen.getByRole("button", { name: "Send edit" }).hasAttribute("disabled")).toBe(false);
  });

  it("retains a saved request for retry when Valet has not received it", async () => {
    requestEdit.mockResolvedValue({ requestId: "request-1", sent: false });
    render(<ArtifactEditor id="a1" />); selectSource(); describeChange();
    fireEvent.click(screen.getByRole("button", { name: "Send edit" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("not delivered"));
    expect(screen.getByRole("textbox", { name: "Edit selection with Valet" }).textContent).toBe("Make this clearer");
    expect(screen.getByRole("button", { name: "Send edit" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("status").textContent).not.toContain("sent to Valet");
  });

  it("keeps captured revision context when polling changes the working version", () => {
    const view = render(<ArtifactEditor id="a1" />); selectSource(); describeChange();
    latest = { ...snapshot(4), artifact: { ...snapshot().artifact, version: 4 } };
    view.rerender(<ArtifactEditor id="a1" />);
    expect(screen.getByRole("alert").textContent).toContain("Select it again");
    expect(screen.getByRole("textbox", { name: "Edit selection with Valet" }).textContent).toBe("Make this clearer");
    expect(screen.getByRole("button", { name: "Send edit" }).hasAttribute("disabled")).toBe(true);
    expect(requestEdit).not.toHaveBeenCalled();
    selectSource();
    expect(screen.getByRole("button", { name: "Send edit" }).hasAttribute("disabled")).toBe(false);
  });

  it("ignores selection messages from a previous preview revision", () => {
    const editor = render(<ArtifactEditor id="a1" />);
    const frame = screen.getAllByTitle("Project brief").find((element) => element instanceof HTMLIFrameElement);
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing preview frame");
    const previousWindow = frame.contentWindow;
    latest = { ...snapshot(4), artifact: { ...snapshot().artifact, version: 4 }, rendered: "<h1>A new brief</h1>" };
    editor.rerender(<ArtifactEditor id="a1" />);
    fireEvent(window, new MessageEvent("message", { source: previousWindow, data: { type: "valet-artifact:selection", text: "One goal", vdid: "paragraph-1" } }));
    describeChange();
    expect(screen.getByRole("button", { name: "Send edit" }).hasAttribute("disabled")).toBe(true);
  });

  it("uses untruncated element text and element context when picking", async () => {
    render(<ArtifactEditor id="a1" />);
    fireEvent.click(screen.getByRole("button", { name: "Pick element" }));
    sendFrameMessage({ type: "valet-artifact:pick", vdid: "paragraph-1", text: "A full element text", label: "A full", rect: { top: 0, left: 0, width: 10, height: 10 } });
    describeChange(); fireEvent.click(screen.getByRole("button", { name: "Send edit" }));
    await waitFor(() => expect(requestEdit).toHaveBeenCalledWith({ baseVersion: 3, instruction: "Make this clearer", selection: { text: "A full element text", vdid: "paragraph-1", kind: "element" } }));
  });

  it("can select an HTML element without text", async () => {
    render(<ArtifactEditor id="a1" />);
    fireEvent.click(screen.getByRole("button", { name: "Pick element" }));
    sendFrameMessage({ type: "valet-artifact:pick", vdid: "image-1", text: "", label: "", rect: { top: 0, left: 0, width: 10, height: 10 } });
    describeChange(); fireEvent.click(screen.getByRole("button", { name: "Send edit" }));
    await waitFor(() => expect(requestEdit).toHaveBeenCalledWith({ baseVersion: 3, instruction: "Make this clearer", selection: { text: "", vdid: "image-1", kind: "element" } }));
  });

  it("rejects oversized source fragments with instructions to select less text", () => {
    latest = { ...snapshot(), content: "x".repeat(9000) };
    render(<ArtifactEditor id="a1" />); selectSource(0, 9000); describeChange();
    expect(screen.getByRole("alert").textContent).toContain("8,192");
    expect(screen.getByRole("button", { name: "Send edit" }).hasAttribute("disabled")).toBe(true);
  });

  it("sends preview text selection separately from element picks", async () => {
    render(<ArtifactEditor id="a1" />);
    sendFrameMessage({ type: "valet-artifact:selection", text: "One goal", vdid: "paragraph-1" });
    describeChange(); fireEvent.click(screen.getByRole("button", { name: "Send edit" }));
    await waitFor(() => expect(requestEdit).toHaveBeenCalledWith({ baseVersion: 3, instruction: "Make this clearer", selection: { text: "One goal", vdid: "paragraph-1", kind: "text" } }));
  });

  it("previews immutable history and restores the explicitly confirmed revision", async () => {
    render(<ArtifactEditor id="a1" />);
    expect(screen.getByText("Working version 3")).toBeTruthy();
    expect(screen.getByText("Shared pin: version 2")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open reader" }).getAttribute("href")).toBe("/a/reader-token");
    fireEvent.change(screen.getByRole("combobox", { name: "Revision history" }), { target: { value: "1" } });
    expect(screen.getByTitle("Old brief").getAttribute("srcdoc")).toContain("Old brief");
    expect(screen.queryByRole("textbox", { name: "Edit selection with Valet" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore version 1" }));
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore version 1" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith({ version: 1, baseVersion: 3 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to latest" })).toBeNull());
    expect(screen.getByText("Shared pin: version 2")).toBeTruthy();
  });

  it("prevents a restore confirmation from silently using a newer base version", () => {
    const view = render(<ArtifactEditor id="a1" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Revision history" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore version 1" }));
    latest = { ...snapshot(4), artifact: { ...snapshot().artifact, version: 4 } };
    view.rerender(<ArtifactEditor id="a1" />);
    expect(screen.getByRole("button", { name: "Confirm restore version 1" }).hasAttribute("disabled")).toBe(true);
    expect(restore).not.toHaveBeenCalled();
  });

  it("keeps the conversation mounted while changing the mobile pane", () => {
    render(<ArtifactEditor id="a1" />);
    const draft = screen.getByRole("textbox", { name: "Conversation draft" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    fireEvent.click(screen.getByRole("tab", { name: "Artifact" }));
    expect(screen.getByLabelText("Conversation draft")).toBe(draft);
    if (!(draft instanceof HTMLTextAreaElement)) throw new Error("Missing conversation field");
    expect(draft.value).toBe("Keep this draft");
  });

  it("blocks form submission while the working version cannot refresh", () => {
    const editor = render(<ArtifactEditor id="a1" />); selectSource(); describeChange();
    failed = true; editor.rerender(<ArtifactEditor id="a1" />);
    const form = screen.getByRole("button", { name: "Send edit" }).closest("form");
    if (!form) throw new Error("Missing edit form");
    fireEvent.submit(form);
    expect(requestEdit).not.toHaveBeenCalled();
  });

  it("allows manager restore when an artifact has no editable source conversation", async () => {
    latest = { ...snapshot(), canEdit: false, sourceSessionId: "", sourceThreadId: "" };
    render(<ArtifactEditor id="a1" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Revision history" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore version 1" }));
    expect(screen.getByRole("button", { name: "Confirm restore version 1" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore version 1" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith({ version: 1, baseVersion: 3 }));
  });

  it("hides editing when source access is unavailable", () => {
    latest = { ...snapshot(), canEdit: false, sourceSessionId: "", sourceThreadId: "" };
    render(<ArtifactEditor id="a1" />);
    expect(screen.queryByRole("textbox", { name: "Edit selection with Valet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pick element" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open reader" })).toBeTruthy();
  });

  it("shows actionable loading and error states", () => {
    latest = undefined; pending = true;
    const view = render(<ArtifactEditor id="a1" />);
    expect(screen.getByText("Loading artifact…")).toBeTruthy();
    pending = false; failed = true; view.rerender(<ArtifactEditor id="a1" />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });
});
