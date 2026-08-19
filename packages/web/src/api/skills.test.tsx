// @vitest-environment jsdom
/**
 * `useSkills` must hold the previous page while the next one loads. Every
 * keystroke in the catalog search box changes the query key, and a key with
 * no cached data reports `isLoading`. The pages unmount the grid — and the
 * search box in it — behind that flag, so without a placeholder the box
 * unmounted and dropped focus after each character.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListSkillsResponse } from "@valet/api/wire";
import type { SkillListQuery } from "./client";

const listSkills = vi.fn();

vi.mock("./client", () => ({
  api: { listSkills: (query: SkillListQuery) => listSkills(query) },
}));

import { useSkills } from "./skills";

const pageA: ListSkillsResponse = {
  skills: [
    { name: "github", origin: "plugin", plugin: "github", takesArgs: false },
    { name: "memory", origin: "plugin", plugin: "memory", takesArgs: false },
  ],
  nextCursor: null,
};

const pageB: ListSkillsResponse = {
  skills: [{ name: "memory", origin: "plugin", plugin: "memory", takesArgs: false }],
  nextCursor: null,
};

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useSkills", () => {
  it("keeps the previous page up while a changed query loads", async () => {
    listSkills.mockResolvedValueOnce(pageA);
    // The second response never resolves inside the test: the assertion is
    // about what shows WHILE it is in flight.
    let resolveB: (value: ListSkillsResponse) => void = () => {};
    listSkills.mockImplementationOnce(
      () => new Promise<ListSkillsResponse>((resolve) => (resolveB = resolve)),
    );

    const wrapper = makeWrapper();
    const { result, rerender } = renderHook((query: SkillListQuery = {}) => useSkills(query), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toEqual(pageA));

    // A keystroke in the search box becomes a new query key.
    rerender({ q: "m" });

    // The old page stays, and the hook does not report a fresh load — the
    // pages unmount the grid (and the focused search box) on `isLoading`.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(pageA);

    resolveB(pageB);
    await waitFor(() => expect(result.current.data).toEqual(pageB));
  });
});
