// @vitest-environment jsdom
/**
 * CommandResult: a wire message with a `command` field renders as a compact
 * card. Visually distinct: ok=true uses neutral accent; ok=false uses danger.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Message } from "@valet/api/wire";
import { CommandResult } from "./command-result";

function baseMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    sessionId: "s1",
    threadId: "t1",
    role: "system",
    content: "Status is **idle**.",
    parts: [{ kind: "text", text: "Status is **idle**." }],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("CommandResult — ok:true", () => {
  it("renders the command name chip as /status", () => {
    const message = baseMessage({
      command: { name: "status", source: "builtin", ok: true },
    });
    render(<CommandResult message={message} />);
    expect(screen.getByText("/status")).toBeTruthy();
  });

  it("renders the source badge", () => {
    const message = baseMessage({
      command: { name: "status", source: "builtin", ok: true },
    });
    render(<CommandResult message={message} />);
    expect(screen.getByText("builtin")).toBeTruthy();
  });

  it("renders the markdown body (react-markdown renders **idle** as <strong>)", () => {
    const message = baseMessage({
      command: { name: "status", source: "builtin", ok: true },
    });
    render(<CommandResult message={message} />);
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("does NOT apply danger styling when ok:true", () => {
    const message = baseMessage({
      command: { name: "status", source: "builtin", ok: true },
    });
    const { container } = render(<CommandResult message={message} />);
    expect(container.firstElementChild?.className).not.toMatch(/danger/);
  });
});

describe("CommandResult — ok:false", () => {
  it("applies danger styling when ok:false", () => {
    const message = baseMessage({
      command: { name: "run", source: "builtin", ok: false },
    });
    const { container } = render(<CommandResult message={message} />);
    expect(container.firstElementChild?.className).toMatch(/danger/);
  });
});

describe("CommandResult — missing command field", () => {
  it("renders null when command is absent", () => {
    const message = baseMessage();
    const { container } = render(<CommandResult message={message} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("CommandResult — plugin source", () => {
  it("renders a plugin source badge", () => {
    const message = baseMessage({
      command: { name: "pr", source: "plugin:github", ok: true },
    });
    render(<CommandResult message={message} />);
    expect(screen.getByText("/pr")).toBeTruthy();
    expect(screen.getByText("plugin:github")).toBeTruthy();
  });
});
