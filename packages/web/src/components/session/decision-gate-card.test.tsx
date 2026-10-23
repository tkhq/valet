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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderCard(g: DecisionGate = gate(), placement?: "thread" | "notification") {
  return render(
    <TooltipProvider>
      <DecisionGateCard sessionId="sess_1" gate={g} placement={placement} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  resolvePending = false;
  withdrawPending = false;
  meData = { id: "u1", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "member", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current", timezone: null, timezoneReportDone: false };
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

describe("DecisionGateCard — notification placement", () => {
  it.each(["approval", "credential_request"] as const)("aligns %s actions with the request content", (type) => {
    renderCard(gate({ type, body: "Review this request before you allow it." }), "notification");
    const header = screen.getByRole("heading").closest("header");
    const details = screen.getByRole("region", { name: "Request details" });
    const actions = screen.getByRole("button", { name: "Approve once" }).parentElement;
    expect(header?.classList.contains("px-4")).toBe(true);
    expect(details.classList.contains("px-4")).toBe(true);
    expect(actions?.classList.contains("px-4")).toBe(true);
    expect(actions?.classList.contains("justify-start")).toBe(true);
    expect(actions?.classList.contains("justify-end")).toBe(false);
  });

  it("keeps the default thread surface and right-aligned actions", () => {
    renderCard();
    const dialog = screen.getByRole("dialog");
    const actions = screen.getByRole("button", { name: "Approve once" }).parentElement;
    expect(dialog.classList.contains("border")).toBe(true);
    expect(dialog.parentElement?.classList.contains("sm:px-8")).toBe(true);
    expect(actions?.classList.contains("px-5")).toBe(true);
    expect(actions?.classList.contains("justify-end")).toBe(true);
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

  it("names no internal id for a source it does not know", () => {
    renderCard(gate({ provenance: { baseMode: "require_approval", source: "future_source" } }));
    expect(screen.getByTestId("gate-provenance").textContent).toBe("Gated by policy.");
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
    meData = { id: "u1", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "admin", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current", timezone: null, timezoneReportDone: false };
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
    meData = { id: "al", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "member", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current", timezone: null, timezoneReportDone: false };
    renderCard(borrow);
    expect(screen.getByText("Asked Bea for permission")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("describes an actor-only approval as a review request", () => {
    meData = { id: "al", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "member", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current", timezone: null, timezoneReportDone: false };
    renderCard({ ...borrow, title: "Approve Update account?" });
    expect(screen.getByText("Valet is waiting for Bea to review this request.")).toBeTruthy();
    expect(screen.queryByText(/shared account/)).toBeNull();
  });

  it("keeps the account context for shared-account approval requests", () => {
    meData = { id: "al", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "member", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current", timezone: null, timezoneReportDone: false };
    renderCard({ ...borrow, provenance: { baseMode: "allow", source: "shared_account" } });
    expect(screen.getByText(/This needs Bea's shared account/)).toBeTruthy();
  });

  // The raw source id showed as "Gated by policy (shared_account)." under a
  // title that already says whose account it is.
  it("shows no raw policy source on the account owner's card", () => {
    meData = { id: "bea", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "member", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current", timezone: null, timezoneReportDone: false };
    renderCard({ ...borrow, provenance: { baseMode: "allow", source: "shared_account" } });
    expect(screen.queryByTestId("gate-provenance")).toBeNull();
    expect(document.body.textContent).not.toContain("shared_account");
  });

  it("gives that member the buttons", () => {
    meData = { id: "bea", email: "a@b.com", name: "A", avatarUrl: null, role: "member", orgId: "org_1", orgRole: "member", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current", timezone: null, timezoneReportDone: false };
    renderCard(borrow);
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });
});


describe("question answer layout", () => {
  // The paperclip sat beside the field and pushed it out of line with the
  // title and the options. The field now spans the card, with Attach and
  // Submit on one row below it.
  it("puts Attach and Submit on one row below a full-width answer field", () => {
    renderCard(gate({ type: "question", actions: [{ id: "yes", label: "Yes" }] }));
    const field = screen.getByRole("textbox", { name: "Your answer" });
    const attach = screen.getByRole("button", { name: "Attach images" });
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(field.className).toContain("w-full");
    expect(attach.parentElement).toBe(submit.parentElement);
    expect(field.compareDocumentPosition(attach) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attach.parentElement?.contains(field)).toBe(false);
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
  function mockTitleLayout({ scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "H3" ? scrollHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "H3" ? clientHeight : 0;
    });
  }

  it("bounds only the named request-details region so actions remain reachable", () => {
    mockTitleLayout({ scrollHeight: 204, clientHeight: 68 });
    const body = "https://example.com/" + "a".repeat(10_000);
    const title = "A title ".repeat(100);
    const { container } = renderCard(gate({ body, title }));

    const card = container.querySelector('[role="dialog"]');
    const heading = screen.getByRole("heading");
    const request = screen.getByRole("region", { name: "Request details" });
    expect(card?.className).not.toContain("max-h-");
    expect(heading.className).toContain("line-clamp-3");
    expect(heading.className).toContain("[overflow-wrap:anywhere]");
    expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBe(heading.id);
    const titleControl = screen.getByRole("button", { name: "Show more" });
    const action = screen.getByRole("button", { name: "Approve for session" });
    expect(titleControl.getAttribute("aria-controls")).toBe(heading.id);
    expect(heading.closest("header")?.contains(titleControl)).toBe(true);
    expect(heading.closest("header")?.contains(action)).toBe(false);
    expect(request.id).toBe("gate-gate_1-body");
    expect(request.getAttribute("tabindex")).toBe("0");
    expect(request.className).toContain("max-h-[min(14rem,25dvh)]");
    expect(request.className).toContain("overflow-y-auto");
    expect(request.className).toContain("[overflow-wrap:anywhere]");
    expect(request.className).not.toContain("overscroll-y-contain");
    expect(request.getAttribute("aria-label")).toBe("Request details");
    expect(screen.getByRole("button", { name: "Approve for session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("does not add a title control when the title fits within one pixel", () => {
    mockTitleLayout({ scrollHeight: 69, clientHeight: 68 });
    renderCard(gate({ title: "Which workflow should run first?", type: "question" }));

    expect(screen.queryByRole("button", { name: /Show (more|less)/ })).toBeNull();
  });

  it("lets keyboard users expand and collapse a truncated 300-character question", async () => {
    mockTitleLayout({ scrollHeight: 205, clientHeight: 68 });
    const user = userEvent.setup();
    const title = "q".repeat(300);
    renderCard(gate({ type: "question", title, actions: [] }));

    const heading = screen.getByRole("heading", { name: title });
    const control = screen.getByRole("button", { name: "Show more" });
    expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
    expect(heading.className).toContain("line-clamp-3");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(control.getAttribute("aria-expanded")).toBe("false");
    await user.tab();
    expect(document.activeElement).toBe(control);
    await user.keyboard("{Enter}");
    expect(heading.className).not.toContain("line-clamp-3");
    expect(heading.className).toContain("max-h-[min(14rem,25dvh)]");
    expect(heading.className).toContain("overflow-y-auto");
    expect(heading.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Enter}");
    expect(heading.className).toContain("line-clamp-3");
  });

  it("resets a scrolled title before restoring its clamp", async () => {
    mockTitleLayout({ scrollHeight: 592, clientHeight: 68 });
    const user = userEvent.setup();
    renderCard(gate({ title: "a".repeat(1_000) }));

    const heading = screen.getByRole("heading");
    await user.click(screen.getByRole("button", { name: "Show more" }));
    heading.scrollTop = 392;
    expect(heading.scrollTop).toBe(392);

    await user.click(screen.getByRole("button", { name: "Show less" }));

    expect(heading.scrollTop).toBe(0);
    expect(heading.className).toContain("line-clamp-3");
  });

  it("offers full-title recovery for an unconstrained approval title", async () => {
    mockTitleLayout({ scrollHeight: 205, clientHeight: 68 });
    const user = userEvent.setup();
    const title = "Approve " + "a".repeat(10_000);
    renderCard(gate({ title, body: undefined }));

    const heading = screen.getByRole("heading", { name: title });
    expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    const titleControl = screen.getByRole("button", { name: "Show less" });
    const action = screen.getByRole("button", { name: "Approve for session" });
    expect(heading.className).not.toContain("line-clamp-3");
    expect(heading.className).toContain("max-h-[min(14rem,25dvh)]");
    expect(heading.className).toContain("overflow-y-auto");
    expect(heading.parentElement?.contains(titleControl)).toBe(true);
    expect(heading.closest("header")?.contains(action)).toBe(false);
  });

  it("keeps focus on Show less after a stale font measurement", async () => {
    let resolveFonts!: () => void;
    const fonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: new Promise<void>((resolve) => { resolveFonts = resolve; }) },
    });

    try {
      mockTitleLayout({ scrollHeight: 205, clientHeight: 68 });
      const user = userEvent.setup();
      renderCard(gate({ title: "a".repeat(300) }));
      await user.click(screen.getByRole("button", { name: "Show more" }));
      const control = screen.getByRole("button", { name: "Show less" });
      control.focus();
      mockTitleLayout({ scrollHeight: 68, clientHeight: 68 });

      await act(async () => {
        resolveFonts();
        await Promise.resolve();
      });

      expect(document.activeElement).toBe(control);
      expect(screen.getByRole("button", { name: "Show less" })).toBe(control);
    } finally {
      if (fonts) Object.defineProperty(document, "fonts", fonts);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("moves focus to the heading when resize removes the focused title control", async () => {
    let callback: ResizeObserverCallback | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(next: ResizeObserverCallback) { callback = next; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    mockTitleLayout({ scrollHeight: 205, clientHeight: 68 });
    renderCard(gate({ title: "a".repeat(300) }));
    const heading = screen.getByRole("heading");
    const control = screen.getByRole("button", { name: "Show more" });
    control.focus();
    expect(document.activeElement).toBe(control);
    mockTitleLayout({ scrollHeight: 68, clientHeight: 68 });
    const entry: ResizeObserverEntry = {
      target: heading,
      contentRect: new DOMRect(),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    };
    const observer: ResizeObserver = { observe() {}, unobserve() {}, disconnect() {} };
    act(() => callback?.([entry], observer));
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});

describe("DecisionGateCard — collapse", () => {
  const question = (id = "gate_q") => gate({ id, type: "question", title: "Which branch should I deploy?", actions: [{ id: "a", label: "main" }] });
  /** The expanded card's collapse button. */
  const TOGGLE = { name: "Collapse request" };
  /** The collapsed row is named by its visible badge and title. */
  const ROW = { name: /Which branch should I deploy\?/ };

  function renderDocked(g: DecisionGate) {
    return render(
      <TooltipProvider>
        <DecisionGateCard sessionId="sess_1" gate={g} collapsible />
      </TooltipProvider>,
    );
  }

  // jsdom has no layout. Give toggles and other controls distinct positions.
  async function clickAt(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
    const clientX = target.getAttribute("aria-label") === "Collapse request" ? 100 : 300;
    await user.pointer({ target, keys: "[MouseLeft]", coords: { clientX, clientY: 100 } });
  }

  beforeEach(() => sessionStorage.clear());

  it("collapses to a compact bar and expands again", async () => {
    const user = userEvent.setup();
    renderDocked(question());
    await clickAt(user, screen.getByRole("button", TOGGLE));
    expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull();
    const bar = screen.getByRole("button", ROW);
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(bar.getAttribute("aria-controls")!)).toBeTruthy();
    expect(bar.textContent).toContain("Question");
    expect(bar.querySelector("[title]")?.getAttribute("title")).toBe(question().title);
    expect(screen.getByText("Question")).toBeTruthy();
    await clickAt(user, bar);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeTruthy();
    const toggle = screen.getByRole("button", TOGGLE);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeTruthy();
  });

  it("moves focus to the counterpart button after each toggle", async () => {
    const user = userEvent.setup();
    renderDocked(question());
    await clickAt(user, screen.getByRole("button", TOGGLE));
    expect(document.activeElement).toBe(screen.getByRole("button", ROW));
    expect(screen.getByRole("button", ROW).getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("button", TOGGLE));
    expect(screen.getByRole("button", TOGGLE).getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the typed draft across collapse and expand without resolving", async () => {
    const user = userEvent.setup();
    renderDocked(question());
    await user.type(screen.getByRole("textbox", { name: "Your answer" }), "use staging");
    await clickAt(user, screen.getByRole("button", TOGGLE));
    await clickAt(user, screen.getByRole("button", ROW));
    expect((screen.getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement).value).toBe("use staging");
    expect(resolveMutateAsync).not.toHaveBeenCalled();
    expect(withdrawMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps attached images across collapse and expand", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("FileReader", class {
      result = "data:image/png;base64,AAAA";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    });
    renderDocked(question());
    const input = screen.getByLabelText("Attach images to answer") as HTMLInputElement;
    await user.upload(input, new File(["x"], "shot.png", { type: "image/png" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /remove/i }).length).toBeGreaterThan(0));
    const before = screen.getAllByRole("button", { name: /remove/i }).length;
    await clickAt(user, screen.getByRole("button", TOGGLE));
    await clickAt(user, screen.getByRole("button", ROW));
    expect(screen.getAllByRole("button", { name: /remove/i }).length).toBe(before);
    const remove = screen.getAllByRole("button", { name: /remove/i })[0]!;
    fireEvent.mouseDown(remove, { detail: 2 });
    fireEvent.click(remove, { detail: 2 });
    expect(screen.getAllByRole("button", { name: /remove/i }).length).toBe(before);
    fireEvent.click(remove, { detail: 1 });
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("restores the collapsed state from sessionStorage on remount", async () => {
    const user = userEvent.setup();
    const first = renderDocked(question("gate_r"));
    await clickAt(user, screen.getByRole("button", TOGGLE));
    first.unmount();
    renderDocked(question("gate_r"));
    expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull();
    expect(screen.getByRole("button", ROW).getAttribute("aria-expanded")).toBe("false");
  });

  it("starts a new gate expanded even if another gate was collapsed", async () => {
    const user = userEvent.setup();
    const first = renderDocked(question("gate_1"));
    await clickAt(user, screen.getByRole("button", TOGGLE));
    first.unmount();
    renderDocked(question("gate_2"));
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeTruthy();
  });

  it("caps persistence at the 50 most recently collapsed gates", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `old_${i}`);
    sessionStorage.setItem("valet:collapsed-gates", JSON.stringify(ids));
    const view = renderDocked(question("new_gate"));
    fireEvent.click(screen.getByRole("button", TOGGLE));
    expect(JSON.parse(sessionStorage.getItem("valet:collapsed-gates")!)).toEqual([...ids.slice(1), "new_gate"]);
    view.unmount();
    renderDocked(question("old_0"));
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeTruthy();
  });

  it("removes an expanded gate from persistence", () => {
    renderDocked(question());
    fireEvent.click(screen.getByRole("button", TOGGLE));
    fireEvent.click(screen.getByRole("button", ROW));
    expect(sessionStorage.getItem("valet:collapsed-gates")).toBe("[]");
  });

  it.each(["not json", "{}", '[null, 1]'])("ignores invalid persisted data: %s", (stored) => {
    sessionStorage.setItem("valet:collapsed-gates", stored);
    renderDocked(question());
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeTruthy();
  });

  it("syncs collapsible changes without losing the draft or stored preference", () => {
    const g = question();
    const view = render(<DecisionGateCard sessionId="sess_1" gate={g} collapsible />);
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "keep this" } });
    fireEvent.click(screen.getByRole("button", TOGGLE));
    view.rerender(<DecisionGateCard sessionId="sess_1" gate={g} collapsible={false} />);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveProperty("value", "keep this");
    expect(screen.queryByRole("button", TOGGLE)).toBeNull();
    view.rerender(<DecisionGateCard sessionId="sess_1" gate={g} collapsible />);
    expect(screen.getByRole("button", ROW)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", ROW));
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveProperty("value", "keep this");
  });

  it("disables the collapse button while busy", () => {
    resolvePending = true;
    renderDocked(question());
    expect(screen.getByRole("button", TOGGLE).hasAttribute("disabled")).toBe(true);
  });

  it("does not crash when sessionStorage throws", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    renderDocked(question());
    await clickAt(user, screen.getByRole("button", TOGGLE));
    expect(screen.getByRole("button", ROW).getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses approval gates", async () => {
    const user = userEvent.setup();
    renderDocked(gate());
    await clickAt(user, screen.getByRole("button", TOGGLE));
    expect(screen.getByText("Approval requested")).toBeTruthy();
    expect(screen.getByText("Send email to external address?")).toBeTruthy();
  });

  describe("repeat clicks and timing", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resolveMutateAsync.mockClear();
      withdrawMutateAsync.mockClear();
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    function expandApproval() {
      renderDocked(gate());
      fireEvent.click(screen.getByRole("button", TOGGLE), { detail: 1, clientX: 100, clientY: 100 });
      fireEvent.click(screen.getByRole("button", { name: /Send email to external address\?/ }), { detail: 1, clientX: 300, clientY: 100 });
    }
    const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

    it("honours a deliberate detail-1 tap immediately after expand", () => {
      expandApproval();
      fireEvent.click(screen.getByRole("button", { name: "Approve once" }), { detail: 1 });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(1);
    });

    it.each([300, 700])("handles a separate click at the old chevron after %ims", (elapsed) => {
      expandApproval();
      wait(elapsed);
      fireEvent.click(screen.getByRole("button", { name: "Deny" }), { detail: 1, clientX: 310, clientY: 110 });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(elapsed < 600 ? 0 : 1);
    });

    it("keeps a mousedown at 500ms swallowed through release at 650ms", () => {
      expandApproval();
      const deny = screen.getByRole("button", { name: "Deny" });
      const press = { detail: 1, clientX: 300, clientY: 100 };
      wait(500);
      fireEvent.mouseDown(deny, press);
      wait(150);
      fireEvent.mouseUp(deny, press);
      fireEvent.click(deny, press);
      fireEvent.doubleClick(deny, press);
      expect(resolveMutateAsync).not.toHaveBeenCalled();
      // A new press after the window is deliberate, even at the same point.
      fireEvent.mouseDown(deny, press);
      fireEvent.mouseUp(deny, press);
      fireEvent.click(deny, press);
      expect(resolveMutateAsync).toHaveBeenCalledTimes(1);
    });

    function pointerPress(target: HTMLElement, type: string, pointerType: string, clientX = 300) {
      // jsdom has no PointerEvent, so add pointerType to the shared mouse fields.
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 100 });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      return fireEvent(target, event);
    }

    it.each(["mouse", "touch"])("latches a %s pointer press at 450ms through release at 700ms", (pointerType) => {
      expandApproval();
      const deny = screen.getByRole("button", { name: "Deny" });
      const press = { detail: 1, clientX: 300, clientY: 100 };
      const hit = vi.fn();
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
        deny.addEventListener(type, hit);
      }
      wait(450);
      expect(pointerPress(deny, "pointerdown", pointerType)).toBe(true);
      // Touch compatibility mousedown arrives after pointerup, not pointerdown.
      if (pointerType === "mouse") fireEvent.mouseDown(deny, press);
      wait(250);
      expect(pointerPress(deny, "pointerup", pointerType)).toBe(true);
      if (pointerType === "touch") fireEvent.mouseDown(deny, press);
      fireEvent.mouseUp(deny, press);
      fireEvent.click(deny, press);
      fireEvent.doubleClick(deny, press);
      expect(hit).not.toHaveBeenCalled();
      expect(resolveMutateAsync).not.toHaveBeenCalled();
    });

    it.each(["mouse", "touch"])("uses the %s radius for a separate press with 30px drift", (pointerType) => {
      expandApproval();
      const deny = screen.getByRole("button", { name: "Deny" });
      const press = { detail: 1, clientX: 330, clientY: 100 };
      wait(150);
      pointerPress(deny, "pointerdown", pointerType, 330);
      pointerPress(deny, "pointerup", pointerType, 330);
      fireEvent.mouseDown(deny, press);
      fireEvent.mouseUp(deny, press);
      fireEvent.click(deny, press);
      expect(resolveMutateAsync).toHaveBeenCalledTimes(pointerType === "touch" ? 0 : 1);
    });

    it("allows Approve at a different point after 100ms", () => {
      expandApproval();
      wait(100);
      fireEvent.click(screen.getByRole("button", { name: "Approve once" }), { detail: 1, clientX: 200, clientY: 100 });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(1);
    });

    it.each(["positional", "repeat"])("stops the full %s press without cancelling pointer defaults", (mode) => {
      expandApproval();
      const target = screen.getByRole("button", { name: "Deny" });
      const hit = vi.fn();
      const types = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"];
      for (const type of types) target.addEventListener(type, hit);
      wait(mode === "repeat" ? 1000 : 300);
      for (const type of types) {
        // jsdom lacks PointerEvent. MouseEvent supplies the shared fields.
        const pointer = type.startsWith("pointer");
        const event = new MouseEvent(type, { bubbles: true, cancelable: true,
          detail: mode === "repeat" ? 2 : pointer ? 0 : 1, clientX: 300, clientY: 100 });
        expect(fireEvent(target, event)).toBe(pointer);
      }
      expect(hit).not.toHaveBeenCalled();
      expect(resolveMutateAsync).not.toHaveBeenCalled();
    });

    it("does not re-collapse on the second click over the chevron", () => {
      expandApproval();
      fireEvent.mouseDown(screen.getByRole("button", TOGGLE), { detail: 2 });
      fireEvent.click(screen.getByRole("button", TOGGLE), { detail: 2 });
      fireEvent.doubleClick(screen.getByRole("button", TOGGLE), { detail: 2 });
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole("button", TOGGLE));
    });

    it("swallows a repeat over Show more but permits a new tap", () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(68);
      expandApproval();
      const showMore = screen.getByRole("button", { name: "Show more" });
      fireEvent.mouseDown(showMore, { detail: 2 });
      fireEvent.click(showMore, { detail: 2 });
      expect(showMore.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(showMore, { detail: 1 });
      expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    });

    it("does not arm for keyboard expand", () => {
      renderDocked(gate());
      fireEvent.click(screen.getByRole("button", TOGGLE), { detail: 0 });
      fireEvent.click(screen.getByRole("button", { name: /Send email/ }), { detail: 0 });
      fireEvent.click(screen.getByRole("button", { name: "Deny" }), { detail: 2 });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(1);
    });

    it("removes the expand listeners on unmount", () => {
      expandApproval();
      cleanup();
      const hit = vi.fn();
      const target = document.createElement("button");
      target.addEventListener("click", hit);
      document.body.append(target);
      fireEvent.click(target, { detail: 2 });
      expect(hit).toHaveBeenCalledTimes(1);
      target.remove();
    });

    it("resolves a keyboard Deny right after a keyboard expand", () => {
      renderDocked(gate());
      fireEvent.click(screen.getByRole("button", TOGGLE), { detail: 0 });
      fireEvent.click(screen.getByRole("button", { name: /Send email to external address\?/ }), { detail: 0 });
      fireEvent.click(screen.getByRole("button", { name: "Deny" }), { detail: 0 });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(1);
    });

    it("resolves a keyboard Deny right after a pointer expand", () => {
      expandApproval();
      fireEvent.click(screen.getByRole("button", { name: "Deny" }), { detail: 0 });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(1);
    });

    it("submits with Cmd+Enter right after a pointer expand", () => {
      renderDocked(question());
      fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "kept draft" } });
      fireEvent.click(screen.getByRole("button", TOGGLE), { detail: 1, clientX: 100, clientY: 100 });
      fireEvent.click(screen.getByRole("button", ROW), { detail: 1, clientX: 300, clientY: 100 });
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Your answer" }), { key: "Enter", metaKey: true });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(1);
      expect(resolveMutateAsync.mock.calls[0]?.[0].body.value).toBe("kept draft");
    });

    it("swallows repeat Deny, Approve and Cancel clicks after one second", () => {
      expandApproval();
      wait(1000);
      fireEvent.click(screen.getByRole("button", { name: "Deny" }), { detail: 2 });
      fireEvent.click(screen.getByRole("button", { name: "Approve once" }), { detail: 3 });
      fireEvent.click(screen.getByRole("button", { name: "Cancel and dismiss" }), { detail: 2 });
      expect(resolveMutateAsync).not.toHaveBeenCalled();
      expect(withdrawMutateAsync).not.toHaveBeenCalled();
    });

    it("honours a new pointer gesture and a keyboard activation", () => {
      expandApproval();
      fireEvent.click(screen.getByRole("button", { name: "Deny" }), { detail: 1 });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Approve once" }), { detail: 0 });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(2);
    });

    it("guards Submit, option buttons and Attach images the same way", () => {
      const pick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
      renderDocked(question());
      fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "x" } });
      fireEvent.click(screen.getByRole("button", TOGGLE), { detail: 1, clientX: 100, clientY: 100 });
      fireEvent.click(screen.getByRole("button", ROW), { detail: 1, clientX: 300, clientY: 100 });
      wait(1000);
      fireEvent.click(screen.getByRole("button", { name: "Attach images" }), { detail: 2 });
      fireEvent.click(screen.getByRole("button", { name: "Submit" }), { detail: 2 });
      fireEvent.click(screen.getByRole("button", { name: "main" }), { detail: 2 });
      expect(pick).not.toHaveBeenCalled();
      expect(resolveMutateAsync).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Attach images" }), { detail: 1 });
      expect(pick).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Your answer" }), { key: "Enter", ctrlKey: true });
      expect(resolveMutateAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe("with an error showing", () => {
    const FAILED = /Failed/;

    it("allows collapse, shows the failed state in the row's name, and expands to the alert", async () => {
      const user = userEvent.setup();
      resolveMutateAsync.mockRejectedValueOnce(new Error("Connection lost"));
      renderDocked(gate());
      await clickAt(user, screen.getByRole("button", { name: "Deny" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Connection lost");
      await clickAt(user, screen.getByRole("button", TOGGLE));
      const row = screen.getByTestId("gate-collapsed");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(row.textContent).toMatch(FAILED);
      expect(row.querySelector(".bg-danger-500")).toBeTruthy();
      expect(row.querySelector(".animate-pulse")).toBeNull();
      const button = screen.getByRole("button", { name: FAILED });
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.textContent).toContain("Send email to external address?");
      await clickAt(user, button);
      expect((await screen.findByRole("alert")).textContent).toContain("Connection lost");
    });

    it("shows no failed text on a collapsed row without an error", async () => {
      const user = userEvent.setup();
      renderDocked(gate());
      await clickAt(user, screen.getByRole("button", TOGGLE));
      expect(screen.getByTestId("gate-collapsed").textContent).not.toMatch(FAILED);
    });

    it("keeps collapse available after a failing retry", async () => {
      const user = userEvent.setup();
      resolveMutateAsync.mockRejectedValueOnce(new Error("first")).mockRejectedValueOnce(new Error("second"));
      renderDocked(gate());
      await clickAt(user, screen.getByRole("button", { name: "Deny" }));
      await screen.findByText(/first/);
      await clickAt(user, screen.getByRole("button", { name: "Approve once" }));
      await screen.findByText(/second/);
      const toggle = screen.getByRole("button", TOGGLE) as HTMLButtonElement;
      expect(toggle.disabled).toBe(false);
      await clickAt(user, toggle);
      expect(screen.getByRole("button", { name: FAILED })).toBeTruthy();
    });

    it("keeps collapse available after a rejected image", async () => {
      const user = userEvent.setup({ applyAccept: false });
      renderDocked(question());
      await user.upload(screen.getByLabelText("Attach images to answer"), new File(["x"], "notes.txt", { type: "text/plain" }));
      expect((await screen.findByRole("alert")).textContent).toContain("notes.txt is not a supported image");
      const toggle = screen.getByRole("button", TOGGLE) as HTMLButtonElement;
      expect(toggle.disabled).toBe(false);
      await clickAt(user, toggle);
      expect(screen.getByRole("button", { name: /Attachment rejected/ })).toBeTruthy();
    });

    it("switches from the attachment wording to Failed once an action then fails", async () => {
      const user = userEvent.setup({ applyAccept: false });
      resolveMutateAsync.mockRejectedValueOnce(new Error("Connection lost"));
      renderDocked(question());
      await user.upload(screen.getByLabelText("Attach images to answer"), new File(["x"], "notes.txt", { type: "text/plain" }));
      await screen.findByText(/notes.txt is not a supported image/);
      await clickAt(user, screen.getByRole("button", { name: "main" }));
      await screen.findByText(/Connection lost/);
      await clickAt(user, screen.getByRole("button", TOGGLE));
      expect(screen.getByRole("button", { name: FAILED })).toBeTruthy();
      expect(screen.getByTestId("gate-collapsed").textContent).not.toMatch(/Attachment rejected/);
    });

    it("says an attachment was rejected, not that there is something to retry", async () => {
      const user = userEvent.setup({ applyAccept: false });
      renderDocked(question());
      await user.upload(screen.getByLabelText("Attach images to answer"), new File(["x"], "notes.txt", { type: "text/plain" }));
      await screen.findByRole("alert");
      await clickAt(user, screen.getByRole("button", TOGGLE));
      const row = screen.getByTestId("gate-collapsed");
      expect(row.querySelector(".bg-danger-500")).toBeTruthy();
      expect(row.textContent).not.toMatch(FAILED);
      expect(screen.getByRole("button", { name: /Attachment rejected/ })).toBeTruthy();
    });
  });

  describe("stray click after collapsing", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => { cleanup(); vi.useRealTimers(); });

    /** A page element under the pointer after the layout shift. */
    function addTarget() {
      const hit = vi.fn();
      const target = document.createElement("button");
      target.addEventListener("click", hit);
      document.body.append(target);
      return { hit, target };
    }
    const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
    const collapseByPointer = () => fireEvent.click(screen.getByRole("button", TOGGLE), { detail: 1, clientX: 100, clientY: 100 });

    it.each(["button", "a"])("swallows double- and triple-click repeats over a transcript %s", (tag) => {
      const hit = vi.fn();
      const target = document.createElement(tag);
      target.addEventListener("click", hit);
      document.body.append(target);
      renderDocked(gate());
      collapseByPointer();
      fireEvent.click(target, { detail: 2 });
      fireEvent.click(target, { detail: 3 });
      expect(hit).not.toHaveBeenCalled();
      target.remove();
    });

    it("lets keyboard (detail 0) and single (detail 1) clicks through immediately", () => {
      const { hit, target } = addTarget();
      renderDocked(gate());
      collapseByPointer();
      wait(100);
      fireEvent.click(target, { detail: 0 });
      expect(hit).toHaveBeenCalledTimes(1);
      cleanup();
      renderDocked(gate({ id: "gate_2" }));
      collapseByPointer();
      fireEvent.click(target, { detail: 1 });
      expect(hit).toHaveBeenCalledTimes(2);
      target.remove();
    });

    it("stops swallowing once a single click starts a new gesture", () => {
      const { hit, target } = addTarget();
      renderDocked(gate());
      collapseByPointer();
      fireEvent.click(target, { detail: 1 });
      fireEvent.click(target, { detail: 2 });
      expect(hit).toHaveBeenCalledTimes(2);
      target.remove();
    });

    it("cancels a repeat mousedown, so focus stays on the expand row, and swallows dblclick", () => {
      const { hit, target } = addTarget();
      renderDocked(gate());
      collapseByPointer();
      const row = screen.getByRole("button", { name: /Send email to external address\?/ });
      expect(document.activeElement).toBe(row);
      expect(fireEvent.mouseDown(target, { detail: 2 })).toBe(false);
      const dbl = vi.fn();
      target.addEventListener("dblclick", dbl);
      fireEvent.doubleClick(target, { detail: 2 });
      expect(dbl).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(row);
      // A first mousedown (detail 1) is a new gesture: it passes and disarms.
      expect(fireEvent.mouseDown(target, { detail: 1 })).toBe(true);
      fireEvent.click(target, { detail: 2 });
      expect(hit).toHaveBeenCalledTimes(1);
      target.remove();
    });

    it("swallows slow repeats without a timer", () => {
      const { hit, target } = addTarget();
      renderDocked(gate());
      collapseByPointer();
      wait(1000);
      fireEvent.click(target, { detail: 2 });
      wait(1000);
      fireEvent.click(target, { detail: 3 });
      expect(hit).not.toHaveBeenCalled();
      target.remove();
    });

    it("does not arm for a keyboard collapse (detail 0)", () => {
      const { hit, target } = addTarget();
      renderDocked(gate());
      fireEvent.click(screen.getByRole("button", TOGGLE), { detail: 0 });
      fireEvent.click(target, { detail: 2 });
      expect(hit).toHaveBeenCalledTimes(1);
      target.remove();
    });

    it("removes the listener on unmount", () => {
      const { hit, target } = addTarget();
      const view = renderDocked(gate());
      collapseByPointer();
      view.unmount();
      fireEvent.click(target, { detail: 2 });
      expect(hit).toHaveBeenCalledTimes(1);
      target.remove();
    });
  });

  it("has no collapse toggle in the default placement or the notification popover", () => {
    renderCard(gate());
    expect(screen.queryByRole("button", TOGGLE)).toBeNull();
    cleanup();
    renderCard(gate(), "notification");
    expect(screen.queryByRole("button", TOGGLE)).toBeNull();
  });
});
