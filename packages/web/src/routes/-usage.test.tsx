// @vitest-environment jsdom
/**
 * `/usage` — unified spend dashboard. Mocks `~/api/usage`, `~/api/proxy-usage`
 * to assert:
 *   - total cost renders from breakdown;
 *   - By-use-case table has a row per bucket;
 *   - expanding Orchestrator row lists sessions;
 *   - expanding Sessions row nests child under parent;
 *   - By model section shows model names;
 *   - spend chart renders day bars;
 *   - proxy request log still renders and opens SampleView on row click;
 *   - Settings → Proxy callout link renders;
 *   - disabled-gateway notice renders.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type {
  UsageBreakdownResponse,
  UsageSessionsResponse,
  ProxyRequestListItem,
  ProxyRequestDetail,
} from "@valet/api/wire";

// --- mock data -----------------------------------------------------------

const DAY_A_MS = Math.floor(1_750_000_000_000 / 86_400_000) * 86_400_000;
const DAY_B_MS = DAY_A_MS + 86_400_000;

const mockBreakdown: UsageBreakdownResponse = {
  windowMs: 7 * 86_400_000,
  totalCostUsd: 0.1234,
  totalTokens: 15_000,
  totalInputTokens: 10_000,
  totalOutputTokens: 5_000,
  byUseCase: [
    { useCase: "orchestrator", costUsd: 0.04, totalTokens: 5_000, turns: 10 },
    { useCase: "session", costUsd: 0.06, totalTokens: 8_000, turns: 20 },
    { useCase: "workflow", costUsd: 0.01, totalTokens: 1_000, turns: 2 },
    { useCase: "proxy", costUsd: 0.0134, totalTokens: 1_000, turns: 5 },
  ],
  byModel: [
    { model: "claude-opus-4-5", costUsd: 0.09, totalTokens: 12_000, turns: 25 },
    { model: "gpt-4o", costUsd: 0.0334, totalTokens: 3_000, turns: 12 },
  ],
  byDay: [
    { dayMs: DAY_A_MS, costUsd: 0.07, totalTokens: 7_000 },
    { dayMs: DAY_B_MS, costUsd: 0.0534, totalTokens: 8_000 },
  ],
};

const mockOrchestratorSessions: UsageSessionsResponse = {
  sessions: [
    {
      sessionId: "orchestrator:user_abc123",
      title: "My Orchestrator",
      useCase: "orchestrator",
      isChild: false,
      parentSessionId: null,
      costUsd: 0.04,
      totalTokens: 5_000,
      turns: 10,
    },
  ],
};

const mockRegularSessions: UsageSessionsResponse = {
  sessions: [
    {
      sessionId: "sess_parent1",
      title: "Parent session",
      useCase: "session",
      isChild: false,
      parentSessionId: null,
      costUsd: 0.05,
      totalTokens: 6_000,
      turns: 15,
    },
    {
      sessionId: "sess_child1",
      title: "Child session",
      useCase: "session",
      isChild: true,
      parentSessionId: "sess_parent1",
      costUsd: 0.01,
      totalTokens: 2_000,
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

// Sessions result — keyed by useCase so expand tests can return different data.
let sessionsResults: Record<
  string,
  { data: UsageSessionsResponse | undefined; isLoading: boolean; error: null | Error }
> = {
  orchestrator: { data: mockOrchestratorSessions, isLoading: false, error: null },
  session: { data: mockRegularSessions, isLoading: false, error: null },
};

vi.mock("~/api/usage", () => ({
  useUsageBreakdown: () => breakdownResult,
  useUsageSessions: (_window: string, useCase?: string) =>
    sessionsResults[useCase ?? "orchestrator"] ?? {
      data: undefined,
      isLoading: false,
      error: null,
    },
  qkUsage: {
    breakdown: () => [],
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

import { UsagePage } from "./usage";

beforeEach(() => {
  vi.clearAllMocks();
  breakdownResult = { data: mockBreakdown, isLoading: false, error: null };
  sessionsResults = {
    orchestrator: { data: mockOrchestratorSessions, isLoading: false, error: null },
    session: { data: mockRegularSessions, isLoading: false, error: null },
  };
  requestsResult = { data: mockRequests, isLoading: false, error: null };
  detailResult = { data: mockDetail, isLoading: false, error: null };
  settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
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

describe("UsagePage — by-use-case table", () => {
  it("renders all four use-case labels", () => {
    render(<UsagePage />);
    expect(screen.getByText("Orchestrator")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Workflows")).toBeTruthy();
    expect(screen.getByText("Proxy (external tools)")).toBeTruthy();
  });

  it("expanding Orchestrator row shows orchestrator sessions", async () => {
    render(<UsagePage />);
    const orchRow = screen.getByRole("button", {
      name: /Orchestrator — expand sessions/,
    });
    fireEvent.click(orchRow);
    await waitFor(() => {
      expect(screen.getByText("My Orchestrator")).toBeTruthy();
    });
  });

  it("orchestrator session id does not render as a link", async () => {
    render(<UsagePage />);
    const orchRow = screen.getByRole("button", {
      name: /Orchestrator — expand sessions/,
    });
    fireEvent.click(orchRow);
    await waitFor(() => {
      expect(screen.getByText("My Orchestrator")).toBeTruthy();
    });
    // orchestrator: IDs must not produce an anchor
    const links = Array.from(document.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("My Orchestrator"),
    );
    expect(links.length).toBe(0);
  });

  it("expanding Sessions row shows parent and child sessions", async () => {
    render(<UsagePage />);
    const sessRow = screen.getByRole("button", {
      name: /Sessions — expand sessions/,
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
      name: /Sessions — expand sessions/,
    });
    fireEvent.click(sessRow);
    await waitFor(() => {
      expect(screen.getByText("Child session")).toBeTruthy();
    });
    // Find the row containing "Child session" and verify it has pl-8
    const childRows = Array.from(container.querySelectorAll(".pl-8"));
    expect(childRows.length).toBeGreaterThan(0);
    const childText = childRows.some((el) =>
      el.textContent?.includes("Child session"),
    );
    expect(childText).toBe(true);
  });

  it("regular session title renders as an anchor (links to sessions route)", async () => {
    render(<UsagePage />);
    const sessRow = screen.getByRole("button", {
      name: /Sessions — expand sessions/,
    });
    fireEvent.click(sessRow);
    await waitFor(() => {
      expect(screen.getByText("Parent session")).toBeTruthy();
    });
    // The Link mock renders <a href={to}> where `to` is the route pattern.
    // The important assertion is that "Parent session" is inside an anchor
    // (i.e. it is linked), while "My Orchestrator" was not (tested separately).
    const parentLink = Array.from(document.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Parent session",
    );
    expect(parentLink).toBeTruthy();
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
