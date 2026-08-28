// @vitest-environment jsdom
/**
 * `/security/new` setup page (valet-security design §Web Surfaces, Deviations):
 * it fetches a read-only preview on mount, prefills the config form + plan
 * editor, and Start review creates the session with the FINAL config + plan and
 * navigates to it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CreateSessionRequest, SecurityPreviewResponse } from "@valet/api/wire";

const previewData: SecurityPreviewResponse = {
  config: {
    focus: "the multi-tenant data path",
    invariants: ["every admin route sits behind requireAdmin"],
    categories: ["authz"],
    authorizedScope: null,
    configTools: null,
    hasRepoConfig: true,
  },
  planCells: [
    { ordinal: 1, persona: "code-review", name: "recon", goal: "Map the tree", reads: [], review: false },
    {
      ordinal: 2,
      persona: "code-review",
      name: "authz",
      goal: "Sweep authz",
      playbook: "authz",
      reads: [1],
      review: false,
      triad: true,
    },
  ],
};

// The preview is a query, not a mutation: the hook returns the resolved data
// and the query flags. The page seeds its editors from `data` on arrival.
const previewQueryState = {
  data: previewData,
  isLoading: false,
  isError: false,
  isSuccess: true,
  error: null as Error | null,
};
const useSecurityPreviewMock = vi.fn(
  (_body: unknown, _enabled: boolean) => previewQueryState,
);

const createMutate = vi.fn(
  (_vars: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) => {
    opts?.onSuccess?.({ id: "s_created" });
  },
);
const createState = { mutate: createMutate, isPending: false, isError: false, error: null as Error | null };

const navigate = vi.fn();
const searchValue: Record<string, string> = {
  repo: "acme/site",
  cloneUrl: "https://github.com/acme/site.git",
  preset: "code-review",
  model: "claude-sonnet-4-6",
};

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => searchValue,
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/security", () => ({
  useSecurityPreview: (body: unknown, enabled: boolean) => useSecurityPreviewMock(body, enabled),
}));

vi.mock("~/api/queries", () => ({
  useCreateSession: () => createState,
}));

import { SecurityNewPage } from "./security.new";

beforeEach(() => {
  useSecurityPreviewMock.mockClear();
  createMutate.mockClear();
  navigate.mockClear();
});

describe("SecurityNewPage", () => {
  it("queries the preview with the repo + preset, enabled once a repo is set", () => {
    render(<SecurityNewPage />);
    expect(useSecurityPreviewMock).toHaveBeenCalled();
    const [body, enabled] = useSecurityPreviewMock.mock.calls[0];
    expect(body).toMatchObject({ repo: "acme/site", preset: "code-review" });
    expect(enabled).toBe(true);
  });

  it("prefills the config form and plan editor from the preview", async () => {
    render(<SecurityNewPage />);
    await waitFor(() =>
      expect((screen.getByLabelText("Focus (optional)") as HTMLTextAreaElement).value).toBe(
        "the multi-tenant data path",
      ),
    );
    const steps = screen.getAllByTestId("plan-step");
    expect(steps).toHaveLength(2);
  });

  it("Start review creates the session with the final config + plan and navigates", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const body = createMutate.mock.calls[0][0] as CreateSessionRequest;
    expect(body.kind).toBe("security");
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.repo).toMatchObject({ fullName: "acme/site" });
    expect(body.securityConfig).toMatchObject({
      focus: "the multi-tenant data path",
      invariants: ["every admin route sits behind requireAdmin"],
      categories: ["authz"],
    });
    // The edited plan rides on the create body, with the triad flag preserved.
    expect(body.planCells).toHaveLength(2);
    expect(body.planCells?.[1]).toMatchObject({ goal: "Sweep authz", triad: true });

    expect(navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "s_created" },
    });
  });
});
