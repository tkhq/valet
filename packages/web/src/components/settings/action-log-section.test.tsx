// @vitest-environment jsdom
/**
 * Organization · Action log (action-policies plan, Task 5): renders rows
 * with both `resolvedMode` (decision) and `status` (execution outcome)
 * shown distinctly, expands a row to reveal params/result, filters reset
 * the cursor stack, and Next/Previous walk the keyset cursor forward-only.
 * Mocks `~/api/policies` and `@tanstack/react-router`'s `Link` the same way
 * `thread-tree-new-thread.test.tsx` stubs `Link` as a plain anchor.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionLogEntryWire } from "@valet/api/wire";

const useActionLogMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a href="#" {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("~/api/policies", () => ({
  useActionLog: (...args: unknown[]) => useActionLogMock(...args),
}));

import { ActionLogSection } from "./action-log-section";

function entry(overrides: Partial<ActionLogEntryWire> = {}): ActionLogEntryWire {
  return {
    invocationId: "inv_1",
    createdAt: 0,
    service: "gmail",
    actionId: "gmail.send_email",
    riskLevel: "medium",
    resolvedMode: "allow",
    baseMode: "allow",
    matchedPolicyId: null,
    matchedGrantId: null,
    matchedOverrideId: null,
    status: "completed",
    sessionId: "sess_1",
    workflowExecutionId: null,
    userId: "u1",
    params: { to: "a@b.com" },
    paramsTruncated: false,
    result: { ok: true },
    resultTruncated: false,
    error: null,
    durationMs: 12,
    startedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionLogMock.mockReturnValue({
    data: { entries: [entry()], nextCursor: null },
    isLoading: false,
    error: null,
  });
});

describe("ActionLogSection — rows", () => {
  it("shows resolvedMode and status as distinct fields, not conflated", () => {
    render(<ActionLogSection />);
    expect(screen.getByText("allow", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("status: completed")).toBeTruthy();
  });

  it("links session provenance to the session route", () => {
    render(<ActionLogSection />);
    const link = screen.getByRole("link", { name: "session" });
    expect(link.getAttribute("to")).toBe("/sessions/$sessionId");
  });

  it("expanding a row reveals params and result JSON", async () => {
    const user = userEvent.setup();
    render(<ActionLogSection />);

    expect(screen.queryByText(/"to": "a@b.com"/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Toggle details for inv_1" }));
    expect(screen.getByText(/"to": "a@b.com"/)).toBeTruthy();
    expect(screen.getByText(/"ok": true/)).toBeTruthy();
  });

  it("shows the empty state when there are no entries", () => {
    useActionLogMock.mockReturnValue({ data: { entries: [], nextCursor: null }, isLoading: false, error: null });
    render(<ActionLogSection />);
    expect(screen.getByText("No invocations match these filters.")).toBeTruthy();
  });
});

describe("ActionLogSection — filters", () => {
  it("Apply filters calls useActionLog with the service filter and resets the cursor", async () => {
    const user = userEvent.setup();
    render(<ActionLogSection />);

    await user.type(screen.getByLabelText("Service"), "gmail");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    const lastCall = useActionLogMock.mock.calls[useActionLogMock.mock.calls.length - 1];
    expect(lastCall[0]).toEqual({ service: "gmail" });
    expect(lastCall[1]).toBeUndefined();
  });
});

describe("ActionLogSection — pagination", () => {
  it("Next advances the cursor to nextCursor from the response", async () => {
    const user = userEvent.setup();
    useActionLogMock.mockReturnValue({
      data: { entries: [entry()], nextCursor: "cursor_abc" },
      isLoading: false,
      error: null,
    });
    render(<ActionLogSection />);

    await user.click(screen.getByRole("button", { name: "Next" }));

    const lastCall = useActionLogMock.mock.calls[useActionLogMock.mock.calls.length - 1];
    expect(lastCall[1]).toBe("cursor_abc");
  });

  it("Previous is disabled on the first page", () => {
    render(<ActionLogSection />);
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Next is disabled when there is no nextCursor", () => {
    render(<ActionLogSection />);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
