// @vitest-environment jsdom
/**
 * Organization · Policies (action-policies plan, Task 5): the new-policy
 * form enforces target one-of in the UI (radio group swaps which field is
 * sent), matcher rows add/remove and get included in the create payload,
 * and the kill-switch toggle is sugar over a service-level deny policy
 * (create when off→on, delete the matching row when on→off). Mocks
 * `~/api/policies` and `~/api/integrations` the same way
 * `-settings.organization.models.test.tsx` mocks `~/api/settings`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionPolicyWire, ListPluginsResponse } from "@valet/api/wire";

const createOrgPolicyMutate = vi.fn();
const deleteOrgPolicyMutate = vi.fn();

let policiesData: { policies: ActionPolicyWire[] } = { policies: [] };
let pluginsData: ListPluginsResponse = { plugins: [] };

vi.mock("~/api/policies", async () => {
  const actual = await vi.importActual<typeof import("~/api/policies")>("~/api/policies");
  return {
    ...actual,
    useOrgPolicies: () => ({ data: policiesData, isLoading: false, error: null }),
    useCreateOrgPolicy: () => ({ mutate: createOrgPolicyMutate, isPending: false }),
    useDeleteOrgPolicy: () => ({ mutate: deleteOrgPolicyMutate, isPending: false }),
  };
});

vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: pluginsData, isLoading: false, error: null }),
}));

import { PoliciesSection } from "./policies-section";

function policyRow(overrides: Partial<ActionPolicyWire> = {}): ActionPolicyWire {
  return {
    id: "pol_1",
    service: "gmail",
    actionId: null,
    riskLevel: null,
    mode: "require_approval",
    paramMatchers: [],
    appliesIn: "any",
    origin: "admin",
    managedBy: "u1",
    expiresAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  policiesData = { policies: [] };
  pluginsData = {
    plugins: [
      {
        name: "gmail",
        version: "1.0.0",
        actionCount: 1,
        services: [
          {
            service: "gmail",
            type: "oauth2",
            configKeys: [],
            connected: true,
            actions: [{ id: "gmail.send_email", name: "Send email", riskLevel: "medium" }],
          },
        ],
      },
    ],
  };
});

describe("PoliciesSection — new policy target one-of", () => {
  it("defaults to Service target and only sends service in the create payload", async () => {
    const user = userEvent.setup();
    render(<PoliciesSection />);

    await user.selectOptions(screen.getByLabelText("Service", { selector: "#policy-service" }), "gmail");
    await user.click(screen.getByRole("button", { name: "Create policy" }));

    expect(createOrgPolicyMutate).toHaveBeenCalledTimes(1);
    const call = createOrgPolicyMutate.mock.calls[0][0];
    expect(call.service).toBe("gmail");
    expect(call.actionId).toBeUndefined();
    expect(call.riskLevel).toBeUndefined();
  });

  it("switching to Action target sends actionId only, not service", async () => {
    const user = userEvent.setup();
    render(<PoliciesSection />);

    await user.click(screen.getByRole("radio", { name: "Action" }));
    await user.selectOptions(screen.getByLabelText("Action", { selector: "#policy-action" }), "gmail.send_email");
    await user.click(screen.getByRole("button", { name: "Create policy" }));

    const call = createOrgPolicyMutate.mock.calls[0][0];
    expect(call.actionId).toBe("gmail.send_email");
    expect(call.service).toBeUndefined();
    expect(call.riskLevel).toBeUndefined();
  });

  it("switching to Risk level target sends riskLevel only and is always submittable", async () => {
    const user = userEvent.setup();
    render(<PoliciesSection />);

    await user.click(screen.getByRole("radio", { name: "Risk level" }));
    const submit = screen.getByRole("button", { name: "Create policy" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await user.click(submit);

    const call = createOrgPolicyMutate.mock.calls[0][0];
    expect(call.riskLevel).toBe("low");
    expect(call.service).toBeUndefined();
    expect(call.actionId).toBeUndefined();
  });
});

describe("PoliciesSection — matcher rows", () => {
  it("a gt matcher submits a NUMBER value, not a string (matchers.ts requires number for gt/gte/lt/lte)", async () => {
    const user = userEvent.setup();
    render(<PoliciesSection />);

    await user.click(screen.getByRole("button", { name: "Add matcher" }));
    await user.type(screen.getByLabelText("Matcher path"), "amount");
    await user.selectOptions(screen.getByLabelText("Matcher operator"), "gt");
    await user.type(screen.getByLabelText("Matcher value"), "100");
    await user.selectOptions(screen.getByLabelText("Service", { selector: "#policy-service" }), "gmail");
    await user.click(screen.getByRole("button", { name: "Create policy" }));

    const call = createOrgPolicyMutate.mock.calls[0][0];
    expect(call.paramMatchers).toEqual([{ path: "amount", op: "gt", value: 100 }]);
  });

  it("an in matcher submits an ARRAY value from a comma-separated list (validateParamMatchers requires an array)", async () => {
    const user = userEvent.setup();
    render(<PoliciesSection />);

    await user.click(screen.getByRole("button", { name: "Add matcher" }));
    await user.type(screen.getByLabelText("Matcher path"), "status");
    await user.selectOptions(screen.getByLabelText("Matcher operator"), "in");
    await user.type(screen.getByLabelText("Matcher value"), "a, b ,c");
    await user.selectOptions(screen.getByLabelText("Service", { selector: "#policy-service" }), "gmail");
    await user.click(screen.getByRole("button", { name: "Create policy" }));

    const call = createOrgPolicyMutate.mock.calls[0][0];
    expect(call.paramMatchers).toEqual([{ path: "status", op: "in", value: ["a", "b", "c"] }]);
  });

  it("a non-numeric gt value blocks submit and shows a visible error", async () => {
    const user = userEvent.setup();
    render(<PoliciesSection />);

    await user.click(screen.getByRole("button", { name: "Add matcher" }));
    await user.type(screen.getByLabelText("Matcher path"), "amount");
    await user.selectOptions(screen.getByLabelText("Matcher operator"), "gt");
    await user.type(screen.getByLabelText("Matcher value"), "not-a-number");
    await user.selectOptions(screen.getByLabelText("Service", { selector: "#policy-service" }), "gmail");
    await user.click(screen.getByRole("button", { name: "Create policy" }));

    expect(createOrgPolicyMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Matcher value must be a number for op "gt"')).toBeTruthy();
  });

  it("removing a matcher row omits it from the submitted payload", async () => {
    const user = userEvent.setup();
    render(<PoliciesSection />);

    await user.click(screen.getByRole("button", { name: "Add matcher" }));
    await user.click(screen.getByRole("button", { name: "Remove matcher" }));
    await user.selectOptions(screen.getByLabelText("Service", { selector: "#policy-service" }), "gmail");
    await user.click(screen.getByRole("button", { name: "Create policy" }));

    const call = createOrgPolicyMutate.mock.calls[0][0];
    expect(call.paramMatchers).toBeUndefined();
  });
});

describe("PoliciesSection — kill switches", () => {
  it("toggling a service's kill switch on creates a service-level deny/any policy", async () => {
    const user = userEvent.setup();
    render(<PoliciesSection />);

    await user.click(screen.getByRole("switch", { name: "Kill switch for gmail" }));

    expect(createOrgPolicyMutate).toHaveBeenCalledWith(
      { service: "gmail", mode: "deny", appliesIn: "any" },
      expect.anything(),
    );
  });

  it("shows the kill switch as on when a matching deny/any row exists, and toggling off deletes it", async () => {
    const user = userEvent.setup();
    policiesData = {
      policies: [policyRow({ id: "kill_1", service: "gmail", mode: "deny", appliesIn: "any" })],
    };
    render(<PoliciesSection />);

    const toggle = screen.getByRole("switch", { name: "Kill switch for gmail" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await user.click(toggle);
    expect(deleteOrgPolicyMutate).toHaveBeenCalledWith("kill_1", expect.anything());
  });

  it("does not treat an action-scoped or non-deny policy on the same service as a kill switch", () => {
    policiesData = {
      policies: [
        policyRow({ id: "p1", service: "gmail", actionId: "gmail.send_email", mode: "deny", appliesIn: "any" }),
        policyRow({ id: "p2", service: "gmail", mode: "require_approval", appliesIn: "any" }),
      ],
    };
    render(<PoliciesSection />);

    const toggle = screen.getByRole("switch", { name: "Kill switch for gmail" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
