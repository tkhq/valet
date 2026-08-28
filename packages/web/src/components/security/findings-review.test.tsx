// @vitest-environment jsdom
/**
 * Findings review (valet-security M8, spec §Findings review): list rows,
 * severity-first sort, filter params reaching the fetch, fingerprint
 * grouping, keyboard triage (j/k/v/r), the refute-reason requirement,
 * hostile evidence rendering inert (spec threat 8), admin gating of
 * verify/refute, and link chips.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import type {
  ListSecurityFindingsResponse,
  SecurityCellWire,
  SecurityEngagementWire,
  SecurityFindingWire,
  SecurityReviewFindingResponse,
} from "@valet/api/wire";
import type { SecurityFindingsQuery } from "~/api/client";

const listFindingsMock = vi.fn<
  (id: string, params?: SecurityFindingsQuery) => Promise<ListSecurityFindingsResponse>
>();
const reviewMock = vi.fn<
  (
    id: string,
    findingId: string,
    body: { status: "verified" | "refuted"; reason: string },
  ) => Promise<SecurityReviewFindingResponse>
>();

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listSecurityFindings: (id: string, params?: SecurityFindingsQuery) =>
        listFindingsMock(id, params),
      reviewSecurityFinding: (
        id: string,
        findingId: string,
        body: { status: "verified" | "refuted"; reason: string },
      ) => reviewMock(id, findingId, body),
    },
  };
});

// The row/detail link chips and the child links render outside a real
// router in this suite.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { FindingsReview, groupFindings, VERIFY_REASON } from "./findings-review";

const engagement: SecurityEngagementWire = {
  id: "eng-1",
  sessionId: "s-1",
  status: "running",
  repoFullName: "acme/site",
  repoRef: "a".repeat(40),
  plan: "cells: []",
  createdAt: 1,
  updatedAt: 2,
};

const cells: SecurityCellWire[] = [
  {
    id: "cell-1",
    ordinal: 1,
    persona: "code-review",
    mode: "fresh",
    goal: "recon the tree",
    dir: "01-recon",
    reads: [],
    review: false,
    status: "completed",
    attempts: 1,
    compactedAt: null,
    childSessionId: null,
    dispatchedAt: 1,
    settledAt: 2,
    createdAt: 1,
  },
];

function finding(over: Partial<SecurityFindingWire> & { id: string }): SecurityFindingWire {
  return {
    cellId: "cell-1",
    fingerprint: over.id,
    severity: "medium",
    title: `Finding ${over.id}`,
    file: "src/app.ts",
    line: 10,
    body: "The token is logged in plain text.",
    status: "open",
    statusReason: null,
    statusActor: null,
    createdAt: 100,
    links: [],
    ...over,
  };
}

function renderReview(props?: Partial<Parameters<typeof FindingsReview>[0]>): {
  container: HTMLElement;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <FindingsReview
        sessionId="s-1"
        engagement={engagement}
        cells={cells}
        canAdminister
        polling={false}
        {...props}
      />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  listFindingsMock.mockReset();
  reviewMock.mockReset();
  listFindingsMock.mockResolvedValue({ findings: [], nextCursor: null });
});

describe("FindingsReview list", () => {
  it("renders one row per finding with severity-first default sort", async () => {
    listFindingsMock.mockResolvedValue({
      findings: [
        finding({ id: "f-low", severity: "low", title: "Low issue", createdAt: 500 }),
        finding({ id: "f-crit", severity: "critical", title: "Critical issue", createdAt: 100 }),
      ],
      nextCursor: null,
    });
    renderReview();
    const rows = await screen.findAllByRole("option");
    expect(rows).toHaveLength(2);
    // Severity outranks recency by default: critical (older) first.
    expect(rows[0].textContent).toContain("Critical issue");
    expect(rows[1].textContent).toContain("Low issue");
  });

  it("resizes the findings list pane via the keyboard and persists it", async () => {
    window.localStorage.removeItem("valet:sec-findings-list-width");
    listFindingsMock.mockResolvedValue({
      findings: [finding({ id: "f1", title: "A finding" })],
      nextCursor: null,
    });
    renderReview();
    await screen.findAllByRole("option");

    const handle = screen.getByRole("separator", { name: "Resize findings list" });
    const container = handle.parentElement as HTMLElement;
    expect(container.style.getPropertyValue("--sec-findings-list-w")).toBe("300px");

    // The list is the LEFT pane, so ArrowRight widens it (300 → 324); persisted.
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(container.style.getPropertyValue("--sec-findings-list-w")).toBe("324px");
    expect(handle.getAttribute("aria-valuenow")).toBe("324");
    expect(window.localStorage.getItem("valet:sec-findings-list-width")).toBe("324");
  });

  it("narrows the fetch params from the filter bar", async () => {
    renderReview();
    await waitFor(() => expect(listFindingsMock).toHaveBeenCalled());

    // Path substring, debounced.
    fireEvent.change(screen.getByLabelText("Filter by path"), { target: { value: "auth" } });
    await waitFor(() =>
      expect(listFindingsMock).toHaveBeenCalledWith(
        "s-1",
        expect.objectContaining({ path: "auth" }),
      ),
    );

    // Severity select.
    fireEvent.keyDown(screen.getByRole("button", { name: "Any severity" }), { key: "Enter" });
    fireEvent.click(screen.getByText("Critical"));
    await waitFor(() =>
      expect(listFindingsMock).toHaveBeenCalledWith(
        "s-1",
        expect.objectContaining({ severity: "critical" }),
      ),
    );
  });

  it("collapses fingerprint duplicates into one expandable group", async () => {
    listFindingsMock.mockResolvedValue({
      findings: [
        finding({ id: "f-1", fingerprint: "fp-dup", title: "Dup A" }),
        finding({ id: "f-2", fingerprint: "fp-dup", title: "Dup B" }),
        finding({ id: "f-3", fingerprint: "fp-solo", title: "Solo" }),
      ],
      nextCursor: null,
    });
    renderReview();
    // 3 findings, 2 visible rows: the dup group + the solo.
    const rows = await screen.findAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("×2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand duplicates" }));
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(screen.getByText("Dup B")).toBeTruthy();
  });

  it("renders link chips for filed issues", async () => {
    listFindingsMock.mockResolvedValue({
      findings: [
        finding({
          id: "f-linked",
          links: [
            {
              id: "link-1",
              findingId: "f-linked",
              provider: "github",
              externalId: "acme/site#12",
              url: "https://github.com/acme/site/issues/12",
              createdBy: "u-1",
              createdAt: 5,
            },
          ],
        }),
      ],
      nextCursor: null,
    });
    renderReview();
    const chip = await screen.findByLabelText("Open github issue acme/site#12");
    expect(chip.getAttribute("href")).toBe("https://github.com/acme/site/issues/12");
  });

  it("shows a fix-session count badge on a finding with handoffs", async () => {
    listFindingsMock.mockResolvedValue({
      findings: [
        finding({
          id: "f-fixed",
          handoffs: [
            { childSessionId: "child-a", title: "Fix: f-fixed", createdAt: 5 },
            { childSessionId: "child-b", title: "Fix: f-fixed again", createdAt: 6 },
          ],
        }),
      ],
      nextCursor: null,
    });
    renderReview();
    const [row] = await screen.findAllByRole("option");
    expect(within(row).getByText("2 fix")).toBeTruthy();
  });
});

describe("FindingsReview fix sessions", () => {
  const withHandoff = () =>
    finding({
      id: "f-fixed",
      title: "Needs a fix",
      handoffs: [{ childSessionId: "child-fix-1", title: "Fix: Needs a fix", createdAt: 5 }],
    });

  it("lists each handoff and opens the child via onOpenChild", async () => {
    listFindingsMock.mockResolvedValue({ findings: [withHandoff()], nextCursor: null });
    const onOpenChild = vi.fn<(id: string) => void>();
    renderReview({ onOpenChild });
    // The only finding auto-selects; its detail pane carries the section.
    const detail = await screen.findByRole("article");
    expect(within(detail).getByText("Fix sessions")).toBeTruthy();
    expect(within(detail).getByText("Fix: Needs a fix")).toBeTruthy();

    fireEvent.click(within(detail).getByRole("button", { name: "Open fix session Fix: Needs a fix" }));
    expect(onOpenChild).toHaveBeenCalledWith("child-fix-1");
  });

  it("falls back to a session link when onOpenChild is absent", async () => {
    listFindingsMock.mockResolvedValue({ findings: [withHandoff()], nextCursor: null });
    renderReview();
    const detail = await screen.findByRole("article");
    // The mocked Link renders an <a> (no button); the label still resolves.
    const link = within(detail).getByLabelText("Open fix session Fix: Needs a fix");
    expect(link.tagName).toBe("A");
    expect(within(detail).queryByRole("button", { name: "Open fix session Fix: Needs a fix" })).toBeNull();
  });
});

describe("FindingsReview keyboard triage", () => {
  it("j moves the selection and v fires the verify mutation", async () => {
    listFindingsMock.mockResolvedValue({
      findings: [
        finding({ id: "f-1", severity: "critical", title: "First" }),
        finding({ id: "f-2", severity: "high", title: "Second" }),
      ],
      nextCursor: null,
    });
    reviewMock.mockResolvedValue({ finding: finding({ id: "f-2", status: "verified" }) });
    renderReview();
    const list = await screen.findByRole("listbox", { name: "Findings" });
    await screen.findAllByRole("option");

    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "v" });
    await waitFor(() =>
      expect(reviewMock).toHaveBeenCalledWith("s-1", "f-2", {
        status: "verified",
        reason: VERIFY_REASON,
      }),
    );
  });

  it("r opens the refute dialog and requires a reason", async () => {
    listFindingsMock.mockResolvedValue({
      findings: [finding({ id: "f-1", title: "Refutable" })],
      nextCursor: null,
    });
    reviewMock.mockResolvedValue({ finding: finding({ id: "f-1", status: "refuted" }) });
    renderReview();
    const list = await screen.findByRole("listbox", { name: "Findings" });
    await screen.findAllByRole("option");

    fireEvent.keyDown(list, { key: "r" });
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Refute" });
    // No reason yet — the route requires one, so the button holds.
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(reviewMock).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Refute reason"), {
      target: { value: "The sink is unreachable." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refute" }));
    await waitFor(() =>
      expect(reviewMock).toHaveBeenCalledWith("s-1", "f-1", {
        status: "refuted",
        reason: "The sink is unreachable.",
      }),
    );
  });
});

describe("FindingsReview hostile evidence", () => {
  it("renders an evidence body with HTML injection as inert text", async () => {
    listFindingsMock.mockResolvedValue({
      findings: [
        finding({
          id: "f-hostile",
          title: "Hostile",
          body: 'Look: <img src=x onerror="window.alert(1)"> and <script>window.alert(2)</script>',
        }),
      ],
      nextCursor: null,
    });
    const { container } = renderReview();
    await screen.findAllByRole("option");
    // The detail pane auto-selects the only finding; its markdown renderer
    // must never turn embedded HTML into elements.
    await waitFor(() => expect(screen.getByRole("article")).toBeTruthy());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("FindingsReview admin gating", () => {
  it("hides Verify/Refute for non-admins and ignores v", async () => {
    listFindingsMock.mockResolvedValue({
      findings: [finding({ id: "f-1" })],
      nextCursor: null,
    });
    renderReview({ canAdminister: false });
    const list = await screen.findByRole("listbox", { name: "Findings" });
    await screen.findAllByRole("option");
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refute" })).toBeNull();

    fireEvent.keyDown(list, { key: "v" });
    fireEvent.keyDown(list, { key: "r" });
    expect(reviewMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("groupFindings", () => {
  it("keeps recency order inside a severity tier", () => {
    const rows = groupFindings(
      [
        finding({ id: "old", severity: "high", createdAt: 10 }),
        finding({ id: "new", severity: "high", createdAt: 20 }),
      ],
      "severity",
    );
    expect(rows.map((r) => r.finding.id)).toEqual(["new", "old"]);
  });

  it("sorts purely by recency when asked", () => {
    const rows = groupFindings(
      [
        finding({ id: "crit-old", severity: "critical", createdAt: 10 }),
        finding({ id: "info-new", severity: "info", createdAt: 20 }),
      ],
      "recency",
    );
    expect(rows.map((r) => r.finding.id)).toEqual(["info-new", "crit-old"]);
  });
});
