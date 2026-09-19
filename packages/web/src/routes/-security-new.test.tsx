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
    credentials: [],
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
  credentialWarnings: [],
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

import { SecurityNewPage, buildSecurityConfig } from "./security.new";
import { emptyScopeDraft, type ConfigDraft } from "~/components/security/config-form";

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

  it("prefills the config form (Focus step) and the plan editor (Plan step)", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    // Focus and invariants live under Advanced (Part 13 §Section B).
    fireEvent.click(screen.getByText("Advanced"));
    // Step 1 (Focus): the config form is prefilled from the preview.
    await waitFor(() =>
      expect((screen.getByLabelText("Focus (optional)") as HTMLTextAreaElement).value).toBe(
        "the multi-tenant data path",
      ),
    );
    // Advance to the Plan step; the editor shows the 2 seeded steps.
    fireEvent.click(screen.getByRole("button", { name: /Next: Plan/ }));
    const steps = screen.getAllByTestId("plan-step");
    expect(steps).toHaveLength(2);
  });

  it("walks the wizard and Start creates the session with the final config + plan", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    // Focus → Plan → Launch, confirm authorization, then Start.
    fireEvent.click(screen.getByRole("button", { name: /Next: Plan/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next: Launch/ }));
    fireEvent.click(screen.getByLabelText("Confirm authorization"));
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

  it("adds a credential under Advanced and threads it to the create body", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.click(screen.getByRole("button", { name: "Add credential" }));
    fireEvent.change(screen.getByLabelText("Credential 1 label"), {
      target: { value: "admin-login" },
    });
    fireEvent.change(screen.getByLabelText("Credential 1 kind"), {
      target: { value: "password" },
    });
    fireEvent.change(screen.getByLabelText("Credential 1 op:// reference"), {
      target: { value: "op://vault/item/password" },
    });
    fireEvent.change(screen.getByLabelText("Credential 1 env"), {
      target: { value: "ADMIN_PASSWORD" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Next: Plan/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next: Launch/ }));
    fireEvent.click(screen.getByLabelText("Confirm authorization"));
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const body = createMutate.mock.calls[0][0] as CreateSessionRequest;
    expect(body.securityConfig?.credentials).toEqual([
      {
        label: "admin-login",
        env: "ADMIN_PASSWORD",
        reference: "op://vault/item/password",
        kind: "password",
      },
    ]);
    // The row's client-only id (added for stable list keys) never reaches
    // the wire; the setup page strips it before posting.
    expect(body.securityConfig?.credentials?.[0]).not.toHaveProperty("id");
  });

  it("drops an untouched credential row before Start review", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.click(screen.getByRole("button", { name: "Add credential" }));
    // The row is never filled in, so Start review should not send it.

    fireEvent.click(screen.getByRole("button", { name: /Next: Plan/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next: Launch/ }));
    fireEvent.click(screen.getByLabelText("Confirm authorization"));
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const body = createMutate.mock.calls[0][0] as CreateSessionRequest;
    expect(body.securityConfig?.credentials).toEqual([]);
  });
});

/** Add one fully valid credential under Advanced, then walk to the Launch
 * step. Every Launch-step assertion below starts from this state. */
function addCredentialAndReachLaunch() {
  fireEvent.click(screen.getByText("Advanced"));
  fireEvent.click(screen.getByRole("button", { name: "Add credential" }));
  fireEvent.change(screen.getByLabelText("Credential 1 label"), {
    target: { value: "admin-login" },
  });
  fireEvent.change(screen.getByLabelText("Credential 1 op:// reference"), {
    target: { value: "op://Security/Staging admin/password" },
  });
  fireEvent.change(screen.getByLabelText("Credential 1 env"), {
    target: { value: "ADMIN_PASSWORD" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Next: Plan/ }));
  fireEvent.click(screen.getByRole("button", { name: /Next: Launch/ }));
}

