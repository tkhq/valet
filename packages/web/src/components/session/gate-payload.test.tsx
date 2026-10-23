// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { GatePayloadPreview, gateSummaryText, hasGatePayloadPreview, splitGateBody, type GateTool } from "./gate-payload";

afterEach(() => {
  vi.restoreAllMocks();
});

function preview(tool: GateTool) {
  render(<GatePayloadPreview tool={tool} />);
  return screen.getByRole("group", { name: "Preview" });
}

/** The label/value pairs of the preview's field list. */
function rows(group: HTMLElement): Array<[string, string]> {
  const terms = [...group.querySelectorAll("dt")];
  return terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]);
}

describe("gateSummaryText", () => {
  const block = 'tool_id=slack.send_message\nargs={\n  "channel": "#eng",\n  "text": "hi"\n}';

  it("removes the tool_id/args block and trims", () => {
    expect(gateSummaryText(`  Post the release notes\n\n${block}`)).toBe("Post the release notes");
  });

  it("keeps a body without the block", () => {
    expect(gateSummaryText("Deploy to production?\n")).toBe("Deploy to production?");
    expect(gateSummaryText(undefined)).toBeUndefined();
  });

  it("returns undefined when only the block remains", () => {
    expect(gateSummaryText(block)).toBeUndefined();
  });

  it("cuts at the last block when the summary quotes one", () => {
    const summary = "Retry the call\ntool_id=old.call\nargs={}";
    expect(splitGateBody(`${summary}\n\n${block}`)).toEqual({ summary, call: block });
  });
});

