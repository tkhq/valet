// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import type { ArtifactFormatWire } from "@valet/api/wire";
import type { ComposerContext } from "~/components/session/composer";

function snapshot(version = 3, format: ArtifactFormatWire = "markdown") {
  return {
    artifact: { id: "a1", title: "Project brief", token: "reader-token", url: "https://example.invalid/a/reader-token",
      path: "brief.md", format, icon: "", version: 3, sharedVersion: 2,
      visibility: "org" as const, ownerType: "user", actorUserId: "u1", revoked: false, createdAt: 0, updatedAt: 0 },
    version, content: version === 1 ? "# Old brief\nOld goal" : "# Project brief\nOne goal\nOne goal",
    rendered: version === 1 ? "<h1>Old brief</h1>" : "<h1>Project brief</h1><p>One goal</p>",
    description: "", icon: "", canEdit: true, sourceSessionId: "session-1", sourceThreadId: "thread-1",
  };
}
let latest: ReturnType<typeof snapshot> | undefined;
let historical: ReturnType<typeof snapshot> | undefined;
let pending = false;
let editing = false;
let failed = false;
let historyFailed = false;
const refetch = vi.fn();
const requestEdit = vi.fn();
const restore = vi.fn();
const getEditor = vi.fn();
const normalSend = vi.fn();
vi.mock("~/api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/api/client")>();
  return { ...original, api: { ...original.api, getArtifactEditor: (...args: unknown[]) => getEditor(...args) } };
});
vi.mock("~/api/artifacts", () => ({
  useArtifactEditor: (_id: string, version?: number) => ({ data: version === undefined ? latest : historical, isPending: pending, isError: failed, refetch }),
  useArtifactVersions: () => ({ data: { versions: [
    { version: 3, title: "Project brief", format: "markdown", actorUserId: "u1", createdAt: 3 },
    { version: 1, title: "Old brief", format: "markdown", actorUserId: "u1", createdAt: 1 },
  ] }, isPending: false, isError: historyFailed, refetch }),
  useRequestArtifactEdit: () => ({ mutateAsync: requestEdit, isPending: editing }),
  useRestoreArtifact: () => ({ mutateAsync: restore, isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: { token: string }; children: ReactNode }) =>
    <a href={params ? `/a/${params.token}` : to} {...props}>{children}</a>,
}));
// The real Composer's submission and draft guards have their own regression suite.
vi.mock("~/components/session/assistant-panel", () => ({
  AssistantPanel: ({ context, beforeSend }: { context?: ComposerContext; beforeSend?: (text: string) => Promise<{ text: string; threadId: string }> }) => {
    const [draft, setDraft] = useState("");
    return <div><header>Valet</header><form onSubmit={async event => {
      event.preventDefault();
      if (context) {
        if (!context.disabled && await context.onSubmit(draft)) setDraft("");
      } else {
        const result = beforeSend ? await beforeSend(draft) : { text: draft };
        normalSend(result);
      }
    }}>
      {context?.content}
      <label>Message<textarea value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <button disabled={context?.disabled || !draft.trim()} type="submit">Send</button>
    </form></div>;
  },
}));
vi.mock("~/lib/mermaid", () => ({ renderMermaid: vi.fn() }));
import { ArtifactEditor } from "./artifact-editor";

function selectSource(start = 16, end = 24) {
  const sourceToggle = screen.queryByRole("button", { name: "View source" });
  if (sourceToggle) fireEvent.click(sourceToggle);
  const source = screen.getByRole("textbox", { name: "Artifact source" });
  fireEvent.select(source, { target: { selectionStart: 0, selectionEnd: 0 } });
  fireEvent.select(source, { target: { selectionStart: start, selectionEnd: end } });
}
function attachSelection() { fireEvent.click(screen.getByRole("button", { name: "Edit with Valet" })); }
function describeChange() { fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Make this clearer" } }); }
function sendFrameMessage(data: unknown) {
  const frame = screen.getAllByTitle("Project brief").find(element => element instanceof HTMLIFrameElement);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing preview frame");
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data }));
}
function viewHistory(version: number) {
  fireEvent.click(screen.getByRole("button", { name: "Revision history" }));
  fireEvent.click(screen.getByRole("button", { name: `View version ${version}` }));
}

