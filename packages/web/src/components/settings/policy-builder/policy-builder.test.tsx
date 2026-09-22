// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { POLICY_CONTEXTS, type PolicyPreviewProvider } from "@valet/api/policy-builder";
import { PolicyBuilder } from "./policy-builder";

describe("canonical policy builder", () => {
  it("uses labeled controls and registered route targets", async () => {
    render(<PolicyBuilder contexts={POLICY_CONTEXTS} owner={{ kind: "org", id: "org-1" }} />);
    expect(screen.getByLabelText("Authorization context").tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "Tool and action (tool.builtin)" })).toBeTruthy();
    expect(screen.getByText(/not saved or active/i).textContent).toContain("not saved or active");
    fireEvent.change(screen.getByLabelText("id"), {
      target: { value: "gmail.send_email" },
    });
    fireEvent.change(screen.getByLabelText("Condition 1 value"), {
      target: { value: "safe@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Authorization context"), {
      target: { value: "api.route" },
    });
    expect(screen.queryByDisplayValue("gmail.send_email")).toBeNull();
    expect(screen.getByLabelText("Registered target").tagName).toBe("SELECT");
    expect(screen.getByText(/display only/).textContent).toContain("display only");
    fireEvent.change(screen.getByLabelText("Effect"), { target: { value: "require_approval" } });
    expect((screen.getByLabelText("Approval tier") as HTMLSelectElement).value).toBe("human");
    fireEvent.click(screen.getByRole("button", { name: "Preview and validate" }));
    expect((await screen.findByLabelText("Source preview")).textContent).toContain("Generated Rego v1");
  });

  it("sends normalized sanitized data to the provider and highlights declared ranges", async () => {
    const preview = vi.fn<PolicyPreviewProvider["preview"]>().mockImplementation(async (request) => ({
      status: "ready",
      identity: request.draft.normalizedIdentity,
      rego: "one\ntwo\nthree",
      data: "{}",
      ranges: [{ ruleId: "rule-provider", startLine: 2, endLine: 2 }],
    }));
    render(<PolicyBuilder contexts={POLICY_CONTEXTS} owner={{ kind: "org", id: "org-1" }} provider={{ preview }} />);
    fireEvent.change(screen.getByLabelText("id"), {
      target: { value: "gmail.send_email" },
    });
    fireEvent.change(screen.getByLabelText("Condition 1 value"), {
      target: { value: "safe@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Effect"), { target: { value: "require_approval" } }); expect(screen.getByText(/Approval requirement:/).textContent).toContain("current policy mode");
    fireEvent.click(screen.getByRole("button", { name: "Preview and validate" }));
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    const request = preview.mock.calls[0][0];
    expect(request.draft.normalizedIdentity).toContain("policy-draft-v1:"); expect(request.draft.rules[0].effect).toBe("require_approval"); expect(request.draft.rules[0].approval).toBeUndefined();
    expect(JSON.stringify(request)).not.toMatch(/secret|token|credential/i);
    fireEvent.click(await screen.findByRole("button", { name: "Show rule-provider" }));
    const source = screen.getByLabelText("Generated Rego source");
    expect(source.querySelectorAll('[data-highlighted="true"]')).toHaveLength(1);
    expect(screen.getByText(/No browser evaluator/).textContent).toContain("No browser evaluator");
  });

  it("never renders provider-external sensitive values", () => {
    const log = vi.spyOn(console, "log");
    const { container } = render(<PolicyBuilder contexts={POLICY_CONTEXTS} owner={{ kind: "org", id: "org-1" }} />);
    fireEvent.change(screen.getByLabelText("Authorization context"), {
      target: { value: "credential.use" },
    });
    expect(screen.getByLabelText("Registered target").tagName).toBe("SELECT");
    fireEvent.change(screen.getByLabelText("Effect"), { target: { value: "require_approval" } });
    expect((screen.getByLabelText("Approval tier") as HTMLSelectElement).value).toBe("human");
    expect(container.textContent).not.toContain("do-not-render");
    expect(screen.queryByLabelText(/ownerId|secret/i)).toBeNull();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("aborts stale previews and rejects malformed provider output", async () => {
    const pending: Array<(value: Awaited<ReturnType<PolicyPreviewProvider["preview"]>>) => void> = [], signals: AbortSignal[] = [];
    const preview = vi.fn<PolicyPreviewProvider["preview"]>((request, signal) => { signals.push(signal); return new Promise(resolve => pending.push(resolve)); });
    render(<PolicyBuilder contexts={POLICY_CONTEXTS} owner={{ kind: "org", id: "org-1" }} provider={{ preview }} />);
    const fill = (target: string) => { fireEvent.change(screen.getByLabelText("id"), { target: { value: target } }); fireEvent.change(screen.getByLabelText("Condition 1 value"), { target: { value: "safe@example.com" } }); };
    fill("gmail.first"); fireEvent.click(screen.getByRole("button", { name: "Preview and validate" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    fill("gmail.second"); expect(signals[0].aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview and validate" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    pending[1]({ status: "ready", identity: "wrong", rego: "x", data: "{}", ranges: [] });
    expect(await screen.findByText(/identity or source is invalid/i)).toBeTruthy();
    pending[0]({ status: "ready", identity: preview.mock.calls[0][0].draft.normalizedIdentity, rego: "stale", data: "{}", ranges: [] });
    expect(screen.queryByText("stale")).toBeNull();
    fill("gmail.third"); fireEvent.click(screen.getByRole("button", { name: "Preview and validate" })); await waitFor(() => expect(preview).toHaveBeenCalledTimes(3));
    pending[2]({ status: "ready", identity: preview.mock.calls[2][0].draft.normalizedIdentity, rego: "one", data: "{}", ranges: [{ ruleId: "r", startLine: 2, endLine: 1 }] });
    expect(await screen.findByText(/ranges are invalid/i)).toBeTruthy();
  });

  it("shows rejection errors and aborts on unmount", async () => {
    const rejected = vi.fn<PolicyPreviewProvider["preview"]>().mockRejectedValue(new Error("provider"));
    const first = render(<PolicyBuilder contexts={POLICY_CONTEXTS} owner={{ kind: "org", id: "org-1" }} provider={{ preview: rejected }} />);
    fireEvent.change(screen.getByLabelText("id"), { target: { value: "gmail.send" } }); fireEvent.change(screen.getByLabelText("Condition 1 value"), { target: { value: "safe" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview and validate" })); expect(await screen.findByText(/Preview failed/)).toBeTruthy(); first.unmount();
    let signal: AbortSignal | undefined; const pending = vi.fn<PolicyPreviewProvider["preview"]>((_request, value) => { signal = value; return new Promise(() => undefined); });
    const second = render(<PolicyBuilder contexts={POLICY_CONTEXTS} owner={{ kind: "org", id: "org-1" }} provider={{ preview: pending }} />);
    fireEvent.change(screen.getByLabelText("id"), { target: { value: "gmail.send" } }); fireEvent.change(screen.getByLabelText("Condition 1 value"), { target: { value: "safe" } }); fireEvent.click(screen.getByRole("button", { name: "Preview and validate" }));
    await waitFor(() => expect(pending).toHaveBeenCalled()); second.unmount(); expect(signal?.aborted).toBe(true);
  });

  it("keeps one target and resets typed operator values", () => {
    render(<PolicyBuilder contexts={POLICY_CONTEXTS} owner={{ kind: "org", id: "org-1" }} />);
    fireEvent.change(screen.getByLabelText("id"), { target: { value: "gmail.send" } });
    fireEvent.change(screen.getByLabelText("service"), { target: { value: "gmail" } });
    expect(screen.queryByDisplayValue("gmail.send")).toBeNull();
    fireEvent.change(screen.getByLabelText("Authorization context"), { target: { value: "egress.connect" } });
    expect((screen.getByLabelText("Registered target") as HTMLSelectElement).value).toBe("egress.connect");
    expect(screen.getByRole("alert").textContent).toContain("not available");
    fireEvent.change(screen.getByLabelText("Authorization context"), { target: { value: "tool.action" } });
    const operator = screen.getByLabelText("Condition 1 operator"), value = screen.getByLabelText("Condition 1 value") as HTMLInputElement;
    fireEvent.change(operator, { target: { value: "in" } }); fireEvent.change(value, { target: { value: '["safe",{"nested":true}]' } }); expect(value.value).toContain("nested");
    fireEvent.change(operator, { target: { value: "exists" } }); expect((screen.getByLabelText("Condition 1 value") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Expiry (UTC)"), { target: { value: "2030-01-02T03:04" } }); expect((screen.getByLabelText("Expiry (UTC)") as HTMLInputElement).value).toBe("2030-01-02T03:04");
  });

});
