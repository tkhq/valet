// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { MessagePart } from "@valet/api/wire";
import { describe, expect, it, vi } from "vitest";

vi.mock("./tool-call-block", () => ({ ToolCallBlock: ({ part }: { part: { callId: string } }) => <div data-testid={`card-${part.callId}`} /> }));

import {
  actionVerb, CallSteps, ChildTitlesContext, groupCalls, isQuietCall, leadingWorkCount, ReasoningLine, segmentParts, stepView, withExtraWork, WorkGroup, workSummary, type WorkPart,
} from "./work-group";
import type { ToolCallPart } from "./tool-call-block";

function call(toolName: string, args: Record<string, unknown> = {}, extra: Partial<ToolCallPart> = {}): ToolCallPart {
  return { kind: "tool_call", callId: `c-${toolName}-${JSON.stringify(args).length}-${Math.random()}`, toolName, args, status: "completed", ...extra };
}
const text = (t: string): MessagePart => ({ kind: "text", text: t });
const thinking = (t: string): MessagePart => ({ kind: "thinking", text: t });

describe("segmentParts", () => {
  it("folds quiet calls and reasoning together and keeps text and cards that must stay in view apart", () => {
    const parts = [thinking("plan"), call("bash", { command: "ls" }), call("read", { path: "a.ts" }), text("Done."), call("show_brief", { headline: "Morning" })];
    const segments = segmentParts(parts);
    expect(segments.map(segment => segment.kind === "work" ? `work:${segment.parts.length}` : segment.part.kind)).toEqual(["work:3", "text", "tool_call"]);
    expect(leadingWorkCount(parts)).toBe(3);
    expect(leadingWorkCount([text("hi"), call("bash")])).toBe(0);
  });

  it("folds a workflow read into the work line and keeps a started run in view", () => {
    expect(isQuietCall(call("call_tool", { tool_id: "workflows.list_runs", params: {} }))).toBe(true);
    expect(isQuietCall(call("call_tool", { tool_id: "workflows.start_run", params: {} }))).toBe(false);
    expect(isQuietCall(call("show_widget", { spec: {} }))).toBe(false);
  });

  it("adds the next messages' calls to the last work line, or starts one after the text", () => {
    const extra = [call("bash")] as WorkPart[];
    expect(withExtraWork(segmentParts([call("read")]), extra).map(s => s.kind === "work" ? s.parts.length : 0)).toEqual([2]);
    expect(withExtraWork(segmentParts([text("hi")]), extra).map(s => s.kind)).toEqual(["part", "work"]);
  });
});

