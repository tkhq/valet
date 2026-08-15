// @vitest-environment jsdom
/**
 * PolicyGateCard tests (plan decision 19 — policy gate approval with scopes).
 * The component is tested with mocked hooks so no real HTTP fires.
 * vi.mock is hoisted, so all factory functions must be synchronous.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowPendingGate } from "@valet/api/wire";
import { PolicyGateCard } from "./policy-gate-card";

// ── shared mock state ───────────────────────────────────────────────────────

const mutate = vi.fn();
let mockOrgRole: string | undefined = "member";
let mockIsError = false;
let mockError: { message: string } | null = null;

vi.mock("~/api/workflows", () => ({
  useResolveApproval: () => ({
    mutate,
    isPending: false,
    isError: mockIsError,
    error: mockError,
  }),
  qkWorkflows: { run: (id: string) => ["workflows", "runs", id] },
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: mockOrgRole != null ? { orgRole: mockOrgRole } : undefined }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

// ── helpers ──────────────────────────────────────────────────────────────────

function makeGate(overrides: Partial<WorkflowPendingGate> = {}): WorkflowPendingGate {
  return {
    nodeId: "node_1",
    kind: "policy_gate",
    service: "linear",
    action: "save_issue",
    riskLevel: "high",
    provenance: "plugin_default",
    onDeny: "fail",
    ...overrides,
  };
}

describe("PolicyGateCard", () => {
  beforeEach(() => {
    mutate.mockClear();
    mockOrgRole = "member";
    mockIsError = false;
    mockError = null;
  });

  // ── Case 1: structure ──────────────────────────────────────────────────────

  it("renders service.action in mono, risk badge, and params details section", () => {
    const gate = makeGate({ gateParams: { title: "Fix bug" }, gateParamsTruncated: false });
    render(<PolicyGateCard runId="wfrun_1" gate={gate} />);

    expect(screen.getByText("linear.save_issue")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText(/Parameters/i)).toBeTruthy();
  });

  it("shows truncation notice when gateParamsTruncated is true", () => {
    const gate = makeGate({ gateParams: { x: 1 }, gateParamsTruncated: true });
    render(<PolicyGateCard runId="wfrun_1" gate={gate} />);
    expect(screen.getByText(/truncated/i)).toBeTruthy();
  });

  // ── Case 2: Approve once ───────────────────────────────────────────────────

  it("Approve once fires with scope=once and the gate iteration", () => {
    const gate = makeGate({ iteration: 3 });
    render(<PolicyGateCard runId="wfrun_1" gate={gate} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));

    expect(mutate).toHaveBeenCalledWith({
      nodeId: "node_1",
      body: { approved: true, scope: "once", note: undefined, iteration: 3 },
    });
  });

  // ── Case 3: Approve for rest of run ───────────────────────────────────────

  it("Approve for rest of run fires with scope=run and sublabel names the action", async () => {
    const user = userEvent.setup();
    const gate = makeGate();
    render(<PolicyGateCard runId="wfrun_1" gate={gate} />);

    // Open the dropdown first
    await user.click(screen.getByRole("button", { name: "More approval options" }));

    expect(
      screen.getByText(/Covers every later call to linear\.save_issue in this run/i),
    ).toBeTruthy();

    await user.click(screen.getByRole("menuitem", { name: /Approve for rest of run/i }));

    expect(mutate).toHaveBeenCalledWith({
      nodeId: "node_1",
      body: { approved: true, scope: "run", note: undefined, iteration: undefined },
    });
  });

  // ── Case 4: Always allow — non-admin ──────────────────────────────────────

  it("non-admin: Always allow item is disabled with org-admin-only suffix", async () => {
    const user = userEvent.setup();
    mockOrgRole = "member";
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate()} />);

    // Open the dropdown
    await user.click(screen.getByRole("button", { name: "More approval options" }));

    // The item text includes the "(org admin only)" suffix and is disabled
    const item = screen.getByText(/org admin only/i);
    expect(item).toBeTruthy();

    // The menu item must be aria-disabled or have data-disabled
    const menuItem = screen.getByRole("menuitem", { name: /Always allow/i });
    const isDisabled =
      menuItem.getAttribute("aria-disabled") === "true" ||
      menuItem.dataset["disabled"] === "true" ||
      menuItem.hasAttribute("disabled");
    expect(isDisabled).toBe(true);
  });

  // ── Case 4 cont: Always allow — admin ─────────────────────────────────────

  it("admin: Always allow is enabled; confirm step shows blast radius and policies link", async () => {
    const user = userEvent.setup();
    mockOrgRole = "admin";
    const gate = makeGate();
    render(<PolicyGateCard runId="wfrun_1" gate={gate} />);

    // Open the dropdown
    await user.click(screen.getByRole("button", { name: "More approval options" }));

    const menuItem = screen.getByRole("menuitem", { name: /Always allow/i });
    // admin sees enabled item (no disabled attribute)
    expect(
      menuItem.getAttribute("aria-disabled") === "true" ||
      menuItem.dataset["disabled"] === "true",
    ).toBe(false);

    // Click to open confirm step
    await user.click(menuItem);

    // Blast radius copy
    expect(
      screen.getByText(/Allows linear\.save_issue for every user and run in this org/i),
    ).toBeTruthy();

    // Link to /settings/organization policies
    const link = screen.getByRole("link", { name: /policies/i });
    expect(link.getAttribute("href")).toContain("/settings/organization");

    // Confirm fires scope=always
    await user.click(screen.getByRole("button", { name: /Confirm/i }));

    expect(mutate).toHaveBeenCalledWith({
      nodeId: "node_1",
      body: { approved: true, scope: "always", note: undefined, iteration: undefined },
    });
  });

  // ── Case 5: Deny microcopy ────────────────────────────────────────────────

  it("Deny button shows fail microcopy when onDeny=fail", () => {
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate({ onDeny: "fail" })} />);
    expect(screen.getByText(/Denying fails this node/i)).toBeTruthy();
  });

  it("Deny button shows skip microcopy when onDeny=skip", () => {
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate({ onDeny: "skip" })} />);
    expect(screen.getByText(/Denying skips this node/i)).toBeTruthy();
  });

  it("Deny fires approved:false", () => {
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate()} />);
    fireEvent.click(screen.getByRole("button", { name: /Deny/i }));
    expect(mutate).toHaveBeenCalledWith({
      nodeId: "node_1",
      body: { approved: false, scope: "once", note: undefined, iteration: undefined },
    });
  });

  // ── Case 6: mutation errors ───────────────────────────────────────────────

  it("shows already-resolved message on 409-matching error", () => {
    mockIsError = true;
    mockError = { message: "This gate was already resolved. Refresh the run page." };
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate()} />);
    expect(screen.getByText(/This gate was already resolved\. Refreshing/i)).toBeTruthy();
  });

  it("shows server error verbatim on generic errors", () => {
    mockIsError = true;
    mockError = { message: "Something unexpected went wrong." };
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate()} />);
    expect(screen.getByText("Something unexpected went wrong.")).toBeTruthy();
  });

  // ── Case 7: resolver_error provenance ─────────────────────────────────────

  it("shows resolver_error banner when provenance is resolver_error", () => {
    render(
      <PolicyGateCard runId="wfrun_1" gate={makeGate({ provenance: "resolver_error" })} />,
    );
    expect(
      screen.getByText(/Policy check failed — approval requested as a safe fallback/i),
    ).toBeTruthy();
  });

  // ── Case 8: timeoutAt + iteration ─────────────────────────────────────────

  it("shows timeout text in footer when timeoutAt is set", () => {
    render(
      <PolicyGateCard runId="wfrun_1" gate={makeGate({ timeoutAt: Date.now() + 60_000 })} />,
    );
    expect(screen.getByText(/times out/i)).toBeTruthy();
  });

  it("shows iteration label when gate.iteration is set", () => {
    render(<PolicyGateCard runId="wfrun_1" gate={makeGate({ iteration: 4 })} />);
    expect(screen.getByText(/Iteration 4/i)).toBeTruthy();
  });
});