describe("artifact authoring editor", () => {
  beforeEach(() => {
    cleanup(); vi.clearAllMocks(); latest = snapshot(); historical = snapshot(1);
    pending = false; editing = false; failed = false; historyFailed = false;
    getEditor.mockImplementation(async () => latest);
    requestEdit.mockResolvedValue({ requestId: "request-1", sent: true });
    restore.mockResolvedValue({ ...snapshot(4), artifact: { ...snapshot().artifact, version: 4 } });
  });

  it("starts with one conversation input and an uninterrupted preview", () => {
    render(<ArtifactEditor id="a1" />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: "Edit selection with Valet" })).toBeNull();
    expect(screen.queryByText("Working version 3")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit with Valet" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open shared view" }).getAttribute("href")).toBe("/a/reader-token");
  });

  it("attaches an exact source selection to the existing draft only on explicit request", async () => {
    render(<ArtifactEditor id="a1" />); describeChange(); selectSource(25, 33);
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: "Message" }));
    attachSelection();
    expect(screen.getByRole("textbox", { name: "Artifact source" }).hasAttribute("readonly")).toBe(true);
    expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("Make this clearer");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestEdit).toHaveBeenCalledWith({ baseVersion: 3, instruction: "Make this clearer", selection: { text: "One goal", start: 25, end: 33 } }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe(""));
    expect(normalSend).not.toHaveBeenCalled();
  });

  it.each(["failed", "undelivered"])("retains selection and instruction after %s delivery", async outcome => {
    if (outcome === "failed") requestEdit.mockRejectedValue(new Error("Ambiguous selection"));
    else requestEdit.mockResolvedValue({ requestId: "request-1", sent: false });
    render(<ArtifactEditor id="a1" />); selectSource(); attachSelection(); describeChange();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Try again"));
    expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("Make this clearer");
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeTruthy();
  });

  it("keeps the captured version and draft when a newer version arrives", () => {
    const editor = render(<ArtifactEditor id="a1" />); selectSource(); attachSelection(); describeChange();
    latest = { ...snapshot(4), artifact: { ...snapshot().artifact, version: 4 } };
    editor.rerender(<ArtifactEditor id="a1" />);
    expect(screen.getByRole("alert").textContent).toContain("Select it again");
    expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("Make this clearer");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    selectSource(); attachSelection();
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps selection targeting disabled while reviewing history", () => {
    render(<ArtifactEditor id="a1" />); selectSource(); attachSelection(); describeChange(); viewHistory(1);
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("Make this clearer");
    fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });

  it("does not replace the attached target while an edit is being sent", () => {
    const editor = render(<ArtifactEditor id="a1" />); selectSource(); attachSelection(); describeChange();
    selectSource(25, 33);
    editing = true; editor.rerender(<ArtifactEditor id="a1" />);
    expect(screen.getByRole("button", { name: "Edit with Valet" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit with Valet" }));
    expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("Make this clearer");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("ignores messages from a previous preview revision", () => {
    const editor = render(<ArtifactEditor id="a1" />);
    const oldFrame = screen.getAllByTitle("Project brief").find(element => element instanceof HTMLIFrameElement);
    if (!(oldFrame instanceof HTMLIFrameElement)) throw new Error("Missing preview frame");
    const previousWindow = oldFrame.contentWindow;
    latest = { ...snapshot(4), artifact: { ...snapshot().artifact, version: 4 }, rendered: "<h1>A new brief</h1>" };
    editor.rerender(<ArtifactEditor id="a1" />);
    fireEvent(window, new MessageEvent("message", { source: previousWindow, data: { type: "valet-artifact:selection", text: "One goal", vdid: "paragraph-1" } }));
    expect(screen.queryByRole("button", { name: "Edit with Valet" })).toBeNull();
  });

  it.each(["A full element text", ""])("targets the full HTML element with text %j", async text => {
    latest = snapshot(3, "html");
    render(<ArtifactEditor id="a1" />);
    fireEvent.click(screen.getByRole("button", { name: "Select element" }));
    sendFrameMessage({ type: "valet-artifact:pick", vdid: "element-1", text, label: "Short", rect: { top: 10, left: 20, width: 100, height: 20 } });
    attachSelection(); describeChange(); fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestEdit).toHaveBeenCalledWith({ baseVersion: 3, instruction: "Make this clearer", selection: { text, vdid: "element-1", kind: "element" } }));
  });

  it("sends preview text separately from an element pick", async () => {
    render(<ArtifactEditor id="a1" />);
    sendFrameMessage({ type: "valet-artifact:selection", text: "One goal", vdid: "paragraph-1" });
    attachSelection(); describeChange(); fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestEdit).toHaveBeenCalledWith({ baseVersion: 3, instruction: "Make this clearer", selection: { text: "One goal", vdid: "paragraph-1", kind: "text" } }));
  });

  it("rejects oversized selections before attaching them", () => {
    latest = { ...snapshot(), content: "x".repeat(9000) };
    render(<ArtifactEditor id="a1" />); selectSource(0, 9000);
    expect(screen.getByRole("alert").textContent).toContain("8,192");
    expect(screen.queryByRole("button", { name: "Edit with Valet" })).toBeNull();
  });

  it("previews history and restores only the explicitly confirmed version", async () => {
    render(<ArtifactEditor id="a1" />); viewHistory(1);
    expect(screen.getAllByTitle("Old brief").find(element => element instanceof HTMLIFrameElement)?.getAttribute("srcdoc")).toContain("Old brief");
    fireEvent.click(screen.getByRole("button", { name: "Restore version 1" }));
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore version 1" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith({ version: 1, baseVersion: 3 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to latest" })).toBeNull());
  });

  it("keeps a restore confirmation tied to the version that opened it", () => {
    const editor = render(<ArtifactEditor id="a1" />); viewHistory(1);
    fireEvent.click(screen.getByRole("button", { name: "Restore version 1" }));
    latest = { ...snapshot(4), artifact: { ...snapshot().artifact, version: 4 } };
    editor.rerender(<ArtifactEditor id="a1" />);
    expect(screen.getByRole("button", { name: "Confirm restore version 1" }).hasAttribute("disabled")).toBe(true);
  });

  it("blocks targeted sending if the working version cannot refresh", () => {
    const editor = render(<ArtifactEditor id="a1" />); selectSource(); attachSelection(); describeChange();
    failed = true; editor.rerender(<ArtifactEditor id="a1" />);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeTruthy();
  });

  it("grounds broad requests in the latest artifact without changing the existing thread", async () => {
    render(<ArtifactEditor id="a1" />); describeChange();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(normalSend).toHaveBeenCalled());
    expect(getEditor).toHaveBeenCalledWith("a1");
    expect(normalSend.mock.calls[0]?.[0]).toMatchObject({ threadId: "thread-1", text: expect.stringContaining("brief.md") });
    expect(requestEdit).not.toHaveBeenCalled();
  });

  it("keeps read-only artifacts usable without an editing composer", () => {
    latest = { ...snapshot(), canEdit: false, sourceSessionId: "", sourceThreadId: "" };
    render(<ArtifactEditor id="a1" />);
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open shared view" })).toBeTruthy();
    viewHistory(1);
    fireEvent.click(screen.getByRole("button", { name: "Restore version 1" }));
    expect(screen.getByRole("button", { name: "Confirm restore version 1" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows actionable loading and error states", () => {
    latest = undefined; pending = true;
    const editor = render(<ArtifactEditor id="a1" />);
    expect(screen.getByText("Loading artifact…")).toBeTruthy();
    pending = false; failed = true; editor.rerender(<ArtifactEditor id="a1" />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });
});