describe("work line text", () => {
  it("says what a turn did, counting alike steps together", () => {
    const parts = [call("read", { path: "a" }), call("read", { path: "b" }), call("read", { path: "c" }), call("bash"), call("bash"),
      call("call_tool", { tool_id: "notion.notion-search" }), thinking("hmm")] as WorkPart[];
    expect(workSummary(parts)).toBe("Read 3 files, ran 2 commands, and searched Notion");
    expect(workSummary([thinking("only")] as WorkPart[])).toBe("Thought it through");
    const services = [call("call_tool", { tool_id: "github.read_repo_file" }), call("call_tool", { tool_id: "notion.notion-fetch" }), call("call_tool", { tool_id: "github.get_repository" })] as WorkPart[];
    expect(workSummary(services)).toBe("Read GitHub and Notion");
  });

  it("names a running plugin call by the agent's purpose, else by its action and inputs", () => {
    const withPurpose = stepView(call("call_tool", { tool_id: "memory.search", summary: "Find nonprofit work we can cite", params: {} }, { status: "running" }), new Map());
    expect(withPurpose).toMatchObject({ title: "Find nonprofit work we can cite", status: "running", detail: "Memory" });
    const bare = stepView(call("call_tool", { tool_id: "slack.read_history" }, { status: "running" }), new Map());
    expect(bare).toMatchObject({ title: "Reading Slack history", status: "running" });
  });

  it("names a finished plugin call with no label of its own from its action and inputs", () => {
    const search = stepView(call("call_tool", { tool_id: "memory.search", summary: "Find nonprofit work we can cite", params: { query: "nonprofit" } }), new Map());
    expect(search).toMatchObject({ title: "Searched Memory for “nonprofit”", status: "done" });
    expect(stepView(call("call_tool", { tool_id: "linear.get_issue", params: { id: "ENG-123" } }), new Map()).title).toBe("Read Linear issue ENG-123");
    expect(stepView(call("call_tool", { tool_id: "sentry.whoami" }), new Map()).title).toBe("Ran Sentry whoami");
    expect(stepView(call("call_tool", { tool_id: "notion.notion-fetch" }), new Map()).title).toBe("Read Notion");
  });

  it("keeps a failed plugin call out of the past tense and shows the error", () => {
    const failed = call("call_tool", { tool_id: "linear.get_issue", params: { id: "ENG-123" } }, { status: "error", error: "Not found" });
    expect(stepView(failed, new Map())).toMatchObject({ title: "Reading Linear issue ENG-123", status: "error", detail: expect.stringContaining("Not found") });
  });

  it("names the files a memory delete or move touches", () => {
    expect(stepView(call("mem_rm", { path: "notes/old.md" }), new Map()).title).toBe("Removed memory notes/old.md");
    expect(stepView(call("mem_move", { from: "a.md", to: "b/a.md" }), new Map()).title).toBe("Moved memory a.md → b/a.md");
  });

  it("names a finished plugin call by the line its action wrote, with the inputs", () => {
    const labeled = call("call_tool", { tool_id: "slack_user.search_messages", summary: "Find the deploy thread" }, { result: { content: [], details: { ok: true, label: "Searched Slack for “deploy”" } } });
    expect(stepView(labeled, new Map())).toMatchObject({ title: "Searched Slack for “deploy”", detail: "Slack user" });
    // The label describes a finished call; a running one keeps the agent's purpose.
    expect(stepView({ ...labeled, status: "running" }, new Map()).title).toBe("Find the deploy thread");
  });

  it("counts memory reads and searches apart", () => {
    const reads = [call("mem_read", { path: "a" }), call("mem_read", { path: "b" }), call("mem_read", { path: "c" }), call("mem_read", { path: "d" })] as WorkPart[];
    expect(workSummary(reads)).toBe("Read 4 memory files");
    expect(workSummary([call("mem_search", { query: "x" }), call("mem_read", { path: "a" })] as WorkPart[])).toBe("Searched memory and read a memory file");
  });

  it("says when a call ran because its thread runs without asking", () => {
    const automatic = call("call_tool", { tool_id: "slack.send_message", summary: "Post the summary" }, { result: { content: [], details: { ok: true, approval: "automatic" } } });
    expect(stepView(automatic, new Map()).detail).toBe("Slack · Approved automatically");
    const asked = call("call_tool", { tool_id: "slack.send_message", summary: "Post the summary" }, { result: { content: [], details: { ok: true } } });
    expect(stepView(asked, new Map()).detail).toBe("Slack");
  });

  it("names the agents a call talks to, never their ids", () => {
    const titles = new Map([["child_1", "Review retry coverage"]]);
    expect(stepView(call("child_send", { child_session_id: "child_1", message: "go" }), titles).title).toBe("Messaged Review retry coverage");
    expect(stepView(call("child_send", { child_session_id: "child_unknown" }), titles).title).toBe("Messaged an agent");
    expect(stepView(call("task", { title: "Backfill leads" }), titles).title).toBe("Started Backfill leads");
  });

  it("shows a failed call's first error line", () => {
    const view = stepView(call("bash", { command: "git push" }, { status: "error", error: "403 forbidden\nmore" }), new Map());
    expect(view).toMatchObject({ status: "error", detail: "403 forbidden" });
  });

  it.each([["notion-search", "searched"], ["read_history", "read"], ["get_channel_info", "read"], ["dm_user", "changed"], ["save_issue", "changed"], ["fireflies_get_summary", "read"], ["describe", "read"]])(
    "reads %s as %s", (action, verb) => expect(actionVerb(action)).toBe(verb));
});

