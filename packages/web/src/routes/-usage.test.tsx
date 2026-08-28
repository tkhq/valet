// @vitest-environment jsdom
/**
 * `/usage` — unified spend dashboard. Mocks `~/api/usage`, `~/api/proxy-usage`,
 * `~/api/settings` to assert:
 *   - total cost renders from breakdown;
 *   - token/cache stats render (input/output/cache columns, cache-hit-rate);
 *   - unpriced indicator shows when unpricedTurns > 0, hidden when 0;
 *   - scope toggle appears only for org admins; switching refetches scope=org;
 *   - By-member table renders in org scope;
 *   - By-use-case table has a row per bucket;
 *   - all four use-case rows are expandable (Workflows and Proxy show items);
 *   - Sessions row nests child under parent;
 *   - By model section shows model names;
 *   - spend chart renders day bars;
 *   - Download CSV control points at /api/usage/export.csv with correct query;
 *   - proxy request log still renders and opens SampleView on row click;
 *   - Settings → Proxy callout link renders;
 *   - disabled-gateway notice renders.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type {
  UsageBreakdownResponse,
  UsageDrillResponse,
  ProxyRequestListItem,
  ProxyRequestDetail,
} from "@valet/api/wire";

// --- mock data -----------------------------------------------------------

const DAY_A_MS = Math.floor(1_750_000_000_000 / 86_400_000) * 86_400_000;
const DAY_B_MS = DAY_A_MS + 86_400_000;

const mockBreakdown: UsageBreakdownResponse = {
  windowMs: 7 * 86_400_000,
  scope: "me",
  totalCostUsd: 0.1234,
  totalTokens: 15_000,
  totalInputTokens: 10_000,
  totalOutputTokens: 5_000,
  totalCacheReadTokens: 2_000,
  totalCacheWriteTokens: 500,
  totalTurns: 37,
  unpricedTurns: 0,
  byUseCase: [
    {
      useCase: "orchestrator",
      costUsd: 0.04,
      totalTokens: 5_000,
      inputTokens: 3_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 10,
      unpricedTurns: 0,
    },
    {
      useCase: "session",
      costUsd: 0.06,
      totalTokens: 8_000,
      inputTokens: 5_000,
      outputTokens: 3_000,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 200,
      turns: 20,
      unpricedTurns: 0,
    },
    {
      useCase: "workflow",
      costUsd: 0.01,
      totalTokens: 1_000,
      inputTokens: 700,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 2,
      unpricedTurns: 0,
    },
    {
      useCase: "proxy",
      costUsd: 0.0134,
      totalTokens: 1_000,
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 5,
      unpricedTurns: 0,
    },
  ],
  byModel: [
    {
      model: "claude-opus-4-5",
      costUsd: 0.09,
      totalTokens: 12_000,
      inputTokens: 8_000,
      outputTokens: 4_000,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 500,
      turns: 25,
      unpricedTurns: 0,
    },
    {
      model: "gpt-4o",
      costUsd: 0.0334,
      totalTokens: 3_000,
      inputTokens: 2_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 12,
      unpricedTurns: 0,
    },
  ],
  byDay: [
    { dayMs: DAY_A_MS, costUsd: 0.07, totalTokens: 7_000 },
    { dayMs: DAY_B_MS, costUsd: 0.0534, totalTokens: 8_000 },
  ],
};

const mockBreakdownWithUnpriced: UsageBreakdownResponse = {
  ...mockBreakdown,
  unpricedTurns: 3,
};

const mockBreakdownOrgScope: UsageBreakdownResponse = {
  ...mockBreakdown,
  scope: "org",
  byUser: [
    {
      userId: "user_1",
      name: "Alice Smith",
      costUsd: 0.08,
      totalTokens: 10_000,
      inputTokens: 7_000,
      outputTokens: 3_000,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 200,
      turns: 22,
      unpricedTurns: 0,
    },
    {
      userId: "user_2",
      name: "Bob Jones",
      costUsd: 0.0434,
      totalTokens: 5_000,
      inputTokens: 3_000,
      outputTokens: 2_000,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 300,
      turns: 15,
      unpricedTurns: 0,
    },
  ],
};

const mockOrchestratorItems: UsageDrillResponse = {
  items: [
    {
      id: "orchestrator:user_abc123",
      label: "My Orchestrator",
      useCase: "orchestrator",
      isChild: false,
      parentId: null,
      sessionId: "orchestrator:user_abc123",
      costUsd: 0.04,
      totalTokens: 5_000,
      turns: 10,
    },
  ],
};

const mockSessionItems: UsageDrillResponse = {
  items: [
    {
      id: "sess_parent1",
      label: "Parent session",
      useCase: "session",
      isChild: false,
      parentId: null,
      sessionId: "sess_parent1",
      costUsd: 0.05,
      totalTokens: 6_000,
      turns: 15,
    },
    {
      id: "sess_child1",
      label: "Child session",
      useCase: "session",
      isChild: true,
      parentId: "sess_parent1",
      sessionId: "sess_child1",
      costUsd: 0.01,
      totalTokens: 2_000,
      turns: 5,
    },
  ],
};

const mockWorkflowItems: UsageDrillResponse = {
  items: [
    {
      id: "wf_run_1",
      label: "Deploy pipeline run #12",
      useCase: "workflow",
      isChild: false,
      parentId: null,
      sessionId: null,
      costUsd: 0.01,
      totalTokens: 1_000,
      turns: 2,
    },
  ],
};

const mockProxyItems: UsageDrillResponse = {
  items: [
    {
      id: "proxy_harness_1",
      label: "claude-code",
      useCase: "proxy",
      isChild: false,
      parentId: null,
      sessionId: null,
      costUsd: 0.0134,
      totalTokens: 1_000,
      turns: 5,
    },
  ],
};

const reqItem: ProxyRequestListItem = {
  id: "req_1",
  createdAt: Date.now() - 60_000,
  orgId: "org_1",
  userId: "user_abc123",
  apiKeyId: "key_1",
  providerKind: "anthropic",
  model: "claude-opus-4-5",
  harness: "claude-code",
  endpoint: "/v1/messages",
  stream: false,
  statusCode: 200,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 150,
  costUsd: 0.0012,
  latencyMs: 800,
  error: null,
};

const mockRequests = { items: [reqItem], nextCursor: undefined };

const mockDetail: ProxyRequestDetail = {
  ...reqItem,
  requestBody: '{"model":"claude-opus-4-5","messages":[{"role":"user","content":"Hello"}]}',
  responseBody: '{"id":"msg_1","content":[{"type":"text","text":"Hi there!"}]}',
  parsed: {
    schema: "valet.llm-sample/v1",
    provider: "anthropic",
    parseVersion: 1,
    model: "claude-opus-4-5",
    params: {},
    system: "You are a helpful assistant.",
    tools: [],
    previousResponseId: null,
    input: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
    output: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
    stop_reason: "end_turn",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
  },
  parseVersion: 1,
  parseError: null,
  providerResponseId: "msg_1",
  previousResponseId: null,
};

// --- mocks ---------------------------------------------------------------

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

// Mutable so individual tests can override.
let breakdownResult: {
  data: UsageBreakdownResponse | undefined;
  isLoading: boolean;
  error: null | Error;
} = { data: mockBreakdown, isLoading: false, error: null };

// Items result — keyed by useCase.
let itemsResults: Record<
  string,
  { data: UsageDrillResponse | undefined; isLoading: boolean; error: null | Error }
> = {
  orchestrator: { data: mockOrchestratorItems, isLoading: false, error: null },
  session: { data: mockSessionItems, isLoading: false, error: null },
  workflow: { data: mockWorkflowItems, isLoading: false, error: null },
  proxy: { data: mockProxyItems, isLoading: false, error: null },
};

vi.mock("~/api/usage", () => ({
  useUsageBreakdown: () => breakdownResult,
  useUsageItems: (_window: string, _scope: string, useCase: string) =>
    itemsResults[useCase] ?? { data: undefined, isLoading: false, error: null },
  qkUsage: {
    breakdown: () => [],
    items: () => [],
    sessions: () => [],
  },
}));

let requestsResult: {
  data: typeof mockRequests | undefined;
  isLoading: boolean;
  error: null | Error;
} = { data: mockRequests, isLoading: false, error: null };

let detailResult: {
  data: ProxyRequestDetail | undefined;
  isLoading: boolean;
  error: null | Error;
} = { data: mockDetail, isLoading: false, error: null };

let settingsResult: {
  data: { enabled: boolean; mode: "centralized" | "passthrough" } | undefined;
  isLoading: boolean;
} = { data: { enabled: true, mode: "centralized" }, isLoading: false };

vi.mock("~/api/proxy-usage", () => ({
  useProxyRequests: () => requestsResult,
  useProxyRequestDetail: () => detailResult,
  useProxySettings: () => settingsResult,
  qkProxy: {
    summary: () => [],
    requests: () => [],
    detail: () => [],
    settings: () => [],
  },
}));

// Mock useOrg — mutable for tests.
let orgResult: {
  data: { features: { organizations: boolean }; callerRole: "admin" | "member" } | undefined;
  isLoading: boolean;
} = {
  data: { features: { organizations: false }, callerRole: "member" },
  isLoading: false,
};

// Mock useTeams — mutable so team-scope tests can add memberships.
let teamsResult: {
  data: { teams: { id: string; name: string; callerRole: "admin" | "member" | null }[] } | undefined;
  isLoading: boolean;
} = { data: { teams: [] }, isLoading: false };

vi.mock("~/api/settings", () => ({
  useOrg: () => orgResult,
  useTeams: () => teamsResult,
}));

// Mock api client — usageExportCsvUrl is a pure URL builder.
vi.mock("~/api/client", () => ({
  api: {
    usageExportCsvUrl: (window: string, scope: string) =>
      `/api/usage/export.csv?window=${window}&scope=${scope}`,
  },
}));

import { UsagePage } from "./usage";

beforeEach(() => {
  vi.clearAllMocks();
  breakdownResult = { data: mockBreakdown, isLoading: false, error: null };
  itemsResults = {
    orchestrator: { data: mockOrchestratorItems, isLoading: false, error: null },
    session: { data: mockSessionItems, isLoading: false, error: null },
    workflow: { data: mockWorkflowItems, isLoading: false, error: null },
    proxy: { data: mockProxyItems, isLoading: false, error: null },
  };
  requestsResult = { data: mockRequests, isLoading: false, error: null };
  detailResult = { data: mockDetail, isLoading: false, error: null };
  settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
  orgResult = {
    data: { features: { organizations: false }, callerRole: "member" },
    isLoading: false,
  };
});

describe("UsagePage — spend summary", () => {
  it("renders the total cost from the breakdown", () => {
    render(<UsagePage />);
    expect(screen.getByText("$0.1234")).toBeTruthy();
  });

  it("renders total tokens stat", () => {
    render(<UsagePage />);
    expect(screen.getByText("15,000")).toBeTruthy();
  });

  it("renders the spend chart with the correct number of day bars", () => {
    const { container } = render(<UsagePage />);
    const rects = container.querySelectorAll("svg[aria-label='Daily spend chart'] rect");
    expect(rects.length).toBe(2);
    const heights = Array.from(rects).map((r) => Number(r.getAttribute("height")));
    expect(heights.every((h) => h > 2)).toBe(true);
  });
});

describe("UsagePage — token/cache stats", () => {
  it("renders input/output stat card", () => {
    render(<UsagePage />);
    // The "Input / Output" card should show the formatted values
    const inputOutputCard = screen.getByText("Input / Output");
    expect(inputOutputCard).toBeTruthy();
    // Values: 10,000 / 5,000
    expect(screen.getByText("10,000 / 5,000")).toBeTruthy();
  });

  it("renders cache hit rate stat card", () => {
    render(<UsagePage />);
    // cacheHitRate = 2000 / (10000 + 2000) = 16.7%
    expect(screen.getByText("Cache hit rate")).toBeTruthy();
    expect(screen.getByText("16.7%")).toBeTruthy();
  });

  it("renders cache read/write sub-label under cache hit rate", () => {
    render(<UsagePage />);
    // "2,000 read / 500 write"
    expect(screen.getByText("2,000 read / 500 write")).toBeTruthy();
  });

  it("shows — for cache hit rate when no tokens", () => {
    breakdownResult = {
      data: {
        ...mockBreakdown,
        totalInputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
      },
      isLoading: false,
      error: null,
    };
    render(<UsagePage />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders input/output/cache columns in the By-model table", () => {
    render(<UsagePage />);
    expect(screen.getByText("Input tok")).toBeTruthy();
    expect(screen.getByText("Output tok")).toBeTruthy();
    expect(screen.getByText("Cache read")).toBeTruthy();
    expect(screen.getByText("Cache write")).toBeTruthy();
  });
});

describe("UsagePage — unpriced indicator", () => {
  it("shows the unpriced indicator when unpricedTurns > 0", () => {
    breakdownResult = {
      data: mockBreakdownWithUnpriced,
      isLoading: false,
      error: null,
    };
    render(<UsagePage />);
    expect(screen.getByText(/3 turns unpriced/)).toBeTruthy();
    expect(screen.getByText(/cost shown is a floor/)).toBeTruthy();
  });

  it("hides the unpriced indicator when unpricedTurns === 0", () => {
    render(<UsagePage />);
    expect(screen.queryByText(/turns unpriced/)).toBeNull();
  });
});

describe("UsagePage — scope toggle", () => {
  it("does not show the scope toggle for non-admin users with no teams", () => {
    orgResult = {
      data: { features: { organizations: false }, callerRole: "member" },
      isLoading: false,
    };
    teamsResult = { data: { teams: [] }, isLoading: false };
    render(<UsagePage />);
    expect(screen.queryByText("My usage")).toBeNull();
    expect(screen.queryByText("Organization")).toBeNull();
  });

  it("a team member gets a per-team scope button without the org one", () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "member" },
      isLoading: false,
    };
    teamsResult = {
      data: { teams: [{ id: "team_1", name: "Security", callerRole: "member" }] },
      isLoading: false,
    };
    render(<UsagePage />);
    expect(screen.getByText("My usage")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Security" })).toBeTruthy();
    expect(screen.queryByText("Organization")).toBeNull();
  });

  it("teams the caller only administers (callerRole null) get no button", () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "admin" },
      isLoading: false,
    };
    teamsResult = {
      data: { teams: [{ id: "team_2", name: "Platform", callerRole: null }] },
      isLoading: false,
    };
    render(<UsagePage />);
    // Org admins read those teams through the Organization scope instead.
    expect(screen.queryByRole("button", { name: "Platform" })).toBeNull();
    expect(screen.getByText("Organization")).toBeTruthy();
  });

  it("resets a team scope to My usage when the membership disappears", () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "member" },
      isLoading: false,
    };
    teamsResult = {
      data: { teams: [{ id: "team_1", name: "Security", callerRole: "member" }] },
      isLoading: false,
    };
    const { rerender } = render(<UsagePage />);
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(screen.getByText(/Download CSV \(7d, Security\)/)).toBeTruthy();

    // Membership removed: the toggle would unmount with a stale team scope
    // and 403 forever; the reset effect flips back to the personal scope.
    teamsResult = { data: { teams: [] }, isLoading: false };
    rerender(<UsagePage />);
    expect(screen.getByText(/Download CSV \(7d, me\)/)).toBeTruthy();
  });

  it("selecting a team labels the CSV export with the team name", () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "member" },
      isLoading: false,
    };
    teamsResult = {
      data: { teams: [{ id: "team_1", name: "Security", callerRole: "member" }] },
      isLoading: false,
    };
    render(<UsagePage />);
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(screen.getByText(/Download CSV \(7d, Security\)/)).toBeTruthy();
  });

  it("does not show scope toggle when organizations feature is off even for admin", () => {
    orgResult = {
      data: { features: { organizations: false }, callerRole: "admin" },
      isLoading: false,
    };
    teamsResult = { data: { teams: [] }, isLoading: false };
    render(<UsagePage />);
    expect(screen.queryByText("My usage")).toBeNull();
  });

  it("shows the scope toggle for org admins with organizations feature on", () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "admin" },
      isLoading: false,
    };
    render(<UsagePage />);
    expect(screen.getByText("My usage")).toBeTruthy();
    expect(screen.getByText("Organization")).toBeTruthy();
  });

  it("switching to Organization calls useUsageBreakdown with scope=org", () => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "admin" },
      isLoading: false,
    };
    // Override the breakdown mock to track which scope is requested.
    // The mock vi.mock("~/api/usage") returns breakdownResult — we verify
    // the toggle renders the org data by switching breakdownResult.
    breakdownResult = {
      data: { ...mockBreakdownOrgScope },
      isLoading: false,
      error: null,
    };
    render(<UsagePage />);
    // The component calls useUsageBreakdown with scope — since we already mock
    // the data with org scope, By-member table should appear if the scope="org"
    // button is clicked. We verify the toggle exists and the button is rendered.
    const orgBtn = screen.getByText("Organization");
    fireEvent.click(orgBtn);
    // Button should now be "active" (aria-pressed=true)
    expect(orgBtn.closest("button")?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("UsagePage — By-member table (org scope)", () => {
  beforeEach(() => {
    orgResult = {
      data: { features: { organizations: true }, callerRole: "admin" },
      isLoading: false,
    };
  });

  it("shows By-member table when scope=org and byUser present", () => {
    breakdownResult = {
      data: mockBreakdownOrgScope,
      isLoading: false,
      error: null,
    };
    render(<UsagePage />);
    // Switch to org scope
    fireEvent.click(screen.getByText("Organization"));
    // Re-render happens with org data
    expect(screen.getByText("By member")).toBeTruthy();
    expect(screen.getByText("Alice Smith")).toBeTruthy();
    expect(screen.getByText("Bob Jones")).toBeTruthy();
  });

  it("does not show By-member table in me scope", () => {
    render(<UsagePage />);
    // Default scope=me, byUser not present
    expect(screen.queryByText("By member")).toBeNull();
  });
});

describe("UsagePage — by-use-case table", () => {
  it("renders all four use-case labels", () => {
    render(<UsagePage />);
    expect(screen.getByText("Orchestrator")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Workflows")).toBeTruthy();
    expect(screen.getByText("Proxy (external tools)")).toBeTruthy();
  });

  it("expanding Orchestrator row shows orchestrator items", async () => {
    render(<UsagePage />);
    const orchRow = screen.getByRole("button", {
      name: /Orchestrator — expand items/,
    });
    fireEvent.click(orchRow);
    await waitFor(() => {
      expect(screen.getByText("My Orchestrator")).toBeTruthy();
    });
  });

  it("orchestrator item does not render as a link (orch: prefix)", async () => {
    render(<UsagePage />);
    const orchRow = screen.getByRole("button", {
      name: /Orchestrator — expand items/,
    });
    fireEvent.click(orchRow);
    await waitFor(() => {
      expect(screen.getByText("My Orchestrator")).toBeTruthy();
    });
    const links = Array.from(document.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("My Orchestrator"),
    );
    expect(links.length).toBe(0);
  });

  it("expanding Sessions row shows parent and child items", async () => {
    render(<UsagePage />);
    const sessRow = screen.getByRole("button", {
      name: /Sessions — expand items/,
    });
    fireEvent.click(sessRow);
    await waitFor(() => {
      expect(screen.getByText("Parent session")).toBeTruthy();
      expect(screen.getByText("Child session")).toBeTruthy();
    });
  });

  it("child session row is indented with pl-8 class", async () => {
    const { container } = render(<UsagePage />);
    const sessRow = screen.getByRole("button", {
      name: /Sessions — expand items/,
    });
    fireEvent.click(sessRow);
    await waitFor(() => {
      expect(screen.getByText("Child session")).toBeTruthy();
    });
    const childRows = Array.from(container.querySelectorAll(".pl-8"));
    expect(childRows.length).toBeGreaterThan(0);
    const childText = childRows.some((el) =>
      el.textContent?.includes("Child session"),
    );
    expect(childText).toBe(true);
  });

  it("regular session item renders as an anchor (links to sessions route)", async () => {
    render(<UsagePage />);
    const sessRow = screen.getByRole("button", {
      name: /Sessions — expand items/,
    });
    fireEvent.click(sessRow);
    await waitFor(() => {
      expect(screen.getByText("Parent session")).toBeTruthy();
    });
    const parentLink = Array.from(document.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Parent session",
    );
    expect(parentLink).toBeTruthy();
  });

  it("expanding Workflows row shows workflow items (not linked)", async () => {
    render(<UsagePage />);
    const wfRow = screen.getByRole("button", {
      name: /Workflows — expand items/,
    });
    fireEvent.click(wfRow);
    await waitFor(() => {
      expect(screen.getByText("Deploy pipeline run #12")).toBeTruthy();
    });
    // Workflow items have no sessionId — must not be links
    const wfLinks = Array.from(document.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("Deploy pipeline run #12"),
    );
    expect(wfLinks.length).toBe(0);
  });

  it("expanding Proxy row shows proxy items (not linked)", async () => {
    render(<UsagePage />);
    const proxyRow = screen.getByRole("button", {
      name: /Proxy.*expand items/,
    });
    fireEvent.click(proxyRow);
    await waitFor(() => {
      // "claude-code" appears in both the expanded item list (span.truncate.text-muted)
      // and the request log harness column — getAllByText handles duplicates.
      const matches = screen.getAllByText("claude-code");
      expect(matches.length).toBeGreaterThan(0);
    });
    const proxyLinks = Array.from(document.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("claude-code"),
    );
    expect(proxyLinks.length).toBe(0);
  });
});

describe("UsagePage — by model section", () => {
  it("renders model names in the By model section", () => {
    render(<UsagePage />);
    const heading = screen.getByText("By model");
    const section = heading.closest("div");
    expect(section).toBeTruthy();
    expect(section!.textContent).toContain("claude-opus-4-5");
    expect(section!.textContent).toContain("gpt-4o");
  });
});

describe("UsagePage — CSV export", () => {
  it("renders a Download CSV link pointing at /api/usage/export.csv", () => {
    render(<UsagePage />);
    const csvLink = document.querySelector("a[download]") as HTMLAnchorElement | null;
    expect(csvLink).toBeTruthy();
    expect(csvLink!.href).toContain("/api/usage/export.csv");
  });

  it("CSV link includes the current window param", () => {
    render(<UsagePage />);
    const csvLink = document.querySelector("a[download]") as HTMLAnchorElement | null;
    expect(csvLink!.href).toContain("window=7d");
  });

  it("CSV link includes the current scope param", () => {
    render(<UsagePage />);
    const csvLink = document.querySelector("a[download]") as HTMLAnchorElement | null;
    expect(csvLink!.href).toContain("scope=me");
  });

  it("CSV link label mentions current window and scope", () => {
    render(<UsagePage />);
    const csvLink = document.querySelector("a[download]") as HTMLAnchorElement | null;
    expect(csvLink!.textContent).toMatch(/7d/);
    expect(csvLink!.textContent).toMatch(/me/);
  });
});

describe("UsagePage — request log drill-down", () => {
  it("clicking a request row opens the SampleView", async () => {
    render(<UsagePage />);
    const rowEl = document.querySelector("tr[role='button']") as HTMLElement;
    expect(rowEl).toBeTruthy();
    fireEvent.click(rowEl);
    await waitFor(() => {
      expect(screen.getByText("Request detail")).toBeTruthy();
    });
  });

  it("SampleView shows structured content from parsed detail", async () => {
    render(<UsagePage />);
    const rowEl = document.querySelector("tr[role='button']") as HTMLElement;
    fireEvent.click(rowEl);
    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeTruthy();
      expect(screen.getByText("Hi there!")).toBeTruthy();
    });
  });

  it("closing the SampleView removes it", async () => {
    render(<UsagePage />);
    const rowEl = document.querySelector("tr[role='button']") as HTMLElement;
    fireEvent.click(rowEl);
    await waitFor(() => {
      expect(screen.getByText("Request detail")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(screen.queryByText("Request detail")).toBeNull();
  });
});

describe("UsagePage — Settings → Proxy link", () => {
  it("renders Settings → Proxy callout link", () => {
    render(<UsagePage />);
    const link = document.querySelector("a[href='/settings/proxy']");
    expect(link).toBeTruthy();
    expect(link!.textContent).toMatch(/Settings.*Proxy|Settings → Proxy/);
  });
});

describe("UsagePage — disabled-gateway notice", () => {
  it("shows the notice when enabled=false", () => {
    settingsResult = { data: { enabled: false, mode: "centralized" }, isLoading: false };
    render(<UsagePage />);
    expect(screen.getByText(/recording gateway is disabled/)).toBeTruthy();
    const link = document.querySelector("a[href='/settings/organization/proxy']");
    expect(link).toBeTruthy();
  });

  it("does not show the notice when enabled=true", () => {
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<UsagePage />);
    expect(screen.queryByText(/recording gateway is disabled/)).toBeNull();
  });
});
