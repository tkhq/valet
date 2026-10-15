import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { z } from "zod";
import { applyThreadProjectsOperations, ThreadProjectsConflict, type ThreadProjects, type ThreadProjectsDocument } from "@valet/shared";
import { api, ApiError } from "~/api/client";

const schema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), collapsed: z.boolean() })),
  assignments: z.record(z.string(), z.string()), pinned: z.array(z.string()), grouped: z.boolean(), collapsed: z.boolean(),
});

/** Sidebar component tests use the real hook against the shared operation reducer. */
export function renderWithThreadProjects(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const documents = new Map<string, { document: ThreadProjectsDocument; revision: number }>();
  function get(sessionId: string) {
    let saved = documents.get(sessionId);
    if (!saved) {
      const raw = localStorage.getItem(`valet:thread-projects:user-1:${encodeURIComponent(sessionId)}`);
      const value = raw ? schema.parse(JSON.parse(raw)) : { projects: [], assignments: {}, pinned: [], grouped: true, collapsed: false };
      saved = { document: { value, retiredProjects: [], touchedAssignments: [], touchedPins: [], initialized: true }, revision: 1 };
      documents.set(sessionId, saved);
    }
    return saved;
  }
  for (const sessionId of ["orchestrator:user-1", "team-runtime", "another-runtime"]) {
    const saved = get(sessionId);
    client.setQueryData(["thread-projects", "user-1", sessionId], { value: saved.document.value, revision: saved.revision });
  }
  vi.spyOn(api, "getThreadProjects").mockImplementation(async sessionId => {
    const saved = get(sessionId);
    return structuredClone({ value: saved.document.value, revision: saved.revision });
  });
  vi.spyOn(api, "changeThreadProjects").mockImplementation(async (sessionId, operations) => {
    const saved = get(sessionId);
    try { saved.document = applyThreadProjectsOperations(saved.document, operations); }
    catch (error) {
      if (error instanceof ThreadProjectsConflict) throw new ApiError(409, "Sidebar changed", { error: error.message });
      throw error;
    }
    saved.revision++;
    return structuredClone({ value: saved.document.value, revision: saved.revision });
  });
  return {
    ...render(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> }),
    server: { replace(sessionId: string, value: ThreadProjects) {
      const saved = get(sessionId);
      saved.document.value = value;
      saved.revision++;
    } },
  };
}
