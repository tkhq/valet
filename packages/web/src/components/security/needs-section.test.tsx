// @vitest-environment jsdom
/**
 * Pivot-coordinator needs section (M-P4c, spec §Pivot-coordinator): it lists
 * auto-resolved needs (informational) and needs-human needs with a resolve
 * control, renders nothing when the engagement recorded no needs, and posts the
 * answer through the resolve route on "Resolve & continue".
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SecurityNeedWire } from "@valet/api/wire";

const resolveMock = vi.fn(
  async (
    _id: string,
    _answers: { needId: string; resolution: string; dismiss?: boolean }[],
  ) => ({ answered: [], resetCellIds: [] }),
);

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      resolveSecurityNeeds: (
        id: string,
        answers: { needId: string; resolution: string; dismiss?: boolean }[],
      ) => resolveMock(id, answers),
    },
  };
});

import { NeedsSection } from "./needs-section";

function need(overrides: Partial<SecurityNeedWire>): SecurityNeedWire {
  return {
    id: "need_1",
    cellId: "cell_2",
    kind: "credential",
    description: "A staging admin token to reach /admin routes.",
    status: "needs_human",
    resolution: null,
    createdAt: 1,
    resolvedAt: null,
    ...overrides,
  };
}

function renderSection(needs: SecurityNeedWire[], canAdminister = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NeedsSection sessionId="s-1" needs={needs} canAdminister={canAdminister} />
    </QueryClientProvider>,
  );
}

describe("NeedsSection", () => {
  it("renders nothing when there are no needs", () => {
    const { container } = renderSection([]);
    expect(container.firstChild).toBeNull();
  });

  it("lists auto-resolved and needs-human items with the counts", () => {
    renderSection([
      need({ id: "need_h", status: "needs_human", description: "A staging admin token." }),
      need({
        id: "need_a",
        status: "auto_resolved",
        kind: "scope",
        description: "Sweep packages/payments.",
        resolution: "Already inside the authorized scope glob 'packages/payments/**'.",
      }),
    ]);
    expect(screen.getByText(/1 waiting/)).toBeTruthy();
    expect(screen.getByText(/1 auto-resolved/)).toBeTruthy();
    expect(screen.getByText(/A staging admin token\./)).toBeTruthy();
    expect(screen.getByText(/Auto-resolved: Sweep packages\/payments\./)).toBeTruthy();
    expect(screen.getByText(/authorized scope glob/)).toBeTruthy();
  });

  it("posts the answer through the resolve route on Resolve & continue", async () => {
    resolveMock.mockClear();
    renderSection([need({ id: "need_h", status: "needs_human" })]);
    const box = screen.getByPlaceholderText(/credential, scope, or dependency/);
    fireEvent.change(box, { target: { value: "Token: stg_admin_abc123." } });
    fireEvent.click(screen.getByText(/Resolve & continue/));
    await waitFor(() => {
      expect(resolveMock).toHaveBeenCalledWith("s-1", [
        { needId: "need_h", resolution: "Token: stg_admin_abc123." },
      ]);
    });
  });

  it("hides the resolve control for a non-admin viewer", () => {
    renderSection([need({ id: "need_h", status: "needs_human" })], false);
    expect(screen.queryByText(/Resolve & continue/)).toBeNull();
    // The item is still shown so a viewer sees the pending ask.
    expect(screen.getByText(/A staging admin token to reach \/admin routes\./)).toBeTruthy();
  });
});
