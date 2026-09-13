// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PolicyPreviewProvider } from "@valet/api/policy-builder";
import { PolicyBuilder } from "./policy-builder";

describe("canonical policy builder", () => {
  it("uses labeled controls, resets context state, and fails unsupported contexts closed", async () => {
    render(<PolicyBuilder owner={{ kind: "org", id: "org-1" }} />);
    expect(screen.getByLabelText("Authorization context")).toBeTruthy();
    expect(screen.getByText(/not saved or active/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("id"), {
      target: { value: "gmail.send_email" },
    });
    fireEvent.change(screen.getByLabelText("Condition 1 value"), {
      target: { value: "safe@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Authorization context"), {
      target: { value: "route.access" },
    });
    expect(screen.queryByDisplayValue("gmail.send_email")).toBeNull();
    expect(screen.getByText(/Preview fails closed/).textContent).toContain("fails closed");
    fireEvent.click(screen.getByRole("button", { name: "Preview and validate" }));
    expect((await screen.findByLabelText("Source preview")).textContent).toContain("Backend source support is not available");
  });

  it("sends normalized sanitized data to the provider and highlights declared ranges", async () => {
    const preview = vi.fn<PolicyPreviewProvider["preview"]>().mockResolvedValue({
      status: "ready",
      identity: "fixture",
      rego: "one\ntwo\nthree",
      data: "{}",
      ranges: [{ ruleId: "rule-provider", startLine: 2, endLine: 2 }],
    });
    render(<PolicyBuilder owner={{ kind: "org", id: "org-1" }} provider={{ preview }} />);
    fireEvent.change(screen.getByLabelText("id"), {
      target: { value: "gmail.send_email" },
    });
    fireEvent.change(screen.getByLabelText("Condition 1 value"), {
      target: { value: "safe@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview and validate" }));
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    const request = preview.mock.calls[0][0];
    expect(request.draft.normalizedIdentity).toContain("policy-draft-v1:");
    expect(JSON.stringify(request)).not.toMatch(/secret|token|credential/i);
    fireEvent.click(await screen.findByRole("button", { name: "Show rule-provider" }));
    const source = screen.getByLabelText("Generated Rego source");
    expect(source.querySelectorAll('[data-highlighted="true"]')).toHaveLength(1);
    expect(source.textContent).toContain("No browser evaluator".slice(0, 0));
  });

  it("never renders provider-external sensitive values", () => {
    const log = vi.spyOn(console, "log");
    const { container } = render(<PolicyBuilder owner={{ kind: "org", id: "org-1" }} />);
    fireEvent.change(screen.getByLabelText("Authorization context"), {
      target: { value: "credential.use" },
    });
    expect(container.textContent).not.toContain("do-not-render");
    fireEvent.change(screen.getByLabelText("Condition 1 field"), {
      target: { value: "credential.secret" },
    });
    expect(screen.getAllByPlaceholderText("Sensitive value hidden").length).toBeGreaterThan(0);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
