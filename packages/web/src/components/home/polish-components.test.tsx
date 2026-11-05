// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StreamMessage } from "~/stores/stream";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={params ? to.replace(/\$(\w+)/g, (_, key: string) => params[key] ?? "") : to}>{children}</a>,
}));

import { BriefCard } from "./brief-card";
import { OutputCards } from "./output-card";
import { TasksSummary } from "./tasks-summary";
import { briefFromArgs } from "~/components/session/tool-renderers/brief";
import { expiryLabel } from "~/components/session/expiry-countdown";
import { gateOutcomeLabel } from "~/components/session/gate-outcome";
import { yesNoQuestion } from "~/components/session/quick-replies";
import { fyiText } from "~/components/session/message-item";

function assistant(text: string, extra: Partial<StreamMessage> = {}): StreamMessage {
  return { id: "m1", role: "assistant", content: text, parts: [{ kind: "text", text }], createdAt: 1, completed: true, threadId: "t", ...extra } as StreamMessage;
}

describe("yesNoQuestion", () => {
  it.each([
    ["Drafted with the data room link. Send from you?", true],
    ["Should I use the monorepo or the deploy repo?", false],
    ["Merged the fix. Deploy it now, okay?", true],
    ["Design review at 3, then nothing. Want prep notes?", true],
    ["Should I merge #945?", true],
    ["I can split it. Shall I?", true],
    ["Which repository should I use?", false],
    ["Done. The report is in Drive.", false],
  ])("reads %s", (text, expected) => {
    expect(Boolean(yesNoQuestion([assistant(text)]))).toBe(expected);
  });

  it("ignores a question the person already answered", () => {
    const answered = [assistant("Want prep notes?"), { ...assistant("Yes"), id: "m2", role: "user" } as StreamMessage];
    expect(yesNoQuestion(answered)).toBeUndefined();
  });

  it("waits for the reply to finish", () => {
    expect(yesNoQuestion([assistant("Want prep notes?", { completed: false })])).toBeUndefined();
  });
});

describe("fyiText", () => {
  it("reads a one-line FYI from Valet", () => {
    expect(fyiText(assistant("FYI: the install slipped to Nov 10. I'm watching it."))).toBe("the install slipped to Nov 10. I'm watching it.");
  });
  it("leaves a normal reply, a long note, and a person's message alone", () => {
    expect(fyiText(assistant("Here is the plan."))).toBeUndefined();
    expect(fyiText(assistant("FYI: line one\nline two"))).toBeUndefined();
    expect(fyiText({ ...assistant("FYI: hi"), role: "user" } as StreamMessage)).toBeUndefined();
  });
});

describe("approval outcomes", () => {
  it("names what happened after an approval", () => {
    expect(gateOutcomeLabel({ type: "approval", tool: { id: "slack.send_message" } }, "approve")).toBe("Sent");
    expect(gateOutcomeLabel({ type: "approval", tool: { id: "github.merge_pull_request" } }, "approve")).toBe("Merged");
    expect(gateOutcomeLabel({ type: "approval", tool: { id: "linear.create_issue" } }, "approve")).toBe("Approved");
    expect(gateOutcomeLabel({ type: "approval", tool: { id: "slack.send_message" } }, "deny")).toBe("Denied");
    expect(gateOutcomeLabel({ type: "question" }, "answer")).toBe("Answered");
  });

  it("counts down in minutes, then seconds", () => {
    expect(expiryLabel(8 * 60_000)).toBe("Expires in 8 min");
    expect(expiryLabel(40_000)).toBe("Expires in 40 s");
    expect(expiryLabel(3 * 3_600_000)).toBe("Expires in 3 h");
    expect(expiryLabel(0)).toBe("Expired");
  });
});

describe("BriefCard", () => {
  it("reads a show_brief call and links items about tasks", () => {
    const brief = briefFromArgs({ headline: "Morning. 4 in progress, 2 need you.", items: [
      { topic: "Series A", text: "2 slides need your eye.", state: "needs_you", thread_id: "th-1" },
      { topic: "Alerts", text: "Quiet overnight.", state: "unknown" },
      { text: "no topic" },
    ] });
    expect(brief?.items).toEqual([
      { topic: "Series A", text: "2 slides need your eye.", state: "needs_you", threadId: "th-1" },
      { topic: "Alerts", text: "Quiet overnight.", state: "fyi" },
    ]);
    render(<BriefCard headline={brief!.headline} items={brief!.items} />);
    expect(screen.getByText("Morning. 4 in progress, 2 need you.")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/threads/th-1");
    expect(screen.getByLabelText("Needs you")).toBeTruthy();
  });
});

describe("TasksSummary and OutputCards", () => {
  it("leaves out zero counts", () => {
    const { container, rerender } = render(<TasksSummary needsYou={1} working={0} finished={3} />);
    expect(container.textContent).toBe("1 needs you3 finished");
    rerender(<TasksSummary needsYou={0} working={0} finished={0} />);
    expect(container.textContent).toBe("Nothing in flight.");
  });

  it("opens a file on its share page and a pull request on GitHub", () => {
    render(<OutputCards outputs={[
      { kind: "file", title: "Series A deck", href: "/a/tok123", updatedAt: Date.now() },
      { kind: "pull_request", title: "tkhq/valet #945", href: "https://github.com/tkhq/valet/pull/945", state: "merged", updatedAt: Date.now() },
    ]} />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/a/tok123", "https://github.com/tkhq/valet/pull/945"]);
    expect(links[1]!.textContent).toContain("Merged");
    expect(links[0]!.textContent).toContain("Updated");
  });
});
