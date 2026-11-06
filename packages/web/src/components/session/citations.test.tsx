// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Message } from "@valet/api/wire";
import { Markdown } from "~/components/markdown";
import { ThreadSourcesProvider } from "./citations";
import { WorkGroup, CallSteps, stepView } from "./work-group";
import { PinnedPlan } from "./thread-plan";
import { MessageItem } from "./message-item";
import { SourceList } from "./source-list";
import { sourcePresentation } from "./source-presentation";

const source = { id: "s1", service: "slack", title: "Deploy decision", snippet: "Ship after the checks pass.", location: "#deploy · 10:30", url: "https://app.slack.com/archives/C1/p123" };
const call = { kind: "tool_call" as const, callId: "call-1", toolName: "call_tool", status: "completed" as const,
  args: { tool_id: "slack_user.search_messages", params: { query: "deploy" } }, result: { text: "Ship after checks", details: { ok: true, label: "Searched Slack for deploy", sources: [source] } } };
const otherCall = { ...call, callId: "call-2", result: { text: "Another result", details: { ok: true, label: "Searched Slack for release" } } };
const message: Message = { id: "m1", sessionId: "session", threadId: "thread", role: "assistant", content: "", createdAt: 1, parts: [call, otherCall] };
const scroll = vi.fn();

beforeEach(() => {
  localStorage.clear();
  scroll.mockClear();
  HTMLElement.prototype.scrollIntoView = scroll;
});

function prose(text: string, messages: Message[] = [message], threadId = "thread") {
  return <ThreadSourcesProvider threadId={threadId} messages={messages}><Markdown citations>{text}</Markdown></ThreadSourcesProvider>;
}