describe("WorkGroup", () => {
  it("shows a run as one line that opens into steps, and a step into its card", () => {
    const a = call("bash", { command: "pnpm test" });
    const b = call("read", { path: "src/a.ts" });
    render(<WorkGroup parts={[a, b]} live={false} />);
    const line = screen.getByRole("button", { name: /Ran a command and read a file/ });
    expect(screen.queryByText(/pnpm test/)).toBeNull();
    fireEvent.click(line);
    fireEvent.click(screen.getByRole("button", { name: /pnpm test/ }));
    expect(screen.getByTestId(`card-${a.callId}`)).toBeTruthy();
    expect(screen.queryByTestId(`card-${b.callId}`)).toBeNull();
  });

  it("says what is running now while the run is live, and counts failures", () => {
    const { rerender } = render(<WorkGroup parts={[call("read", { path: "a" }), call("bash", { command: "pnpm build" }, { status: "running" })]} live />);
    expect(screen.getByRole("button", { name: /Running pnpm build…/ })).toBeTruthy();
    rerender(<WorkGroup parts={[call("bash", { command: "a" }, { status: "error", error: "x" }), call("bash", { command: "b" })]} live={false} />);
    expect(screen.getByText("1 failed")).toBeTruthy();
  });

  it("shows one call as its own step, named with the child's title", () => {
    render(<ChildTitlesContext.Provider value={new Map([["child_9", "Draft subject lines"]])}>
      <WorkGroup parts={[call("child_send", { child_session_id: "child_9" })]} live={false} />
    </ChildTitlesContext.Provider>);
    expect(screen.getByRole("button", { name: /Messaged Draft subject lines/ })).toBeTruthy();
    expect(screen.queryByText(/child_9/)).toBeNull();
  });
});

