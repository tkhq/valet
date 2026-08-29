// @vitest-environment jsdom
/**
 * Import/Export follow the workspace switcher: a team export reads the team's
 * corpus and a team import writes into it (owner threaded to the API), and a
 * plain member sees Export but not Import — the same write authority the doc
 * pane enforces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { OwnerFilter } from "~/api/client";

let owner: OwnerFilter | undefined;
vi.mock("~/lib/use-list-owner", () => ({
  useListOwner: () => owner,
}));

let orgCallerRole: "admin" | "member" = "member";
let teamCallerRole: "admin" | "member" | null = "member";
vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: { callerRole: orgCallerRole } }),
  useTeams: () => ({ data: { teams: [{ id: "team_a", callerRole: teamCallerRole }] } }),
}));

// Hoisted so the `vi.mock` factory (itself hoisted above the module body) can
// close over the spies without a temporal-dead-zone error.
const { exportSpy, importSpy } = vi.hoisted(() => ({
  exportSpy: vi.fn(async () => ({ files: {} })),
  importSpy: vi.fn(async () => ({ imported: [], skipped: [], remapped: [], warnings: [] })),
}));
vi.mock("~/api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/api/client")>();
  return { ...original, api: { ...original.api, exportMemory: exportSpy, importMemory: importSpy } };
});

vi.mock("~/lib/download", () => ({ downloadTextFile: vi.fn() }));

import { MemoryImportExport } from "./import-export";

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  owner = undefined;
  orgCallerRole = "member";
  teamCallerRole = "member";
  exportSpy.mockClear();
  importSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MemoryImportExport — workspace scope", () => {
  it("personal scope: Export sends the caller's own owner and Import is available", async () => {
    owner = { ownerType: "user", ownerId: "user-me" };
    renderWithClient(<MemoryImportExport />);

    expect(screen.getByRole("button", { name: /Import/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    expect(exportSpy).toHaveBeenCalledWith({ ownerType: "user", ownerId: "user-me" });
  });

  it("team scope: Export sends the team owner", async () => {
    owner = { ownerType: "team", ownerId: "team_a" };
    renderWithClient(<MemoryImportExport />);

    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    expect(exportSpy).toHaveBeenCalledWith({ ownerType: "team", ownerId: "team_a" });
  });

  it("team scope, non-admin member: Export shows but Import does not (write is admin-only)", () => {
    owner = { ownerType: "team", ownerId: "team_a" };
    orgCallerRole = "member";
    teamCallerRole = "member";
    renderWithClient(<MemoryImportExport />);

    expect(screen.getByRole("button", { name: /Export/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Import/ })).toBeNull();
  });

  it("team scope, team admin: Import is available", () => {
    owner = { ownerType: "team", ownerId: "team_a" };
    teamCallerRole = "admin";
    renderWithClient(<MemoryImportExport />);

    expect(screen.getByRole("button", { name: /Import/ })).toBeTruthy();
  });
});