describe("source citations", () => {
  it("renders known prose citations and keeps code, link labels, and unknown ids literal", () => {
    render(prose('Ship it [s1]. Unknown [s999]. Inline `[s1]`. [A [s1]](https://example.com)\n\n```text\n[s1]\n```'));
    expect(screen.getAllByRole("button", { name: "Source s1: Deploy decision" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "A [s1]" }).getAttribute("href")).toBe("https://example.com");
    expect(screen.getByText(/Unknown \[s999\]/)).toBeTruthy();
    expect(screen.getAllByText("[s1]", { selector: "code" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /s999/ })).toBeNull();
  });

  it("keeps an escaped citation literal beside a real citation", () => {
    render(prose(String.raw`Escaped \[s1]. A real source [s1].`));
    expect(screen.getAllByRole("button", { name: "Source s1: Deploy decision" })).toHaveLength(1);
    expect(screen.getByText(/Escaped \[s1\]/)).toBeTruthy();
  });

  it("resolves prior calls only in the current thread, including after a thread switch", () => {
    const other: Message = { ...message, id: "other", threadId: "other", parts: [{ ...call, result: { details: { sources: [{ ...source, title: "Other thread" }] } } }] };
    const view = render(prose("Result [s1]", [message, other]));
    expect(screen.getByRole("button", { name: "Source s1: Deploy decision" })).toBeTruthy();
    view.rerender(prose("Result [s1]", [message, other], "other"));
    expect(screen.getByRole("button", { name: "Source s1: Other thread" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Source s1: Deploy decision" })).toBeNull();
    view.rerender(prose("Result [s1]", [message, other], "empty"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("adds a citation when live source metadata arrives and keeps user text literal", () => {
    const live: Message = { ...message, parts: [{ ...call, status: "running", result: undefined }] };
    const view = render(prose("Result [s1]", [live]));
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(prose("Result [s1]", [message]));
    expect(screen.getByRole("button", { name: "Source s1: Deploy decision" })).toBeTruthy();
    view.rerender(<ThreadSourcesProvider threadId="thread" messages={[message]}>
      <MessageItem ratings={false} message={{ ...message, id: "reply", role: "assistant", parts: [{ kind: "text", text: "Reply [s1]" }] }} />
      <MessageItem ratings={false} message={{ ...message, id: "user", role: "user", parts: [{ kind: "text", text: "User [s1]" }] }} />
    </ThreadSourcesProvider>);
    expect(screen.getAllByRole("button", { name: "Source s1: Deploy decision" })).toHaveLength(1);
    expect(screen.getByText("User [s1]")).toBeTruthy();
  });

  it("keeps hover to a source title and location without repeating the excerpt", async () => {
    const user = userEvent.setup();
    render(prose("Result [s1]"));
    await user.hover(screen.getByRole("button", { name: "Source s1: Deploy decision" }));
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText(source.title)).toBeTruthy();
    expect(within(tooltip).getByText(`Slack · ${source.location}`)).toBeTruthy();
    expect(within(tooltip).queryByText(source.snippet)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Source s1: Deploy decision" }));
    expect(screen.getByRole("dialog", { name: "Source s1" })).toBeTruthy();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens a keyboard-accessible source panel with its location, excerpt, and original link", async () => {
    const user = userEvent.setup();
    render(prose("Result [s1]"));
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Source s1" })).toBeTruthy();
    expect(screen.getByText(source.snippet)).toBeTruthy();
    expect(screen.getByText(`Slack · ${source.location}`)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open original" }).getAttribute("href")).toBe(source.url);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Source s1: Deploy decision" }));
  });

  it("says when a source has no link", async () => {
    const user = userEvent.setup();
    const { url: _url, ...unlinked } = source;
    const unlinkedMessage = { ...message, parts: [{ ...call, result: { details: { sources: [unlinked] } } }] };
    render(prose("Result [s1]", [unlinkedMessage]));
    await user.tab();
    await user.keyboard("{Enter}");
    const panel = screen.getByRole("dialog", { name: "Source s1" });
    expect(within(panel).getByText("No link for this source")).toBeTruthy();
    expect(within(panel).queryByRole("link")).toBeNull();
  });

  it("uses an icon alone and cleans scoped memory titles and bounded plain-text excerpts", async () => {
    const user = userEvent.setup();
    const memory = { id: "s1", service: "memory", title: "team:team_08d11a42/projects/compact-citations.md",
      url: "/memory/team%3Ateam_08d11a42/projects/compact-citations.md", location: "team:team_08d11a42/projects/compact-citations.md",
      snippet: "# Compact citations ## Summary - **Quiet markers** keep the reply readable. - [Open details](https://example.com) when needed. " + "Extra context. ".repeat(15) };
    const memoryMessage = { ...message, parts: [{ ...call, result: { details: { sources: [memory] } } }] };
    render(prose("Result [s1]", [memoryMessage]));
    const marker = screen.getByRole("button", { name: "Source s1: Compact citations" });
    expect(marker.textContent).toBe("");
    await user.click(marker);
    const panel = screen.getByRole("dialog", { name: "Source s1" });
    expect(within(panel).getByText("Compact citations")).toBeTruthy();
    expect(panel.textContent).not.toMatch(/team:|team_08d11a42|projects\/|##|\*\*|\]\(/);
    const excerpt = within(panel).getByText(/^Summary Quiet markers/).textContent ?? "";
    expect(excerpt.length).toBeLessThanOrEqual(140);
    expect(excerpt).toContain("Open details when needed.");
    expect(excerpt).not.toContain("Compact citations");
    expect(excerpt.endsWith("…")).toBe(true);
    expect(within(panel).getByRole("link", { name: "Open original" }).getAttribute("href")).toBe(memory.url);
    expect(within(panel).getByRole("link", { name: "Open original" }).getAttribute("target")).toBeNull();
  });

  it.each(["google_calendar", "google-calendar", "google_calendar_events", "google-calendar-events"])("omits persisted Calendar snippets for %s while keeping titles and links", async service => {
    const calendarSource = { ...source, service, title: "Vendor call", snippet: "Meeting passcode 123456" };
    const calendarMessage = { ...message, parts: [{ ...call, result: { details: { sources: [calendarSource] } } }] };
    render(<ThreadSourcesProvider threadId="thread" messages={[calendarMessage]}>
      <SourceList sources={[calendarSource]} /><Markdown citations>Result [s1]</Markdown>
    </ThreadSourcesProvider>);
    expect(screen.getByRole("link", { name: "Vendor call" }).getAttribute("href")).toBe(source.url);
    fireEvent.click(screen.getByRole("button", { name: "Source s1: Vendor call" }));
    const panel = screen.getByRole("dialog", { name: "Source s1" });
    expect(within(panel).getByText("Vendor call")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "Open original" }).getAttribute("href")).toBe(source.url);
    expect(screen.queryAllByText("Meeting passcode 123456")).toHaveLength(0);
  });

  it("uses the same clean memory presentation in the source list and preserves GitHub paths and lines", () => {
    render(<SourceList sources={[
      { id: "s1", service: "memory", title: "team:team_secret/projects/rollout/README.md", snippet: "# Rollout\n- **Start** with checks.", url: "/memory/team%3Ateam_secret/projects/rollout/README.md" },
      { id: "s2", service: "github", title: "acme/app/src/session.ts", location: "L10-L24 at 3f2a1c9", url: "https://github.com/acme/app/blob/3f2a1c9/src/session.ts#L10-L24" },
    ]} />);
    const sources = screen.getByRole("list", { name: "Sources" });
    expect(within(sources).getByRole("link", { name: "Rollout" })).toBeTruthy();
    expect(within(sources).getByText("Start with checks.")).toBeTruthy();
    expect(sources.textContent).not.toMatch(/team:|team_secret|README\.md/);
    expect(within(sources).getByRole("link", { name: "acme/app/src/session.ts" }).getAttribute("href")).toContain("#L10-L24");
    expect(within(sources).getByText("L10-L24 at 3f2a1c9")).toBeTruthy();
  });

  it("names Google, Gmail, Linear and Notion sources readably, and folds a long list after 5", async () => {
    const user = userEvent.setup();
    const services = ["google_drive", "google_calendar", "gmail", "linear", "notion", "google_sheets", "google_docs"];
    render(<SourceList sources={services.map((service, i) => ({ id: `s${i + 1}`, service, title: `Item ${i + 1}`, url: `https://example.com/${i}` }))} />);
    const list = screen.getByRole("list", { name: "Sources" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText("Item 6")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show 2 more sources" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
    await user.click(screen.getByRole("button", { name: "Show fewer sources" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(sourcePresentation({ id: "s1", service: "google_drive", title: "x" }).service).toBe("Google Drive");
    expect(sourcePresentation({ id: "s1", service: "google_calendar", title: "x" }).service).toBe("Google Calendar");
    for (const [service, name] of [["gmail", "Gmail"], ["linear", "Linear"], ["notion", "Notion"]]) {
      expect(sourcePresentation({ id: "s1", service: service!, title: "x" }).service).toBe(name);
    }
  });

  it("does not fold a list of 5 or fewer", () => {
    render(<SourceList sources={[1, 2, 3, 4, 5].map(i => ({ id: `s${i}`, service: "linear", title: `Issue ${i}` }))} />);
    expect(screen.queryByRole("button", { name: /more sources/ })).toBeNull();
  });

  it("cleans a persisted project overview and keeps a different flattened heading within the excerpt limit", () => {
    render(<SourceList sources={[
      { id: "s1", service: "memory", title: "team:team_87bb967c-8cf9-4722-97f8-3a5f99e83fbb/projects/valet/overview.md",
        snippet: "# Valet engineering overview Imported from a project memory export (2026-10-04). Verify current code before treating dated status as live. ## Repositories and branches - Product: https://github.com/acme/valet" },
    ]} />);
    const sources = screen.getByRole("list", { name: "Sources" });
    expect(within(sources).getByText("Valet overview")).toBeTruthy();
    const excerpt = within(sources).getByText(/^Valet engineering overview Imported from/).textContent ?? "";
    expect(excerpt.length).toBeLessThanOrEqual(140);
    expect(sources.textContent).not.toMatch(/team:|team_87bb967c|##/);
  });

  it("preserves real memory document titles and description text", () => {
    render(<SourceList sources={[
      { id: "s1", service: "memory", title: "API / session notes", snippet: "API / session notes describe the request flow." },
      { id: "s2", service: "memory", title: "CI/CD deployment guide", snippet: "CI/CD deployment guide covers release checks." },
    ]} />);
    expect(screen.getByText("API / session notes")).toBeTruthy();
    expect(screen.getByText("API / session notes describe the request flow.")).toBeTruthy();
    expect(screen.getByText("CI/CD deployment guide")).toBeTruthy();
    expect(screen.getByText("CI/CD deployment guide covers release checks.")).toBeTruthy();
  });

  it("keeps body text whose words resemble a memory filename heading", () => {
    render(<SourceList sources={[
      { id: "s1", service: "memory", title: "projects/valet/overview.md", snippet: "# Valet This overview describes the queue." },
    ]} />);
    expect(screen.getByText(/This overview describes the queue\./)).toBeTruthy();
  });

  it.each([
    ["prose", "Read dev-v2 [s1].", "dev-v2"],
    ["inline code", "Read `dev-v2` [s1].", "dev-v2"],
    ["strong text", "Read **dev-v2** [s1].", "dev-v2"],
    ["inline code and a period", "Read `dev-v2`. [s1]", "dev-v2."],
    ["strong text and a comma", "Read **dev-v2**, [s1]", "dev-v2,"],
  ])("groups a citation with the preceding %s so they can wrap together", (_, text, groupText) => {
    render(prose(text));
    const marker = screen.getByRole("button", { name: "Source s1: Deploy decision" });
    const group = marker.parentElement?.parentElement;
    expect(group?.tagName).toBe("SPAN");
    expect(group?.textContent?.trim()).toBe(groupText);
    expect(group?.previousSibling?.textContent).toBe("Read ");
    if (text.includes("`")) expect(group?.querySelector("code")?.textContent).toBe("dev-v2");
    if (text.includes("**")) expect(group?.querySelector("strong")?.textContent).toBe("dev-v2");
  });

  it.each([
    ["prose", "longword".repeat(10)],
    ["inline code", "longword".repeat(10)],
    ["strong text", "longword".repeat(10)],
    ["wide prose", "界".repeat(24)],
  ])("keeps long %s outside the citation group so it can wrap", (kind, token) => {
    const text = kind === "inline code" ? `\`${token}\`` : kind === "strong text" ? `**${token}**` : token;
    const view = render(prose(`Read ${text} [s1].`));
    const marker = screen.getByRole("button", { name: "Source s1: Deploy decision" });
    expect(marker.parentElement?.parentElement?.tagName).toBe("P");
    expect(view.container.textContent).toContain(token);
  });

  it("reveals a source's call inside a collapsed work group and opens its input and output", async () => {
    render(<ThreadSourcesProvider threadId="thread" messages={[message]}>
      <WorkGroup parts={[call, otherCall]} live={false} />
      <Markdown citations>Result [s1]</Markdown>
    </ThreadSourcesProvider>);
    expect(screen.queryByText("Ship after checks")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Source s1: Deploy decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Show step" }));
    await waitFor(() => expect(screen.getByText("Ship after checks")).toBeTruthy());
    expect(screen.getByText("tool_id")).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement?.textContent).toContain("Searched Slack for deploy");
    fireEvent.click(screen.getByRole("button", { name: /Searched Slack user/ }));
    expect(screen.queryByText("Ship after checks")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Source s1: Deploy decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Show step" }));
    await waitFor(() => expect(screen.getByText("Ship after checks")).toBeTruthy());
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("reveals a cited source beyond the first five in a folded call", async () => {
    const sources = Array.from({ length: 7 }, (_, i) => ({ ...source, id: `s${i + 1}`, title: `Decision ${i + 1}` }));
    const many = { ...call, result: { ...call.result, details: { ...call.result.details, sources } } };
    render(<ThreadSourcesProvider threadId="thread" messages={[{ ...message, parts: [many] }]}>
      <CallSteps calls={[many]} /><Markdown citations>Result [s7]</Markdown>
    </ThreadSourcesProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Source s7: Decision 7" }));
    fireEvent.click(screen.getByRole("button", { name: "Show step" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Decision 7" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Show fewer sources" }));
    expect(screen.queryByRole("link", { name: "Decision 7" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Source s7: Decision 7" }));
    fireEvent.click(screen.getByRole("button", { name: "Show step" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Decision 7" })).toBeTruthy());
  });

  it("uses the singular label for one folded source", () => {
    render(<SourceList sources={Array.from({ length: 6 }, (_, i) => ({ ...source, id: `s${i + 1}` }))} />);
    expect(screen.getByRole("button", { name: "Show 1 more source" })).toBeTruthy();
  });

  it("names the actual calendar action service and shows its mark in steps and citations", () => {
    const calendarSource = { ...source, service: "google_calendar", title: "Standup" };
    const calendarCall = { ...call, args: { tool_id: "google-calendar-events.list_events", params: {} },
      result: { details: { sources: [calendarSource] } } };
    const view = render(<ThreadSourcesProvider threadId="thread" messages={[{ ...message, parts: [calendarCall] }]}>
      <CallSteps calls={[calendarCall]} /><Markdown citations>Result [s1]</Markdown>
    </ThreadSourcesProvider>);
    const paths = [...view.container.querySelectorAll("svg path")].map(path => path.getAttribute("d"));
    const citationPath = screen.getByRole("button", { name: "Source s1: Standup" }).querySelector("path")?.getAttribute("d");
    expect(citationPath).toBeTruthy();
    expect(paths.filter(path => path === citationPath)).toHaveLength(2);
    expect(sourcePresentation({ ...calendarSource, service: "google-calendar-events" }).service).toBe("Google Calendar");
  });

  it("reveals a call behind both the progress card and repeated-call group", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["thread-progress", "thread"], { progress: { turnId: "turn", title: "Task progress", status: "complete", revision: "1", updatedAt: 1, tasks: [], omittedTasks: 0, callIds: [call.callId, otherCall.callId] } });
    render(<QueryClientProvider client={client}><ThreadSourcesProvider threadId="thread" messages={[message]}>
      <PinnedPlan threadId="thread" messages={[message]} /><Markdown citations>Result [s1]</Markdown>
    </ThreadSourcesProvider></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Source s1: Deploy decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Show step" }));
    await waitFor(() => expect(screen.getByText("Ship after checks")).toBeTruthy());
    expect(scroll).toHaveBeenCalled();
  });

  it("uses a Slack glyph and marks completed calls with failed results as failures", () => {
    const view = stepView({ ...call, result: { text: "Slack rate limited. Retry later.", details: { ok: false } } }, new Map());
    expect(view.status).toBe("error");
    expect(view.detail).toBe("Slack rate limited. Retry later.");
    const rendered = render(<CallSteps calls={[call, otherCall]} />);
    expect(rendered.container.querySelector('[data-service="slack_user"]')).toBeTruthy();
  });
});