describe("SecurityNewPage Launch step", () => {
  it("summarizes each declared credential as label (kind) -> ENV", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    addCredentialAndReachLaunch();

    const row = screen.getByTestId("review-credentials");
    expect(row.textContent).toContain("admin-login (password) -> ADMIN_PASSWORD");
    expect(row.textContent).toContain(
      "Personas see labels and environment variable names only. Values stay in 1Password until a launcher command runs.",
    );
  });

  it("says yes when focus or an invariant is set under Advanced", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    fireEvent.click(screen.getByRole("button", { name: /Next: Plan/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next: Launch/ }));
    expect(screen.getByTestId("launch-advanced-set").textContent).toBe(
      "Focus and invariants set under Advanced: yes",
    );
  });

  it("says no once focus and every invariant are cleared", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.change(screen.getByLabelText("Focus (optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove invariant 1" }));
    fireEvent.click(screen.getByRole("button", { name: /Next: Plan/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next: Launch/ }));
    expect(screen.getByTestId("launch-advanced-set").textContent).toBe(
      "Focus and invariants set under Advanced: no",
    );
  });

  it("hides the request payload until the toggle is opened", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    addCredentialAndReachLaunch();

    const toggle = screen.getByRole("button", { name: "Show request payload" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("launch-payload")).toBeNull();

    fireEvent.click(toggle);
    const payload = screen.getByTestId("launch-payload");
    const parsed = JSON.parse(payload.textContent ?? "{}") as CreateSessionRequest["securityConfig"];
    expect(parsed?.credentials).toEqual([
      {
        label: "admin-login",
        env: "ADMIN_PASSWORD",
        reference: "op://Security/Staging admin/password",
        kind: "password",
      },
    ]);
    expect(screen.getByRole("button", { name: "Hide request payload" })).toBeTruthy();
  });

  it("names the manual fix when the browser offers no clipboard", async () => {
    render(<SecurityNewPage />);
    await screen.findByTestId("config-form");
    addCredentialAndReachLaunch();
    fireEvent.click(screen.getByRole("button", { name: "Show request payload" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(
      screen.getByText("Copy is not available here. Select the text and copy it."),
    ).toBeTruthy();
  });

  it("glosses the live persona names in the launch checklist", async () => {
    previewQueryState.data = {
      ...previewData,
      planCells: [
        ...previewData.planCells,
        { ordinal: 3, persona: "dast", name: "probe", goal: "Probe the API", reads: [], review: false },
        { ordinal: 4, persona: "fuzz", name: "fuzz", goal: "Fuzz the API", reads: [], review: false },
        { ordinal: 5, persona: "exploit", name: "poc", goal: "Prove it", reads: [], review: false },
      ],
    };
    try {
      render(<SecurityNewPage />);
      await screen.findByTestId("config-form");
      fireEvent.click(screen.getByRole("button", { name: /Next: Plan/ }));
      fireEvent.click(screen.getByRole("button", { name: /Next: Launch/ }));
      expect(screen.getByTestId("launch-cred-dast").textContent).toContain(
        "DAST (live web testing)",
      );
      expect(screen.getByTestId("launch-cred-fuzz").textContent).toContain(
        "Fuzz (malformed input testing)",
      );
      expect(screen.getByTestId("launch-cred-exploit").textContent).toContain(
        "Exploit (proof of concept for a confirmed finding)",
      );
    } finally {
      previewQueryState.data = previewData;
    }
  });
});

/**
 * The create mapper on its own. The Launch step renders what this returns and
 * Start review posts what this returns, so its trimming rules are asserted
 * here once instead of through two render paths.
 */
describe("buildSecurityConfig", () => {
  it("trims every field and drops a meta map that keeps nothing", () => {
    const draft: ConfigDraft = {
      focus: "  the token path  ",
      invariants: [
        { id: "i1", text: "  every admin route sits behind requireAdmin  " },
        { id: "i2", text: "   " },
      ],
      categories: ["authz"],
      scope: emptyScopeDraft(),
      credentials: [
        {
          id: "c1",
          label: "  partner  ",
          env: "  PARTNER_KEY  ",
          reference: "  op://v/i/key  ",
          kind: "mtls",
          meta: { certRef: "  op://v/i/cert  " },
        },
        {
          id: "c2",
          label: "blank-meta",
          env: "BLANK",
          reference: "op://v/i/field",
          kind: "password",
          meta: { certRef: "   " },
        },
        { id: "c3", label: "  ", env: "  ", reference: "  ", kind: "password" },
      ],
    };

    const built = buildSecurityConfig(draft);

    expect(built.focus).toBe("the token path");
    expect(built.invariants).toEqual(["every admin route sits behind requireAdmin"]);
    expect(built.categories).toEqual(["authz"]);
    // No host was authored, so no scope override rides on the create.
    expect(built.scope).toBeUndefined();
    // The untouched third row is dropped; the second row's whitespace-only
    // certRef leaves no meta behind rather than an empty object.
    expect(built.credentials).toEqual([
      {
        label: "partner",
        env: "PARTNER_KEY",
        reference: "op://v/i/key",
        kind: "mtls",
        meta: { certRef: "op://v/i/cert" },
      },
      { label: "blank-meta", env: "BLANK", reference: "op://v/i/field", kind: "password" },
    ]);
  });

  it("sends focus null and an empty credential list when nothing is declared", () => {
    const built = buildSecurityConfig({
      focus: "   ",
      invariants: [],
      categories: [],
      scope: emptyScopeDraft(),
      credentials: [],
    });
    expect(built.focus).toBeNull();
    expect(built.credentials).toEqual([]);
  });
});

describe("SecurityNewPage credential warnings", () => {
  it("renders a preview warning on the Focus step", async () => {
    previewQueryState.data = {
      ...previewData,
      credentialWarnings: [
        {
          label: "admin-login",
          message: "Check the vault, item, and field names in 1Password.",
        },
      ],
    };
    try {
      render(<SecurityNewPage />);
      await screen.findByTestId("config-form");
      const box = await screen.findByTestId("credential-warning-admin-login");
      expect(box.textContent).toContain('Credential "admin-login" could not be verified:');
      expect(box.textContent).toContain("Check the vault, item, and field names in 1Password.");
    } finally {
      previewQueryState.data = previewData;
    }
  });
});
