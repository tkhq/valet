// @vitest-environment jsdom
import type { ProxyRequestListItem } from "@valet/api/wire";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRequestDateTime } from "~/lib/format-when";
import { RequestLog } from "./RequestLog";

const NOW = new Date(2026, 9, 28, 12, 0, 0);
const TIMESTAMP = new Date(2026, 9, 28, 16, 18, 28).getTime();
const PREVIOUS_YEAR_TIMESTAMP = new Date(2025, 9, 28, 16, 18, 28).getTime();

const item: ProxyRequestListItem = {
  id: "request-1",
  createdAt: TIMESTAMP,
  orgId: "org-1",
  userId: null,
  teamId: "team-platform",
  apiKeyId: "shared-key",
  providerKind: "openai",
  model: "gpt-4o-mini",
  harness: "codex",
  endpoint: "/v1/responses",
  stream: false,
  statusCode: 200,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 15,
  costUsd: 0.01,
  latencyMs: 1,
  hasError: false,
};

describe("proxy request pagination", () => {
  it("shows metadata only and calls page navigation", () => {
    const previous = vi.fn();
    const next = vi.fn();
    render(<RequestLog items={[item]} pageNumber={2} pageSize={25} hasPreviousPage hasNextPage onPreviousPage={previous} onNextPage={next} />);
    expect(screen.queryByText("Team team-platform")).toBeNull();
    expect(screen.getByText("Page 2 · 25 requests per page")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("keeps page controls when a later page has no results", () => {
    const previous = vi.fn();
    const next = vi.fn();
    render(<RequestLog items={[]} pageNumber={2} pageSize={25} hasPreviousPage hasNextPage={false} onPreviousPage={previous} onNextPage={next} />);
    expect(screen.getByText("No requests recorded on this page.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(previous).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("RequestLog date and time", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("shows the local date and time with seconds and omits the current year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const expected = new Date(TIMESTAMP).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    expect(formatRequestDateTime(TIMESTAMP)).toBe(expected);

    render(<RequestLog
      items={[item]}
      pageNumber={1}
      pageSize={25}
      hasPreviousPage={false}
      hasNextPage={false}
      onPreviousPage={() => undefined}
      onNextPage={() => undefined}
    />);
    expect(screen.getByRole("columnheader", { name: "Date / time" })).toBeTruthy();
    expect(screen.getByText(expected).getAttribute("title")).toBe(new Date(TIMESTAMP).toISOString());
  });

  it("includes the year for timestamps outside the current year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const expected = new Date(PREVIOUS_YEAR_TIMESTAMP).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    expect(formatRequestDateTime(PREVIOUS_YEAR_TIMESTAMP)).toBe(expected);
  });

  it("uses the local year near a UTC year boundary", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.useFakeTimers();
    const now = new Date(2026, 0, 1, 0, 30);
    const timestamp = new Date(2025, 11, 31, 23, 30).getTime();
    vi.setSystemTime(now);

    expect(new Date(timestamp).getFullYear()).toBe(2025);
    expect(new Date(timestamp).getUTCFullYear()).toBe(new Date().getUTCFullYear());
    expect(formatRequestDateTime(timestamp)).toBe(new Date(timestamp).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }));
  });

  it("uses a fallback and omits the ISO tooltip for an invalid date", () => {
    expect(formatRequestDateTime(Number.NaN)).toBe("Unknown date");
    render(<RequestLog
      items={[{ ...item, createdAt: Number.NaN }]}
      pageNumber={1}
      pageSize={25}
      hasPreviousPage={false}
      hasNextPage={false}
      onPreviousPage={() => undefined}
      onNextPage={() => undefined}
    />);

    const cell = screen.getByText("Unknown date").closest("td");
    expect(cell?.hasAttribute("title")).toBe(false);
  });
});
