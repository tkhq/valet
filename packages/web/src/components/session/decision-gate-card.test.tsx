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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DecisionGate, MeResponse } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

const resolveMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const withdrawMutateAsync = vi.fn().mockResolvedValue({ ok: true });

let meData: MeResponse | undefined;
let resolvePending = false;
let withdrawPending = false;

vi.mock("~/api/queries", () => ({
  useResolveDecision: () => ({ mutateAsync: resolveMutateAsync, isPending: resolvePending, variables: { gateId: "gate_1", body: { actionId: "approve_once" } } }),
  useWithdrawDecision: () => ({ mutateAsync: withdrawMutateAsync, isPending: withdrawPending }),
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
      { id: "approve_session", label: "Approve for session" },
      { id: "approve_once", label: "Approve once" },
      { id: "always_allow", label: "Always allow" },
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
  resolvePending = false;
  withdrawPending = false;
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

  it("offers a question's options as buttons beside the typed answer", async () => {
    const user = userEvent.setup();
    resolveMutateAsync.mockClear();
    renderCard(gate({ type: "question", title: "Which workflow first?", actions: [{ id: "option-0", label: "Linear sync" }, { id: "option-1", label: "PR review" }] }));
    expect(screen.getByPlaceholderText("Or type a different answer…")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "PR review" }));
    expect(resolveMutateAsync).toHaveBeenCalledWith({ gateId: "gate_1", body: { actionId: "option-1" } });
  });
});

describe("DecisionGateCard — another member's shared account", () => {
  const borrow = gate({ title: "Let a teammate use your linear account?", actions: [{ id: "approve", label: "Allow" }, { id: "deny", label: "Deny" }], approver: { userId: "bea", name: "Bea" } });

  it("tells everyone else the request went to that member, with no buttons", () => {
    meData = { id: "al", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "member", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current" };
    renderCard(borrow);
    expect(screen.getByText("Asked Bea for permission")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("gives that member the buttons", () => {
    meData = { id: "bea", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "member", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current" };
    renderCard(borrow);
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });
});


describe("question keyboard confirmation", () => {
  it.each(["metaKey", "ctrlKey"])("submits a typed answer with %s + Enter", async (modifier) => {
    renderCard(gate({ type: "question", actions: [] }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "  Start with Linear  " } });
    fireEvent.keyDown(input, { key: "Enter", [modifier]: true });
    expect(resolveMutateAsync).toHaveBeenCalledWith({ gateId: "gate_1", body: { value: "Start with Linear" } });
  });

  it("keeps plain Enter, composition, and empty answers from submitting", () => {
    renderCard(gate({ type: "question", actions: [] }));
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.change(input, { target: { value: "answer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, repeat: true });
    expect(resolveMutateAsync).not.toHaveBeenCalled();
  });
});


describe("DecisionGateCard — recovery", () => {
  it.each(["Approve once", "Cancel and dismiss"])("shows failure for %s", async (label) => {
    const mutation = label === "Approve once" ? resolveMutateAsync : withdrawMutateAsync;
    mutation.mockRejectedValueOnce(new Error("Connection lost"));
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect((await screen.findByRole("alert")).textContent).toContain("Connection lost");
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves a typed answer when submission fails", async () => {
    resolveMutateAsync.mockRejectedValueOnce(new Error("Connection lost"));
    renderCard(gate({ type: "question", actions: [] }));
    await userEvent.type(screen.getByRole("textbox"), "Keep the linked-account requirement");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Connection lost");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep the linked-account requirement");
  });
});


describe("DecisionGateCard — response feedback", () => {
  it.each(["resolve", "withdraw"])("announces %s progress and disables every action", (operation) => {
    resolvePending = operation === "resolve";
    withdrawPending = operation === "withdraw";
    renderCard();
    expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe(
      operation === "resolve" ? "Sending response…" : "Dismissing request…",
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });

  it("keeps the full reason visible and describes the dialog with it", () => {
    const body = "Send the customer report to the external address. This includes customer contact details.";
    renderCard(gate({ body }));
    const reason = screen.getByText(body);
    expect(screen.getByRole("dialog").getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("submits the denial action unchanged", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(resolveMutateAsync).toHaveBeenCalledWith({ gateId: "gate_1", body: { actionId: "deny" } });
  });
});


describe("question image answers", () => {
  it("keeps an image after a failed submit and sends an image-only answer on retry", async () => {
    const user = userEvent.setup();
    renderCard(gate({ type: "question", actions: [] }));
    await user.upload(screen.getByLabelText("Attach images to answer"), new File(["photo"], "avatar.png", { type: "image/png" }));
    await screen.findByAltText("avatar.png");
    resolveMutateAsync.mockRejectedValueOnce(new Error("Connection lost"));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByRole("alert");
    expect(screen.getByAltText("avatar.png")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(resolveMutateAsync).toHaveBeenLastCalledWith({ gateId: "gate_1", body: { value: "", attachments: [{ kind: "image", name: "avatar.png", mimeType: "image/png", url: "data:image/png;base64,cGhvdG8=" }] } });
    await waitFor(() => expect(screen.queryByAltText("avatar.png")).toBeNull());
  });

  it("pastes an image, supports removal, and clears attachments when the question changes", async () => {
    const view = renderCard(gate({ type: "question", actions: [] }));
    const file = new File(["photo"], "pasted.png", { type: "image/png" });
    const paste = () => fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ kind: "file", getAsFile: () => file }] } });
    paste();
    await screen.findByAltText("pasted.png");
    fireEvent.click(screen.getByRole("button", { name: "Remove pasted.png" }));
    expect(screen.queryByAltText("pasted.png")).toBeNull();
    paste();
    await screen.findByAltText("pasted.png");
    view.rerender(<TooltipProvider><DecisionGateCard sessionId="sess_1" gate={gate({ id: "next", type: "question", actions: [] })} /></TooltipProvider>);
    expect(screen.queryByAltText("pasted.png")).toBeNull();
  });
});

describe("DecisionGateCard — long request layout", () => {
  it("bounds only the named request-details region so actions remain reachable", () => {
    const body = "https://example.com/" + "a".repeat(10_000);
    const { container } = renderCard(gate({ body, title: "A title ".repeat(100) }));

    const card = container.querySelector('[role="dialog"]');
    const title = screen.getByRole("heading", { name: "A title ".repeat(100) });
    const request = screen.getByRole("region", { name: "Request details" });
    expect(card?.className).not.toContain("max-h-");
    expect(title.className).toContain("line-clamp-3");
    expect(title.className).toContain("[overflow-wrap:anywhere]");
    expect(title.getAttribute("title")).toBe("A title ".repeat(100));
    expect(request.id).toBe("gate-gate_1-body");
    expect(request.getAttribute("tabindex")).toBe("0");
    expect(request.className).toContain("max-h-[min(14rem,25dvh)]");
    expect(request.className).toContain("overflow-y-auto");
    expect(request.className).toContain("[overflow-wrap:anywhere]");
    expect(request.className).not.toContain("overscroll-y-contain");
    expect(request.getAttribute("aria-label")).toBe("Request details");
    expect(screen.getByRole("button", { name: "Approve for session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("clamps a long title and preserves it in a native tooltip", () => {
    const title = "https://example.com/" + "a".repeat(300);
    renderCard(gate({ title }));

    const heading = screen.getByRole("heading", { name: title });
    expect(heading.className).toContain("line-clamp-3");
    expect(heading.className).toContain("[overflow-wrap:anywhere]");
    expect(heading.getAttribute("title")).toBe(title);
    expect(screen.getByRole("button", { name: "Approve for session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });
});
