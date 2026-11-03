// @vitest-environment jsdom
/**
 * Organization · Audit log: rows show when, who, what, and the target,
 * newest first as the api returns them; a system change reads "System"; a
 * row expands to show the recorded changes; Load more fetches the next page
 * only when one exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminAuditEventWire } from "@valet/api/wire";

const useAdminAuditLogMock = vi.fn();

vi.mock("~/api/audit-log", () => ({
  useAdminAuditLog: () => useAdminAuditLogMock(),
}));

import { AuditLogSection } from "./audit-log-section";

function event(overrides: Partial<AdminAuditEventWire> = {}): AdminAuditEventWire {
  return {
    id: "aud_1",
    createdAt: 0,
    actorUserId: "u1",
    actorEmail: "admin@example.test",
    action: "llm_provider.create",
    targetType: "llm_provider",
    targetId: "p1",
    targetName: "internal",
    changes: { baseUrl: "http://10.0.0.5/v1" },
    ip: "203.0.113.7",
    userAgent: "curl/8",
    ...overrides,
  };
}

function query(events: AdminAuditEventWire[], extra: Record<string, unknown> = {}) {
  return {
    data: { pages: [{ events, nextCursor: null }] },
    isLoading: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    ...extra,
  };
}

beforeEach(() => {
  useAdminAuditLogMock.mockReset();
});

describe("AuditLogSection", () => {
  it("shows who, what, and the target for each row", () => {
    useAdminAuditLogMock.mockReturnValue(query([
      event(),
      event({ id: "aud_2", actorUserId: null, actorEmail: null, action: "org_member.grant_admin", targetType: "org_member", targetName: "new@example.test" }),
    ]));
    render(<AuditLogSection />);
    expect(screen.getByText("admin@example.test")).toBeTruthy();
    expect(screen.getByText("llm_provider.create")).toBeTruthy();
    expect(screen.getByText("llm_provider: internal")).toBeTruthy();
    expect(screen.getByText("System")).toBeTruthy();
    expect(screen.getByText("org_member: new@example.test")).toBeTruthy();
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("expands a row to show its changes, IP, and user agent", async () => {
    useAdminAuditLogMock.mockReturnValue(query([event()]));
    render(<AuditLogSection />);
    expect(screen.queryByText(/10\.0\.0\.5/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Toggle details for llm_provider.create" }));
    expect(screen.getByText(/10\.0\.0\.5/)).toBeTruthy();
    expect(screen.getByText("203.0.113.7")).toBeTruthy();
    expect(screen.getByText("curl/8")).toBeTruthy();
  });

  it("loads the next page on Load more", async () => {
    const fetchNextPage = vi.fn();
    useAdminAuditLogMock.mockReturnValue(query([event()], { hasNextPage: true, fetchNextPage }));
    render(<AuditLogSection />);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("says when no changes are recorded", () => {
    useAdminAuditLogMock.mockReturnValue(query([]));
    render(<AuditLogSection />);
    expect(screen.getByText("No admin changes are recorded yet.")).toBeTruthy();
  });
});
