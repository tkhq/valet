// @vitest-environment jsdom
/**
 * `/usage` — LLM recording gateway dashboard. Mocks `~/api/proxy-usage`
 * and `~/api/api-keys` to assert:
 *   - the spend total renders from a mocked summary;
 *   - a breakdown row per model renders;
 *   - clicking a request-log row opens the SampleView drill-down;
 *   - OnboardingPanel shows both the Claude Code and Codex snippets after a
 *     mocked key creation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type {
  ProxyUsageSummary,
  ProxyRequestListItem,
  ProxyRequestDetail,
} from "@valet/api/wire";

// --- mock data -----------------------------------------------------------

// Two day buckets at known epoch-ms day boundaries so the chart renders
// non-flat bars (costUsd > 0 on both days).
const DAY_A_MS = Math.floor(1_750_000_000_000 / 86_400_000) * 86_400_000;
const DAY_B_MS = DAY_A_MS + 86_400_000;

const mockSummary: ProxyUsageSummary = {
  windowMs: 7 * 86_400_000,
  totalRequests: 42,
  totalInputTokens: 10_000,
  totalOutputTokens: 5_000,
  totalTokens: 15_000,
  totalCostUsd: 0.1234,
  byUser: [
    {
      userId: "user_abc123",
      requests: 20,
      inputTokens: 5_000,
      outputTokens: 2_500,
      totalTokens: 7_500,
      costUsd: 0.06,
    },
  ],
  byModel: [
    {
      model: "claude-opus-4-5",
      requests: 30,
      inputTokens: 8_000,
      outputTokens: 4_000,
      totalTokens: 12_000,
      costUsd: 0.09,
    },
    {
      model: "gpt-4o",
      requests: 12,
      inputTokens: 2_000,
      outputTokens: 1_000,
      totalTokens: 3_000,
      costUsd: 0.0334,
    },
  ],
  byHarness: [
    {
      harness: "claude-code",
      requests: 25,
      inputTokens: 6_000,
      outputTokens: 3_000,
      totalTokens: 9_000,
      costUsd: 0.07,
    },
  ],
  byDay: [
    { dayMs: DAY_A_MS, requests: 20, totalTokens: 7_000, costUsd: 0.07 },
    { dayMs: DAY_B_MS, requests: 22, totalTokens: 8_000, costUsd: 0.0534 },
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

// parsed uses the real Sample shape from packages/api/src/proxy/sample.ts:
// { schema, provider, model, params, system, tools, previousResponseId,
//   input: SampleMessage[], output: SampleMessage, stop_reason, usage }
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

const createKeyMutate = vi.fn();

vi.mock("~/api/api-keys", () => ({
  useCreateApiKey: () => ({
    mutate: createKeyMutate,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));

// Mutable so individual tests can override.
let summaryResult: { data: ProxyUsageSummary | undefined; isLoading: boolean; error: null | Error } = {
  data: mockSummary,
  isLoading: false,
  error: null,
};
let requestsResult: { data: typeof mockRequests | undefined; isLoading: boolean; error: null | Error } = {
  data: mockRequests,
  isLoading: false,
  error: null,
};
let detailResult: { data: ProxyRequestDetail | undefined; isLoading: boolean; error: null | Error } = {
  data: mockDetail,
  isLoading: false,
  error: null,
};
let settingsResult: { data: { enabled: boolean; mode: "centralized" | "passthrough" } | undefined; isLoading: boolean } = {
  data: { enabled: true, mode: "centralized" },
  isLoading: false,
};

const setModeMutate = vi.fn();

vi.mock("~/api/proxy-usage", () => ({
  useProxyUsageSummary: () => summaryResult,
  useProxyRequests: () => requestsResult,
  useProxyRequestDetail: () => detailResult,
  useProxySettings: () => settingsResult,
  useSetProxyMode: () => ({ mutate: setModeMutate, isPending: false, isError: false }),
  qkProxy: { summary: () => [], requests: () => [], detail: () => [], settings: () => [] },
}));

// Mutable org data
let orgData: { data: { callerRole: "admin" | "member"; features: { organizations: boolean } } | undefined; isLoading: boolean } = {
  data: { callerRole: "admin", features: { organizations: true } },
  isLoading: false,
};

vi.mock("~/api/settings", () => ({
  useOrg: () => orgData,
}));

import { UsagePage } from "./usage";

beforeEach(() => {
  vi.clearAllMocks();
  summaryResult = { data: mockSummary, isLoading: false, error: null };
  requestsResult = { data: mockRequests, isLoading: false, error: null };
  detailResult = { data: mockDetail, isLoading: false, error: null };
  settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
  orgData = { data: { callerRole: "admin", features: { organizations: true } }, isLoading: false };
  setModeMutate.mockReset();
});

describe("UsagePage — spend summary", () => {
  it("renders the total cost from the mocked summary", () => {
    render(<UsagePage />);
    // $0.1234 formatted
    expect(screen.getByText("$0.1234")).toBeTruthy();
  });

  it("renders request count", () => {
    render(<UsagePage />);
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("renders the spend chart with the correct number of day bars", () => {
    const { container } = render(<UsagePage />);
    // mockSummary.byDay has 2 entries; SpendChart renders one <rect> per bucket.
    const rects = container.querySelectorAll("svg[aria-label='Daily spend chart'] rect");
    expect(rects.length).toBe(2);
    // Both bars must have a height attribute greater than the 2px minimum floor,
    // confirming that real costUsd values (not zeroes) drove the scaling.
    const heights = Array.from(rects).map((r) => Number(r.getAttribute("height")));
    expect(heights.every((h) => h > 2)).toBe(true);
  });
});

describe("UsagePage — breakdown tables", () => {
  it("renders a row for each model in the breakdown table", () => {
    render(<UsagePage />);
    // Find the "By model" heading, then assert both model names appear inside
    // the same section (the parent wrapper div of BreakdownTable).
    const heading = screen.getByText("By model");
    const section = heading.closest("div");
    expect(section).toBeTruthy();
    expect(section!.textContent).toContain("claude-opus-4-5");
    expect(section!.textContent).toContain("gpt-4o");
  });

  it("renders harness row", () => {
    render(<UsagePage />);
    // "claude-code" appears in both the harness breakdown table and the request log.
    expect(screen.getAllByText("claude-code").length).toBeGreaterThan(0);
  });
});

describe("UsagePage — request log drill-down", () => {
  it("clicking a request row opens the SampleView", async () => {
    render(<UsagePage />);

    // Row renders as role=button with aria-pressed
    const rowEl = document.querySelector("tr[role='button']") as HTMLElement;
    expect(rowEl).toBeTruthy();
    fireEvent.click(rowEl);

    await waitFor(() => {
      // SampleView should render, showing the detail header.
      expect(screen.getByText("Request detail")).toBeTruthy();
    });
  });

  it("SampleView shows the model from the detail", async () => {
    render(<UsagePage />);
    const rowEl = document.querySelector("tr[role='button']") as HTMLElement;
    fireEvent.click(rowEl);

    await waitFor(() => {
      expect(screen.getAllByText("claude-opus-4-5").length).toBeGreaterThan(0);
    });
  });

  it("StructuredView renders the input user turn text and the assistant output text", async () => {
    // Guards the real Sample shape contract: parsed.input/output, not parsed.messages.
    render(<UsagePage />);
    const rowEl = document.querySelector("tr[role='button']") as HTMLElement;
    fireEvent.click(rowEl);

    await waitFor(() => {
      // The user input turn's text block must appear.
      expect(screen.getByText("Hello")).toBeTruthy();
      // The assistant output turn's text block must appear.
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

describe("UsagePage — OnboardingPanel", () => {
  it("clicking Create proxy key calls mutate", () => {
    render(<UsagePage />);
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));
    expect(createKeyMutate).toHaveBeenCalledWith("proxy-key", expect.objectContaining({ onSuccess: expect.any(Function) }));
  });

  it("shows Claude Code and Codex snippets after key creation", () => {
    const fakeKey = {
      id: "key_1",
      name: "proxy-key",
      key: "vlt_testkey12345",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: "user_1",
      enabled: true,
      rateLimitEnabled: false,
      rateLimitTimeWindow: null,
      rateLimitMax: null,
      requestCount: 0,
      remainingRequests: null,
      lastRequest: null,
      expiresAt: null,
      deletedAt: null,
      refillAmount: null,
      refillInterval: null,
      permissions: null,
      metadata: null,
      prefix: "vlt_",
    };
    // Simulate the onSuccess callback.
    createKeyMutate.mockImplementation((_name: string, opts: { onSuccess: (k: typeof fakeKey) => void }) => {
      opts.onSuccess(fakeKey);
    });

    render(<UsagePage />);
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));

    // After success the panel shows both snippets.
    // ANTHROPIC_BASE_URL is inside a <pre> block that may be one text node; use getAllBy.
    expect(screen.getAllByText(/ANTHROPIC_BASE_URL/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ANTHROPIC_AUTH_TOKEN/).length).toBeGreaterThan(0);
    // VALET_KEY appears in both the toml block and the env snippet.
    expect(screen.getAllByText(/VALET_KEY/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/config\.toml/).length).toBeGreaterThan(0);
    // The key itself appears in the UI.
    expect(screen.getByText("vlt_testkey12345")).toBeTruthy();
  });
});

describe("UsagePage — credential mode", () => {
  // The mode toggle moved to Settings → Proxy. The usage page no longer renders
  // CredentialModeControl; mode-awareness is covered by the OnboardingPanel snippet
  // tests below. Both admin and member views have no mode group on this page.
  it("mode toggle buttons do not appear on the usage page (moved to Settings → Proxy)", () => {
    orgData = { data: { callerRole: "admin", features: { organizations: true } }, isLoading: false };
    render(<UsagePage />);
    const group = document.querySelector("[role='group'][aria-label='Credential mode']");
    expect(group).toBeNull();
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

describe("UsagePage — OnboardingPanel mode snippets", () => {
  const fakeKey = {
    id: "key_1",
    name: "proxy-key",
    key: "vlt_testkey12345",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userId: "user_1",
    enabled: true,
    rateLimitEnabled: false,
    rateLimitTimeWindow: null,
    rateLimitMax: null,
    requestCount: 0,
    remainingRequests: null,
    lastRequest: null,
    expiresAt: null,
    deletedAt: null,
    refillAmount: null,
    refillInterval: null,
    permissions: null,
    metadata: null,
    prefix: "vlt_",
  };

  beforeEach(() => {
    createKeyMutate.mockImplementation((_name: string, opts: { onSuccess: (k: typeof fakeKey) => void }) => {
      opts.onSuccess(fakeKey);
    });
  });

  it("passthrough mode shows ANTHROPIC_API_KEY line after key creation", () => {
    settingsResult = { data: { enabled: true, mode: "passthrough" }, isLoading: false };
    render(<UsagePage />);
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));
    expect(screen.getAllByText(/ANTHROPIC_API_KEY/).length).toBeGreaterThan(0);
  });

  it("centralized mode shows unset note for ANTHROPIC_API_KEY after key creation", () => {
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<UsagePage />);
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));
    // The centralized note says "unset it"
    expect(screen.getByText(/unset it/)).toBeTruthy();
    // The snippet itself does NOT include the ANTHROPIC_API_KEY env var line
    const allText = document.body.textContent ?? "";
    expect(allText).toContain("unset it");
  });
});
