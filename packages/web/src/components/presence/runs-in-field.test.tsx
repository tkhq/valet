// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { AssistantThreadPolicy } from "@valet/shared";
import { describe, expect, it, vi } from "vitest";

// The picker reads the network; this suite covers the field around it.
vi.mock("./thread-picker", () => ({
  ThreadPicker: ({ onPick }: { onPick: (p: AssistantThreadPolicy, title: string) => void }) => (
    <button type="button" onClick={() => onPick({ mode: "existing", sessionId: "s1", threadId: "t1" }, "Deploys")}>
      Pick Deploys
    </button>
  ),
}));

import { RunsInField } from "./runs-in-field";

function radio(name: RegExp): HTMLInputElement {
  const el = screen.getByRole("radio", { name });
  if (!(el instanceof HTMLInputElement)) throw new Error("expected an input");
  return el;
}

describe("RunsInField", () => {
  it("renders the four options for a listener with a subject", () => {
    render(<RunsInField idPrefix="t" value={{ mode: "new" }} onChange={() => {}} subjectKind="pull request" ruleKind="listener" workspace="user" />);
    expect(radio(/A new thread each time/).checked).toBe(true);
    expect(radio(/One thread per pull request/)).toBeTruthy();
    expect(radio(/This listener's thread/)).toBeTruthy();
    expect(radio(/An existing thread/)).toBeTruthy();
  });

  it("hides the subject option when the keys name no subject", () => {
    render(<RunsInField idPrefix="t" value={{ mode: "own" }} onChange={() => {}} subjectKind={null} ruleKind="routine" workspace="user" />);
    expect(screen.queryByRole("radio", { name: /One thread per/ })).toBeNull();
    expect(radio(/This routine's thread/).checked).toBe(true);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("hides the existing option without a workspace to pick from", () => {
    render(<RunsInField idPrefix="t" value={{ mode: "own" }} onChange={() => {}} subjectKind="channel" ruleKind="listener" />);
    expect(screen.queryByRole("radio", { name: /An existing thread/ })).toBeNull();
  });

  it("emits each mode, and null until a thread is picked", () => {
    const onChange = vi.fn();
    const { rerender } = render(<RunsInField idPrefix="t" value={{ mode: "new" }} onChange={onChange} subjectKind="channel" ruleKind="listener" workspace="user" />);
    fireEvent.click(radio(/One thread per channel/));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "subject" });
    fireEvent.click(radio(/This listener's thread/));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "own" });
    fireEvent.click(radio(/An existing thread/));
    expect(onChange).toHaveBeenLastCalledWith(null);
    rerender(<RunsInField idPrefix="t" value={null} onChange={onChange} subjectKind="channel" ruleKind="listener" workspace="user" />);
    expect(radio(/An existing thread/).checked).toBe(true);
    expect(screen.getByText("Pick a thread.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick Deploys" }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "existing", sessionId: "s1", threadId: "t1" });
    rerender(<RunsInField idPrefix="t" value={{ mode: "existing", sessionId: "s1", threadId: "t1" }} onChange={onChange} subjectKind="channel" ruleKind="listener" workspace="user" />);
    expect(screen.getByText("The thread Deploys")).toBeTruthy();
  });

  it("notes a shared thread for Slack conversations in the own and existing modes only", () => {
    const note = "Messages from several Slack conversations will share this thread.";
    const { rerender } = render(<RunsInField idPrefix="t" value={{ mode: "own" }} onChange={() => {}} subjectKind="channel" ruleKind="listener" workspace="user" eventKeys={["slack.message"]} />);
    expect(screen.getByText(note)).toBeTruthy();
    rerender(<RunsInField idPrefix="t" value={{ mode: "existing", sessionId: "s", threadId: "t" }} onChange={() => {}} subjectKind="channel" ruleKind="listener" workspace="user" eventKeys={["slack.app_mention"]} />);
    expect(screen.getByText(note)).toBeTruthy();
    rerender(<RunsInField idPrefix="t" value={{ mode: "new" }} onChange={() => {}} subjectKind="channel" ruleKind="listener" workspace="user" eventKeys={["slack.message"]} />);
    expect(screen.queryByText(note)).toBeNull();
    rerender(<RunsInField idPrefix="t" value={{ mode: "own" }} onChange={() => {}} subjectKind="pull request" ruleKind="listener" workspace="user" eventKeys={["github.pr.opened"]} />);
    expect(screen.queryByText(note)).toBeNull();
  });
});
