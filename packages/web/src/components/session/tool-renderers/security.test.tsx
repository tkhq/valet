// @vitest-environment jsdom
/**
 * `sec_*` tool renderers (valet-security M8). The load-bearing case is the
 * round-trip rule (CLAUDE.md): every result extraction must reach the TEXT
 * through `resultText`, for pi-agent-core's content-array shape AND the
 * engine's `{ text }` shape — the exact hop that has broken three times.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { pickRenderer } from "./index";
import {
  secCellCompleteRenderer,
  secCloseRenderer,
  secDispatchRenderer,
  secFindingReportRenderer,
  secGenericRenderer,
} from "./security";

const findingArgs = {
  severity: "high",
  title: "Token logged in plain text",
  file: "src/auth/logger.ts",
  line: 42,
  body: "x".repeat(220),
};

/** pi-agent-core's AgentToolResult shape. */
function contentResult(text: string): unknown {
  return { content: [{ type: "text", text }] };
}

describe("registry wiring", () => {
  it("routes sec_* names to the family renderers, ahead of the fallback", () => {
    expect(pickRenderer("sec_finding_report")).toBe(secFindingReportRenderer);
    expect(pickRenderer("sec_dispatch")).toBe(secDispatchRenderer);
    expect(pickRenderer("sec_cell_complete")).toBe(secCellCompleteRenderer);
    expect(pickRenderer("sec_close")).toBe(secCloseRenderer);
    expect(pickRenderer("sec_status")).toBe(secGenericRenderer);
    expect(pickRenderer("sec_fs_read")).toBe(secGenericRenderer);
  });
});

describe("sec_finding_report card", () => {
  const resultLine = "finding fnd_1 recorded [high] fingerprint abc123";

  it("renders the severity badge, title, and file:line from args", () => {
    render(
      <secFindingReportRenderer.Body
        toolName="sec_finding_report"
        args={findingArgs}
        result={{ text: resultLine }}
        status="completed"
      />,
    );
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("Token logged in plain text")).toBeTruthy();
    expect(screen.getByText("src/auth/logger.ts:42")).toBeTruthy();
  });

  it("reaches the result TEXT for the engine's { text } shape", () => {
    render(
      <secFindingReportRenderer.Body
        toolName="sec_finding_report"
        args={findingArgs}
        result={{ text: resultLine }}
        status="completed"
      />,
    );
    expect(screen.getByText(new RegExp("finding fnd_1 recorded"))).toBeTruthy();
  });

  it("reaches the result TEXT for pi-agent-core's content-array shape", () => {
    render(
      <secFindingReportRenderer.Body
        toolName="sec_finding_report"
        args={findingArgs}
        result={contentResult(resultLine)}
        status="completed"
      />,
    );
    expect(screen.getByText(new RegExp("finding fnd_1 recorded"))).toBeTruthy();
  });

  it("renders a hostile title as an inert text node", () => {
    const { container } = render(
      <secFindingReportRenderer.Body
        toolName="sec_finding_report"
        args={{ ...findingArgs, title: '<img src=x onerror="window.alert(1)">' }}
        result={{ text: resultLine }}
        status="completed"
      />,
    );
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("sec_dispatch cell card", () => {
  const dispatchText =
    "dispatched cell 01-recon (id cell_1, attempt 2, mode resume) to child session ses_child9. " +
    "Its settlement will arrive in this thread as a child.settled signal.";

  it("parses the cell + child link from a content-array result", () => {
    render(
      <secDispatchRenderer.Body
        toolName="sec_dispatch"
        args={{ mode: "resume" }}
        result={contentResult(dispatchText)}
        status="completed"
      />,
    );
    expect(screen.getByText("01-recon")).toBeTruthy();
    expect(screen.getByText("attempt 2")).toBeTruthy();
    expect(screen.getByText("open child session")).toBeTruthy();
  });
});

describe("sec_cell_complete + sec_close summaries", () => {
  it("shows the outcome line, violation text included", () => {
    render(
      <secCellCompleteRenderer.Body
        toolName="sec_cell_complete"
        args={{ cell_id: "cell_1" }}
        result={{
          text: "outcome: violation — checklist has 3 pending items\nThe cell stays running.",
        }}
        status="completed"
      />,
    );
    expect(
      screen.getByText(new RegExp("outcome: violation — checklist has 3 pending items")),
    ).toBeTruthy();
  });

  it("renders the sec_close manifest headline from its JSON text", () => {
    const manifest = {
      engagementId: "eng-1",
      status: "completed",
      findings: {
        total: 5,
        distinctBySeverity: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
        statusBreakdown: { open: 2, verified: 2, refuted: 1 },
      },
    };
    render(
      <secCloseRenderer.Body
        toolName="sec_close"
        args={{}}
        result={contentResult(JSON.stringify(manifest, null, 2))}
        status="completed"
      />,
    );
    expect(screen.getByText("Engagement completed — 5 findings")).toBeTruthy();
    expect(screen.getByText("critical")).toBeTruthy();
    expect(screen.getByText(new RegExp("2 open · 2 verified · 1 refuted"))).toBeTruthy();
  });
});
