// @vitest-environment jsdom
/**
 * ToolShell owns the collapse policy for every tool renderer. The tests
 * mirror the acceptance-to-test mapping on TKAI-199: mount-time policy
 * per preference, running→completed auto-collapse, respect for a manual
 * toggle, and the error override — including the transitions that START
 * from a collapsed card, which are the only runs where the effect's
 * error branch does observable work.
 *
 * `prettyToolName` cases stay untouched — the pure-string helper is
 * exercised alongside the rendering tests so a regression here still
 * fails a single file.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { Terminal } from "lucide-react";
import { ToolShell, prettyToolName } from "./tool-shell";
import type { ToolStatus } from "./types";

/**
 * Element helper. Every card shares the same category/icon; only status
 * varies across cases, so the noise stays in one place. Use the same
 * element for `render` and `rerender` so a transition is a prop change
 * on one mounted instance — exactly what the stream store produces.
 */
function shell(status: ToolStatus) {
  return (
    <ToolShell
      toolName="bash"
      category="shell"
      Icon={Terminal}
      status={status}
    >
      <div>body</div>
    </ToolShell>
  );
}

function renderShell(status: ToolStatus) {
  return render(shell(status));
}

function header(): HTMLElement {
  // The header is the only button ToolShell renders, and it is the
  // element that carries `aria-expanded`.
  return screen.getByRole("button");
}

function isExpanded(): boolean {
  return header().getAttribute("aria-expanded") === "true";
}

describe("ToolShell — smart policy (default)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("A1: auto-collapses on running→completed", () => {
    const { rerender } = renderShell("running");
    expect(isExpanded()).toBe(true);

    rerender(shell("completed"));
    expect(isExpanded()).toBe(false);
  });

  it("A2a: keeps the card open when the user expanded while running", () => {
    // Mount running (expanded), click to collapse, click again to
    // expand — the ref now records a user touch and the final state
    // is open. A transition to completed must not rewrite that.
    const { rerender } = renderShell("running");
    fireEvent.click(header());
    fireEvent.click(header());
    expect(isExpanded()).toBe(true);

    rerender(shell("completed"));
    expect(isExpanded()).toBe(true);
  });

  it("A2b: keeps the card closed when the user collapsed while running", () => {
    const { rerender } = renderShell("running");
    fireEvent.click(header());
    expect(isExpanded()).toBe(false);

    rerender(shell("completed"));
    expect(isExpanded()).toBe(false);
  });

  it("A2c: a pointer-down inside the body counts as a user touch", () => {
    // Someone expanding truncated output or selecting text mid-run must
    // not lose the body to the auto-collapse when the call completes.
    const { rerender } = renderShell("running");
    fireEvent.pointerDown(screen.getByText("body"));

    rerender(shell("completed"));
    expect(isExpanded()).toBe(true);
  });

  it("A3a: never auto-collapses when the status flips to error", () => {
    const { rerender } = renderShell("running");
    rerender(shell("error"));
    expect(isExpanded()).toBe(true);
  });

  it("A3c: force-expands a user-collapsed card when it errors", () => {
    // The collapsed→error edge is the only one where the effect's error
    // branch does observable work — without it this test ships red.
    const { rerender } = renderShell("running");
    fireEvent.click(header());
    expect(isExpanded()).toBe(false);

    rerender(shell("error"));
    expect(isExpanded()).toBe(true);
  });

  it("B3: absent preference key behaves as smart", () => {
    // Guard against a fallback that silently applies a different
    // policy: mount running, expect expanded; mount completed, expect
    // collapsed at mount.
    expect(localStorage.getItem("tool-card-default")).toBeNull();

    const running = renderShell("running");
    expect(isExpanded()).toBe(true);
    running.unmount();

    renderShell("completed");
    expect(isExpanded()).toBe(false);
  });
});

describe("ToolShell — always-collapsed policy", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("tool-card-default", "always-collapsed");
  });

  it("B1: mounts a running card collapsed", () => {
    renderShell("running");
    expect(isExpanded()).toBe(false);
  });

  it("A3b: mounts an error card expanded even under always-collapsed", () => {
    renderShell("error");
    expect(isExpanded()).toBe(true);
  });

  it("A3d: force-expands a collapsed running card when it errors", () => {
    const { rerender } = renderShell("running");
    expect(isExpanded()).toBe(false);

    rerender(shell("error"));
    expect(isExpanded()).toBe(true);
  });
});

describe("ToolShell — always-expanded policy", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("tool-card-default", "always-expanded");
  });

  it("B2: keeps a completed card expanded at mount and across error", () => {
    const { rerender } = renderShell("completed");
    expect(isExpanded()).toBe(true);

    rerender(shell("error"));
    expect(isExpanded()).toBe(true);
  });

  it("no-ops the auto-collapse effect on running→completed", () => {
    const { rerender } = renderShell("running");
    expect(isExpanded()).toBe(true);

    rerender(shell("completed"));
    expect(isExpanded()).toBe(true);
  });

  it("A3e: force-expands a user-collapsed card when it errors", () => {
    // Errors override the policy no-op too: the user asked for
    // everything open, and the error message must be readable even
    // after a manual collapse.
    const { rerender } = renderShell("running");
    fireEvent.click(header());
    expect(isExpanded()).toBe(false);

    rerender(shell("error"));
    expect(isExpanded()).toBe(true);
  });
});

describe("ToolShell — accessibility wiring", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("gives repeated tool names distinct body ids", () => {
    // Two bash cards in one thread must not share a body id —
    // aria-controls has to reference exactly one element.
    render(
      <>
        {shell("running")}
        {shell("running")}
      </>,
    );
    const ids = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-controls"));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("drops aria-controls while the body is unmounted", () => {
    renderShell("completed");
    expect(isExpanded()).toBe(false);
    expect(header().getAttribute("aria-controls")).toBeNull();
  });
});

/**
 * D: pure-name helper. These predate TKAI-199 and must not regress.
 */
describe("prettyToolName", () => {
  it("maps known engine tools to friendly names", () => {
    expect(prettyToolName("bash")).toBe("shell");
    expect(prettyToolName("mem_write")).toBe("memory write");
    expect(prettyToolName("thread_read")).toBe("thread read");
  });

  it("de-snake_cases unknown plugin tools", () => {
    expect(prettyToolName("github_create_pr")).toBe("github create pr");
    expect(prettyToolName("stripe.create_charge")).toBe("stripe create charge");
  });

  it("passes plain names through", () => {
    expect(prettyToolName("read")).toBe("read");
  });
});