describe("ReasoningLine", () => {
  it("combines adjacent reasoning blocks into one measured line", () => {
    render(<WorkGroup parts={[
      { kind: "thinking", text: "", durationMs: 2400 },
      { kind: "thinking", text: "", durationMs: 5100 },
    ]} live={false} />);
    expect(screen.getByText("Thought for 8s")).toBeTruthy();
    expect(screen.queryByText("Thought for 2s")).toBeNull();
    expect(screen.queryByText("Thought for 5s")).toBeNull();
  });

  it("opens a measured thought to its reasoning summary", () => {
    render(<WorkGroup parts={[{ kind: "thinking", text: "", summary: "Check the failing test first.", durationMs: 2400 }]} live={false} />);
    expect(screen.queryByText("Check the failing test first.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the thought process" }));
    expect(screen.getByText("Check the failing test first.")).toBeTruthy();
  });

  it("opens a thought inside a work group to its summary, next to a failed call", () => {
    render(<WorkGroup parts={[
      { kind: "thinking", text: "", summary: "The command failed; read the log.", durationMs: 6000 },
      call("bash", { command: "pnpm test" }, { status: "error" }),
      call("read_file", { path: "a.ts" }),
    ]} live={false} />);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Show the thought process" }));
    expect(screen.getByText("The command failed; read the log.")).toBeTruthy();
  });

  it("keeps adjacent blocks thinking until all measured intervals finish", () => {
    render(<WorkGroup parts={[
      { kind: "thinking", text: "", durationMs: 2400 },
      { kind: "thinking", text: "", startedAt: 9000 },
    ]} live />);
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.queryByText(/Thought for/)).toBeNull();
  });

  it("keeps each measured interval inside an expanded work group", () => {
    render(<WorkGroup parts={[
      { kind: "thinking", text: "", durationMs: 2400 },
      call("read_file", { path: "a.ts" }),
      { kind: "thinking", text: "", durationMs: 5100 },
    ]} live={false} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Thought for 2s")).toBeTruthy();
    expect(screen.getByText("Thought for 5s")).toBeTruthy();
  });

  it("shows the measured block duration even while the turn is live", () => {
    render(<ReasoningLine part={{ kind: "thinking", text: "reason", startedAt: 1000, durationMs: 2400 }} live />);
    expect(screen.getByText("Thought for 2s")).toBeTruthy();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("shows measured reasoning even when its text is hidden by the provider", () => {
    render(<ReasoningLine part={{ kind: "thinking", text: "", durationMs: 0 }} live={false} />);
    expect(screen.getByText("Thought for 0s")).toBeTruthy();
  });

  it("uses an untimed fallback for old history", () => {
    render(<ReasoningLine part={{ kind: "thinking", text: "old reasoning" }} live={false} />);
    expect(screen.getByText("Thought process")).toBeTruthy();
  });

  it("renders nothing for empty finished reasoning", () => {
    const { container } = render(<ReasoningLine part={{ kind: "thinking", text: "" }} live={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("starts closed and opens to the text", () => {
    render(<ReasoningLine part={{ kind: "thinking", text: "considering the options" }} live={false} />);
    expect(screen.queryByText("considering the options")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the thought process" }));
    expect(screen.getByText("considering the options")).toBeTruthy();
  });

  it("says Thinking while the model streams it", () => {
    render(<ReasoningLine part={{ kind: "thinking", text: "" }} live />);
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });
});

describe("CallSteps", () => {
  it("folds a run of alike calls into one step that opens to each call's card", () => {
    const reads = [1, 2, 3, 4].map(n => call("mem_read", { path: `notes/${n}.md` }));
    const search = call("call_tool", { tool_id: "slack_user.search_messages" }, { result: { content: [], details: { ok: true, label: "Searched Slack for “deploy”" } } });
    expect(groupCalls([...reads, search]).map(group => group.length)).toEqual([4, 1]);
    render(<CallSteps calls={[...reads, search]} />);
    expect(screen.getByText("Read 4 memory files")).toBeTruthy();
    expect(screen.getByText("4 steps")).toBeTruthy();
    fireEvent.click(screen.getByText("Searched Slack for “deploy”"));
    expect(screen.getByTestId(`card-${search.callId}`)).toBeTruthy();
    expect(screen.queryByTestId(`card-${reads[0]!.callId}`)).toBeNull();
    fireEvent.click(screen.getByText("Read 4 memory files"));
    fireEvent.click(screen.getByText("Read memory notes/1.md"));
    expect(screen.getByTestId(`card-${reads[0]!.callId}`)).toBeTruthy();
  });
});

describe("step sources", () => {
  it("counts a call's sources on its step and lists each, linked, when the step opens", () => {
    const read = call("call_tool", { tool_id: "github.read_repo_file" }, { result: { content: [], details: { ok: true, label: "Read src/a.ts in acme/app", sources: [
      { id: "s4", service: "github", title: "acme/app/src/a.ts", url: "https://github.com/acme/app/blob/abc/src/a.ts#L1-L9", location: "L1-L9 at abc1234" },
      { id: "s5", service: "memory", title: "notes/a.md", url: "/memory/notes/a.md", snippet: "A note." },
    ] } } });
    render(<WorkGroup parts={[read]} live={false} />);
    expect(screen.getByText("GitHub · 2 sources")).toBeTruthy();
    fireEvent.click(screen.getByText("Read src/a.ts in acme/app"));
    const github = screen.getByRole("link", { name: "acme/app/src/a.ts" });
    expect(github.getAttribute("href")).toBe("https://github.com/acme/app/blob/abc/src/a.ts#L1-L9");
    expect(github.getAttribute("target")).toBe("_blank");
    const memory = screen.getByRole("link", { name: "A" });
    expect(memory.getAttribute("href")).toBe("/memory/notes/a.md");
    expect(memory.getAttribute("target")).toBeNull();
    expect(screen.getByText("L1-L9 at abc1234")).toBeTruthy();
    expect(document.querySelector('[data-source-id="s5"]')?.textContent).toContain("A note.");
  });
});
