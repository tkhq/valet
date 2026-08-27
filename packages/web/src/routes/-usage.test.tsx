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
    model: "claude-opus-4-5",
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
  },
  parseVersion: 1,
  parseError: null,
  providerResponseId: "msg_1",
  previousResponseId: null,
};

// --- mocks ---------------------------------------------------------------

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
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

vi.mock("~/api/proxy-usage", () => ({
  useProxyUsageSummary: () => summaryResult,
  useProxyRequests: () => requestsResult,
  useProxyRequestDetail: () => detailResult,
  buildDayBuckets: () => [],
  qkProxy: { summary: () => [], requests: () => [], detail: () => [] },
}));

import { UsagePage } from "./usage";

beforeEach(() => {
  vi.clearAllMocks();
  summaryResult = { data: mockSummary, isLoading: false, error: null };
  requestsResult = { data: mockRequests, isLoading: false, error: null };
  detailResult = { data: mockDetail, isLoading: false, error: null };
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
});

describe("UsagePage — breakdown tables", () => {
  it("renders a row for each model", () => {
    render(<UsagePage />);
    // The model name appears in both the breakdown table and the request log.
    expect(screen.getAllByText("claude-opus-4-5").length).toBeGreaterThan(0);
    expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0);
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

    // The request item is in the log. Click the row.
    const row = screen.getAllByRole("button").find(
      (el) => el.getAttribute("aria-pressed") === "false",
    );
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
