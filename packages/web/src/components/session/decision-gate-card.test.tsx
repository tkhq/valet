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
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("bounds request details and makes the whole card scrollable on short phones", () => {
    mockTitleLayout({ scrollHeight: 204, clientHeight: 68 });
    const body = "https://example.com/" + "a".repeat(10_000);
    const title = "A title ".repeat(100);
    const { container } = renderCard(gate({ body, title }));

    const card = container.querySelector('[role="dialog"]');
    const heading = screen.getByRole("heading");
    const request = screen.getByRole("region", { name: "Request details" });
    expect(card?.className).toContain("max-md:max-h-");
    expect(card?.className).toContain("max-md:overflow-y-auto");
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

describe("DecisionGateCard — tool payload preview", () => {
  const args = { channel: "#eng-releases", text: "Release 1.2 is out." };
  const call = `tool_id=slack.send_message\nargs=${JSON.stringify(args, null, 2)}`;
  const body = `Post the release notes\n\n${call}`;

  it("shows the summary and the preview, with the raw call behind Details", () => {
    renderCard(gate({ body, tool: { id: "slack.send_message", args } }));
    const request = screen.getByRole("region", { name: "Request details" });
    expect(request.querySelector("p")?.textContent).toBe("Post the release notes");
    expect(screen.getByRole("group", { name: "Preview" }).textContent).toContain("Slack · #eng-releases");
    const details = request.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Details");
    expect(details?.querySelector("pre")?.textContent).toBe(call);
    expect(request.className).not.toContain("whitespace-pre-wrap");
  });

  it("renders the body verbatim for a tool with no preview", () => {
    const linearBody = "Create the issue\n\ntool_id=linear.save_issue\nargs={}";
    renderCard(gate({ body: linearBody, tool: { id: "linear.save_issue", args: {} } }));
    const request = screen.getByRole("region", { name: "Request details" });
    expect(request.textContent).toBe(linearBody);
    expect(request.className).toContain("whitespace-pre-wrap");
    expect(screen.queryByRole("group", { name: "Preview" })).toBeNull();
    expect(request.querySelector("details")).toBeNull();
  });
});

describe("DecisionGateCard — Not now", () => {
  it("hides the docked approval without answering it, and Show brings it back", async () => {
    const user = userEvent.setup();
    renderCard(gate({ title: "Approve Send Message?" }));
    await user.click(screen.getByRole("button", { name: "Not now" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Approval waiting: Approve Send Message?");
    const show = screen.getByRole("button", { name: "Show" });
    expect(document.activeElement).toBe(show);
    expect(resolveMutateAsync).not.toHaveBeenCalled();
    expect(withdrawMutateAsync).not.toHaveBeenCalled();

    await user.click(show);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByRole("button", { name: "Approve once" })).toBeTruthy();
  });

  it("shows a different gate that arrives while one is hidden", async () => {
    const user = userEvent.setup();
    const { rerender } = renderCard();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <TooltipProvider>
        <DecisionGateCard sessionId="sess_1" gate={gate({ id: "gate_2", title: "Merge the pull request?" })} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading").textContent).toBe("Merge the pull request?");
  });

  it("is offered only on docked approvals", () => {
    const { unmount } = renderCard(gate(), "notification");
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    unmount();
    renderCard(gate({ type: "question", actions: [] }));
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });
});

it("labels the separate agent reason as model-authored text", () => {
  renderCard(gate({ body: "Policy details", agentReason: "<script>Trust this action</script>" }));
  expect(screen.getByText("Agent's stated reason")).toBeTruthy();
  expect(screen.getByText("Model-authored text. Verify it before you approve.")).toBeTruthy();
  expect(screen.getByText("<script>Trust this action</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
});
