// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ProxyRequestListItem } from "@valet/api/wire";
import { RequestLog } from "./RequestLog";

describe("team proxy request ownership", () => {
  it("renders a team record with no user and retains request selection", () => {
    const row: ProxyRequestListItem = {
      id: "request-1", createdAt: 1, orgId: "org-1", userId: null, teamId: "team-platform",
      apiKeyId: "shared-key", providerKind: "openai", model: "gpt-4o-mini", harness: "codex",
      endpoint: "/v1/responses", stream: false, statusCode: 200, inputTokens: 1, outputTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.01, latencyMs: 1, error: null,
    };
    const select = vi.fn();
    render(<RequestLog items={[row]} selectedId={null} onSelect={select} />);
    expect(screen.getByTitle("Team team-platform")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(select).toHaveBeenCalledWith("request-1");
  });
});
