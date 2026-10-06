// @vitest-environment jsdom
/**
 * Signal cards (assistant-centered web UI, decision 3): a wire message
 * carrying `signal` must render as a card, never a user bubble.
 * `child.settled` gets a dedicated child card (title/outcome/preview,
 * clickable); any other signalType gets a generic envelope (chip + body).
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Message } from "@valet/api/wire";
import { SignalCard, childCardTitle, isLongBody, truncateBody } from "./signal-card";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children: ReactNode; to: string; params: Record<string, string> }) =>
    <a href={Object.entries(params).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>,
}));

function baseMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    sessionId: "orchestrator:user-1",
    threadId: "thread-1",
    role: "user",
    content: "Fixed the auth bug and opened a PR.",
    parts: [{ kind: "text", text: "Fixed the auth bug and opened a PR." }],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("SignalCard — child.settled", () => {
  it("renders a child card with title, outcome badge, and body preview — not a user bubble", () => {
    const message = baseMessage({
      signal: {
        signalType: "child.settled",
        attributes: { title: "fix-auth", outcome: "completed" },
        senderSessionId: "child-1",
      },
    });

    render(<SignalCard message={message} onOpenChild={vi.fn()} />);

    expect(screen.getByText("fix-auth")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText(/Fixed the auth bug/)).toBeTruthy();
    expect(screen.queryByText("You")).toBeNull();
  });

  it("falls back to the child session id when attributes.title is absent", () => {
    const message = baseMessage({
      signal: { signalType: "child.settled", senderSessionId: "child-2" },
    });
    // `onOpenChild` provided so the card renders as a plain button, not a
    // router `<Link>` — no router context needed for this assertion.
    render(<SignalCard message={message} onOpenChild={vi.fn()} />);
    expect(screen.getByText("child-2")).toBeTruthy();
  });

  it("calls onOpenChild with the sender session id when clicked", async () => {
    const onOpenChild = vi.fn();
    const message = baseMessage({
      signal: {
        signalType: "child.settled",
        attributes: { title: "fix-auth" },
        senderSessionId: "child-1",
      },
    });
    render(<SignalCard message={message} onOpenChild={onOpenChild} />);
    screen.getByRole("button").click();
    expect(onOpenChild).toHaveBeenCalledWith("child-1");
  });
});

describe("SignalCard — other signal types", () => {
  it("renders a generic envelope card with the signalType chip and body", () => {
    const message = baseMessage({
      content: "Reminder: standup at 10am.",
      signal: { signalType: "reminder.due" },
    });
    render(<SignalCard message={message} />);
    expect(screen.getByText("reminder.due")).toBeTruthy();
    expect(screen.getByText(/Reminder: standup/)).toBeTruthy();
    expect(screen.queryByText("You")).toBeNull();
  });
});

describe("SignalCard — long bodies", () => {
  it("starts a long message collapsed, and expands it on request", () => {
    const content = Array.from({ length: 20 }, (_, i) => `Source line ${i}`).join("\n");
    const message = baseMessage({ content, signal: { signalType: "reminder.due" } });
    render(<SignalCard message={message} />);
    const toggle = screen.getByRole("button", { name: "Show full message" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a short message whole, with no toggle", () => {
    render(<SignalCard message={baseMessage({ content: "Reminder: standup at 10am.", signal: { signalType: "reminder.due" } })} />);
    expect(screen.queryByRole("button", { name: "Show full message" })).toBeNull();
    expect(isLongBody("x".repeat(601))).toBe(true);
    expect(isLongBody("short")).toBe(false);
  });
});

describe("childCardTitle", () => {
  it("prefers attributes.title", () => {
    expect(
      childCardTitle({ signalType: "child.settled", attributes: { title: "fix-auth" }, senderSessionId: "c1" }),
    ).toBe("fix-auth");
  });

  it("falls back to senderSessionId", () => {
    expect(childCardTitle({ signalType: "child.settled", senderSessionId: "c1" })).toBe("c1");
  });

  it("falls back to a generic label when neither is present", () => {
    expect(childCardTitle({ signalType: "child.settled" })).toBe("child runtime");
  });
});

describe("truncateBody", () => {
  it("returns short text unchanged", () => {
    expect(truncateBody("short")).toBe("short");
  });

  it("truncates to ~max chars with an ellipsis", () => {
    const long = "a".repeat(250);
    const result = truncateBody(long, 200);
    expect(result.length).toBeLessThanOrEqual(201);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("workflow operations", () => {
  it.each(["workflow.request", "workflow.settled"])("collapses %s without losing the full report or run link", (signalType) => {
    const content = Array.from({ length: 40 }, (_, i) => `Workflow source ${i}`).join("\n\n");
    const { container } = render(<SignalCard message={baseMessage({ content,
      signal: { signalType, attributes: { runId: "run-1", outcome: "completed" } },
    })} />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open run" }).getAttribute("href")).toBe("/workflows/runs/run-1");
    fireEvent.click(container.querySelector("summary")!);
    expect(details.open).toBe(true);
    expect(screen.getByText("Workflow source 39")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show full message" })).toBeNull();
    fireEvent.click(container.querySelector("summary")!);
    expect(details.open).toBe(false);
  });

  it("keeps legacy workflow reports compact without inventing a run link", () => {
    const { container } = render(<SignalCard message={baseMessage({ signal: { signalType: "workflow.request" } })} />);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByText("Workflow request")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