describe("GatePayloadPreview — Slack", () => {
  it("shows the channel, the thread, and the message as markdown", () => {
    const group = preview({ id: "slack.send_message", args: { channel: "#eng-releases", text: "Release **1.2** is out.\nSee the notes.", thread_ts: "1780887543.189519" } });
    expect(within(group).getByText("Slack · #eng-releases · in a thread")).toBeTruthy();
    expect(within(group).getByText("1.2").tagName).toBe("STRONG");
    expect(group.textContent).not.toContain("Block Kit");
  });

  it("shows a channel id as given and notes a Block Kit layout", () => {
    const group = preview({ id: "slack_user.post_message", args: { channel: "C0123ABCD", text: "Fallback text", blocks: "[]" } });
    expect(within(group).getByText("Slack · C0123ABCD")).toBeTruthy();
    expect(group.textContent).toContain("Slack shows a Block Kit layout instead of this text.");
  });

  it.each([
    [{ id: "slack.dm_user", args: { user: "U0123", text: "Hi there" } }, "Slack DM · U0123"],
    [{ id: "slack_user.send_dm", args: { user: "W0456", text: "Hi there" } }, "Slack DM · W0456"],
    [{ id: "slack.dm_owner", args: { text: "Hi there" } }, "Slack DM · owner"],
    [{ id: "slack.reply_to_origin", args: { text: "Hi there" } }, "Slack reply"],
    [{ id: "slack.update_message", args: { channel: "#eng", ts: "1780887543.189519", text: "Hi there" } }, "Edit Slack message · #eng"],
  ])("labels %o", (tool, heading) => {
    const group = preview(tool);
    expect(within(group).getByText(heading)).toBeTruthy();
    expect(within(group).getByText("Hi there")).toBeTruthy();
  });

  it("clamps a tall message and toggles it", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(192);
    const group = preview({ id: "slack.send_message", args: { channel: "#eng", text: "line\n\n".repeat(40) } });
    const toggle = within(group).getByRole("button", { name: "Show all" });
    const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(body?.className).toContain("max-h-48");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(body?.className).not.toContain("max-h-48");
    expect(within(group).getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("adds no toggle when the message fits", () => {
    const group = preview({ id: "slack.send_message", args: { channel: "#eng", text: "Short" } });
    expect(within(group).queryByRole("button")).toBeNull();
  });
});

describe("GatePayloadPreview — email", () => {
  it("shows the recipients, the subject, and the body", () => {
    const group = preview({
      id: "gmail.send_email",
      args: { to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], subject: "Weekly report", body: "Numbers are **up**." },
    });
    expect(within(group).getByText("Email")).toBeTruthy();
    expect(rows(group)).toEqual([["To", "a@example.com, b@example.com"], ["Cc", "c@example.com"], ["Subject", "Weekly report"]]);
    expect(within(group).getByText("up").tagName).toBe("STRONG");
  });

  it("labels drafts and skips empty Cc", () => {
    const group = preview({ id: "gmail.create_draft", args: { to: "a@example.com", cc: [], subject: "", body: "" } });
    expect(within(group).getByText("Email draft")).toBeTruthy();
    expect(rows(group)).toEqual([["To", "a@example.com"], ["Subject", "(no subject)"]]);
  });

  it("needs a draft id to preview a draft update", () => {
    const args = { to: "a@example.com", subject: "Hi", body: "Body" };
    expect(hasGatePayloadPreview({ id: "gmail.update_draft", args })).toBe(false);
    const group = preview({ id: "gmail.update_draft", args: { ...args, draftId: "r-1" } });
    expect(within(group).getByText("Email draft")).toBeTruthy();
  });

  it("names the draft that send_draft sends", () => {
    const group = preview({ id: "gmail.send_draft", args: { draftId: "r-123" } });
    expect(group.textContent).toBe("Send email draft r-123");
  });
});

describe("GatePayloadPreview — GitHub", () => {
  it("shows a merge with its method and commit title", () => {
    const group = preview({ id: "github.merge_pull_request", args: { owner: "acme", repo: "app", pullNumber: 42, mergeMethod: "squash", commitTitle: "Ship it" } });
    expect(within(group).getByText("Merge acme/app #42")).toBeTruthy();
    expect(rows(group)).toEqual([["Method", "squash"], ["Commit title", "Ship it"]]);
  });

  it("names the default merge method", () => {
    const group = preview({ id: "github.merge_pull_request", args: { owner: "acme", repo: "app", pullNumber: "42" } });
    expect(within(group).getByText("Merge acme/app #42")).toBeTruthy();
    expect(rows(group)).toEqual([["Method", "merge"]]);
  });

  it("shows a new pull request", () => {
    const group = preview({ id: "github.create_pull_request", args: { owner: "acme", repo: "app", title: "Fix login", head: "fix/login", base: "main", body: "Closes the bug.", draft: true } });
    expect(within(group).getByText("Open draft pull request · acme/app")).toBeTruthy();
    expect(rows(group)).toEqual([["Title", "Fix login"], ["Branches", "fix/login → main"]]);
    expect(within(group).getByText("Closes the bug.")).toBeTruthy();
  });

  it("shows a comment", () => {
    const group = preview({ id: "github.create_comment", args: { owner: "acme", repo: "app", issueNumber: 7, body: "Looks good." } });
    expect(within(group).getByText("Comment on acme/app #7")).toBeTruthy();
    expect(within(group).getByText("Looks good.")).toBeTruthy();
  });

  it.each([
    [{ event: "REQUEST_CHANGES", body: "Please add tests." }, [["Verdict", "Request changes"]]],
    [{ event: "COMMENT", comments: [{ path: "a.ts", body: "nit" }, { path: "b.ts", body: "nit" }] }, [["Verdict", "Comment"], ["Line comments", "2"]]],
    [{}, [["Verdict", "Pending, not submitted"]]],
  ])("shows a review %o", (extra, expected) => {
    const group = preview({ id: "github.create_review", args: { owner: "acme", repo: "app", pullNumber: 9, ...extra } });
    expect(within(group).getByText("Review acme/app #9")).toBeTruthy();
    expect(rows(group)).toEqual(expected);
  });
});

describe("GatePayloadPreview — no preview", () => {
  it.each<GateTool>([
    { id: "linear.save_issue", args: { title: "Bug" } },
    { id: "constructor", args: {} },
    { id: "slack.send_message" },
    { id: "slack.send_message", args: { channel: "#eng", text: "  " } },
    { id: "slack.dm_user", args: { text: "Hi" } },
    { id: "slack.update_message", args: { channel: "#eng", text: "Hi" } },
    { id: "gmail.send_email", args: { to: [], subject: "Hi", body: "Body" } },
    { id: "gmail.send_email", args: { to: "a@example.com", body: "Body" } },
    { id: "github.merge_pull_request", args: { owner: "acme", repo: "app", pullNumber: "abc" } },
    { id: "github.create_comment", args: { owner: "acme", issueNumber: 1, body: "Hi" } },
    { id: "github.create_review", args: { owner: "acme", repo: "app", pullNumber: 1, event: 3 } },
  ])("renders nothing for %o", (tool) => {
    expect(hasGatePayloadPreview(tool)).toBe(false);
    const { container } = render(<GatePayloadPreview tool={tool} />);
    expect(container.innerHTML).toBe("");
  });
});
