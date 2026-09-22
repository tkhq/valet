// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ProxyRequestListItem } from "@valet/api/wire";
import { RequestLog } from "./RequestLog";

describe("proxy request pagination", () => {
  it("shows metadata only and calls page navigation", () => {
    const row: ProxyRequestListItem = {
      id: "request-1", createdAt: 1, orgId: "org-1", userId: null, teamId: "team-platform",
      apiKeyId: "shared-key", providerKind: "openai", model: "gpt-4o-mini", harness: "codex",
      endpoint: "/v1/responses", stream: false, statusCode: 200, inputTokens: 1, outputTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.01, latencyMs: 1, hasError: false,
    };
    const previous = vi.fn();
    const next = vi.fn();
    render(<RequestLog items={[row]} pageNumber={2} pageSize={25} hasPreviousPage hasNextPage onPreviousPage={previous} onNextPage={next} />);
    expect(screen.queryByText("Team team-platform")).toBeNull();
    expect(screen.getByText("Page 2 · 25 requests per page")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});
