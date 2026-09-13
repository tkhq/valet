// @vitest-environment jsdom
/**
 * `DecisionGateCard` — always_allow admin gate (action-policies plan,
 * Task 5). The resolver offers up to 4 actions on a `require_approval`
 * gate (approve_session, approve_once, always_allow, deny — exact set
 * decided server-side); this only asserts the `always_allow` action is
 * disabled + tooltipped for a non-admin (matching the API's
 * `routes/messages.ts` 403) and enabled for an admin, and that all of the
 * gate's actions render regardless. `useMe` comes from `~/api/settings`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DecisionGate, MeResponse } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

const resolveMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const withdrawMutateAsync = vi.fn().mockResolvedValue({ ok: true });

let meData: MeResponse | undefined;

vi.mock("~/api/queries", () => ({
  useResolveDecision: () => ({ mutateAsync: resolveMutateAsync, isPending: false, variables: undefined }),
  useWithdrawDecision: () => ({ mutateAsync: withdrawMutateAsync, isPending: false }),
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: meData, isLoading: false, error: null }),
}));

import { DecisionGateCard } from "./decision-gate-card";

function gate(overrides: Partial<DecisionGate> = {}): DecisionGate {
  return {
    id: "gate_1",
    sessionId: "sess_1",
    threadId: "thread_1",
    type: "approval",
    title: "Send email to external address?",
    actions: [
      { id: "approve_session", label: "Approve for session", approves: true },
      { id: "approve_once", label: "Approve once", approves: true },
      { id: "always_allow", label: "Always allow", approves: true },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    status: "pending",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderCard(g: DecisionGate = gate()) {
  return render(
    <TooltipProvider>
      <DecisionGateCard sessionId="sess_1" gate={g} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  meData = { id: "u1", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "member", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current" };
});

describe("DecisionGateCard — action rendering", () => {
  it("renders all 4 offered actions", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Approve for session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });
});

describe("DecisionGateCard — reviewable tool requests", () => {
  it("bounds long parameters and keeps decisions outside the payload", () => {
    const longUrl = `https://example.test/${"path".repeat(300)}`;
    renderCard(gate({
      approval: {
        toolId: "github.create_issue",
        service: "github",
        riskLevel: "high",
        summary: "Create an issue in the external repository.",
        argsPreview: JSON.stringify({ callbackUrl: longUrl, source: "x".repeat(2000) }),
        reviewIncomplete: true,
      },
    }));

    expect(screen.getByText("Create an issue in the external repository.")).toBeTruthy();
    expect(screen.getByText("github.create_issue")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    const details = screen.getByTestId("approval-details");
    expect(details.querySelector("pre")?.className).toContain("max-h-52");
    expect(details.querySelector("pre")?.className).toContain("break-all");
    expect(screen.getByText(/complete parameters are not available/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve once" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("blocks approval when the typed review has no tool identity", () => {
    renderCard(gate({
      approval: { argsPreview: "{\"amount\":10}", reviewIncomplete: true },
      actions: [
        { id: "approve", label: "Approve", style: "primary", approves: true },
        { id: "deny", label: "Reject", style: "danger", approves: false },
      ],
    }));
    expect(screen.getByText(/tool identity is unavailable/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks legacy built-in approve but keeps a legacy rejection action enabled", () => {
    renderCard(gate({
      approval: { toolId: "payments.send", argsPreview: "", reviewIncomplete: true },
      actions: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    }));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the authoritative body for incomplete typed metadata", () => {
    renderCard(gate({
      body: "tool_id=payments.send\nargs=[legacy]",
      approval: { toolId: "payments.send", argsPreview: "", reviewIncomplete: true },
    }));
    expect(screen.getByText(/tool_id=payments\.send/).textContent).toContain("args=[legacy]");
  });

  it("blocks approval when a legacy preview is blank", () => {
    renderCard(gate({
      approval: { toolId: "payments.send", argsPreview: "" },
      actions: [
        { id: "approve", label: "Approve", approves: true },
        { id: "deny", label: "Reject" },
      ],
    }));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks approval when a preview can hide material later fields", () => {
    renderCard(gate({
      approval: {
        toolId: "payments.send",
        argsPreview: `{"note":"${"x".repeat(16_000)}","recipient":"outside@example.test","amount":1000}`,
        reviewIncomplete: true,
      },
      actions: [
        { id: "approve", label: "Approve", style: "primary", approves: true },
        { id: "deny", label: "Reject", style: "danger", approves: false },
      ],
    }));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/reject this request and ask the agent to retry/i)).toBeTruthy();
  });

  it("uses the authoritative approves flag instead of action labels or styles", () => {
    renderCard(gate({
      approval: { toolId: "tool", argsPreview: "{}", reviewIncomplete: true },
      actions: [
        { id: "dangerous_grant", label: "Reject", style: "danger", approves: true },
        { id: "safe_stop", label: "Approve", style: "primary", approves: false },
      ],
    }));
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("caps an oversized preview from an older server before it mounts", () => {
    renderCard(gate({ approval: { toolId: "github.create_issue", argsPreview: "x".repeat(20_000) } }));
    expect(new TextEncoder().encode(screen.getByLabelText("Approval request parameters").textContent).length).toBeLessThanOrEqual(16_000);
    expect(screen.getByText(/complete parameters are not available/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve once" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the authoritative body when typed approval details are unavailable", () => {
    renderCard(gate({ body: "tool_id=github.create_issue\nargs=[malformed]" }));
    expect(screen.getByText(/tool_id=github\.create_issue/).textContent).toContain("args=[malformed]");
    expect(screen.queryByTestId("approval-details")).toBeNull();
  });
});

describe("DecisionGateCard — bounded card layout", () => {
  it("bounds the card, title, and action footer on a small viewport", () => {
    renderCard(gate({
      title: "x".repeat(500),
      actions: [{ id: "approve", label: `Approve ${"x".repeat(500)}` }],
    }));
    expect(screen.getByLabelText("Cancel and dismiss approval").closest("section")?.className).toContain("max-h-[calc(100dvh-1.5rem)]");
    expect(screen.getByRole("heading").className).toContain("max-h-12");
    expect(screen.getByRole("button", { name: /Approve/ }).querySelector("span")?.className).toContain("break-all");
    expect(screen.getByRole("button", { name: /Approve/ }).parentElement?.className).toContain("max-h-[35dvh]");
  });

  it("bounds the question footer when the visual viewport is short", () => {
    renderCard(gate({ type: "question" }));
    const answer = screen.getByPlaceholderText("Your answer…");
    expect(answer.parentElement?.className).toContain("max-h-[35dvh]");
    expect(answer.parentElement?.className).toContain("overflow-y-auto");
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });
});

describe("DecisionGateCard — dismissal labels", () => {
  it.each([
    ["approval", "Cancel and dismiss approval"],
    ["question", "Cancel and dismiss question"],
    ["credential_request", "Cancel and dismiss credential request"],
  ] as const)("uses a specific close label for %s", (type, label) => {
    renderCard(gate({ type }));
    expect(screen.getByLabelText(label)).toBeTruthy();
  });
});

describe("DecisionGateCard — policy provenance", () => {
  it("renders the why-gated line when the gate carries provenance", () => {
    renderCard(gate({ provenance: { baseMode: "require_approval", source: "org_policy", matchedPolicyId: "apol_1" } }));
    expect(screen.getByTestId("gate-provenance").textContent).toBe("Gated by an org policy.");
  });

  it("renders the personal-override line for source 'override' (the engine's actual value)", () => {
    renderCard(gate({ provenance: { baseMode: "require_approval", source: "override", matchedOverrideId: "apo_1" } }));
    expect(screen.getByTestId("gate-provenance").textContent).toBe("Gated by your personal policy override.");
  });

  it("renders nothing extra when provenance is absent", () => {
    renderCard();
    expect(screen.queryByTestId("gate-provenance")).toBeNull();
  });
});

describe("DecisionGateCard — always_allow admin gate", () => {
  it("disables Always allow for a non-admin (orgRole: member)", () => {
    renderCard();
    const btn = screen.getByRole("button", { name: "Always allow" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("does not submit when a disabled Always allow is clicked", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "Always allow" }));
    expect(resolveMutateAsync).not.toHaveBeenCalled();
  });

  it("enables Always allow for an org admin and submits actionId on click", async () => {
    meData = { id: "u1", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "admin", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current" };
    const user = userEvent.setup();
    renderCard();

    const btn = screen.getByRole("button", { name: "Always allow" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    await user.click(btn);
    expect(resolveMutateAsync).toHaveBeenCalledWith({
      gateId: "gate_1",
      body: { actionId: "always_allow" },
    });
  });

  it("leaves the other 3 actions enabled for a non-admin", () => {
    renderCard();
    expect((screen.getByRole("button", { name: "Approve for session" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole("button", { name: "Approve once" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
