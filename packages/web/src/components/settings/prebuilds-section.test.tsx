// @vitest-environment jsdom
/**
 * Organization · Sandbox images — per-repo prebuild configs (sandbox
 * images v2 plan, Task 6). Mocks `~/api/settings` + `~/api/repos` the same
 * way `github-app-section.test.tsx` / `-new-session-dialog.test.tsx` mock
 * their API layers — these tests only care what the section renders and
 * which mutation it fires.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  GetPrebuildsMetaResponse,
  GetReposResponse,
  ListImageCatalogResponse,
  ListPrebuildBuildsResponse,
  ListPrebuildConfigsResponse,
} from "@valet/api/wire";
import { ApiError } from "~/api/client";

const createConfigMutate = vi.fn();
const patchConfigMutate = vi.fn();
const deleteConfigMutate = vi.fn();
const rebuildMutate = vi.fn();

let metaData: GetPrebuildsMetaResponse | undefined;
let configsData: ListPrebuildConfigsResponse | undefined;
let catalogData: ListImageCatalogResponse | undefined;
let buildsData: ListPrebuildBuildsResponse = { builds: [] };
let reposData: GetReposResponse = { repos: [], connected: true, installed: true };
let configsLoading = false;
let configsError = false;

vi.mock("~/api/settings", () => ({
  usePrebuildsMeta: () => ({ data: metaData, isLoading: false, error: null }),
  usePrebuildConfigs: () => ({ data: configsData, isLoading: configsLoading, error: configsError ? new Error("boom") : null }),
  useImageCatalog: () => ({ data: catalogData, isLoading: false, error: null }),
  useCreatePrebuildConfig: () => ({ mutate: createConfigMutate, isPending: false }),
  usePatchPrebuildConfig: () => ({ mutate: patchConfigMutate, isPending: false }),
  useDeletePrebuildConfig: () => ({ mutate: deleteConfigMutate, isPending: false }),
  useRebuildPrebuildConfig: () => ({ mutate: rebuildMutate, isPending: false }),
  usePrebuildBuilds: () => ({ data: buildsData, isLoading: false, error: null }),
}));

vi.mock("~/api/repos", () => ({
  useRepos: () => ({ data: reposData, isLoading: false, error: null }),
}));

import { PrebuildsSection } from "./prebuilds-section";

describe("PrebuildsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metaData = { builder: "docker" };
    configsData = { configs: [] };
    catalogData = { images: [] };
    buildsData = { builds: [] };
    reposData = { repos: [], connected: true, installed: true };
    configsLoading = false;
    configsError = false;
  });

  it("shows the builder-absent banner when meta.builder is null", () => {
    metaData = { builder: null };
    render(<PrebuildsSection />);
    expect(screen.getByText("Prebuilds are unavailable on this deployment")).toBeTruthy();
  });

  it("no banner when a builder is wired", () => {
    metaData = { builder: "docker" };
    render(<PrebuildsSection />);
    expect(screen.queryByText("Prebuilds are unavailable on this deployment")).toBeNull();
  });

  it("shows a loading spinner for configs", () => {
    configsLoading = true;
    configsData = undefined;
    render(<PrebuildsSection />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows failure text on configs error", () => {
    configsError = true;
    configsData = undefined;
    render(<PrebuildsSection />);
    expect(screen.getByText("Failed to load prebuild configs.")).toBeTruthy();
  });

  it("renders a config card with repo name, enabled switch, and schedule toggle", () => {
    configsData = {
      configs: [
        {
          id: "pbc_1",
          orgId: "org_1",
          repoHost: "github",
          repoFullName: "acme/widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
          baseImageId: null,
          schedule: "nightly",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    render(<PrebuildsSection />);
    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(screen.getByLabelText("Enable prebuilds for acme/widgets")).toBeTruthy();
    expect(screen.getByLabelText("Nightly rebuilds for acme/widgets")).toBeTruthy();
  });

  it("Rebuild now fires the rebuild mutation", () => {
    configsData = {
      configs: [
        {
          id: "pbc_1",
          orgId: "org_1",
          repoHost: "github",
          repoFullName: "acme/widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
          baseImageId: null,
          schedule: "nightly",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    render(<PrebuildsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild now" }));
    expect(rebuildMutate).toHaveBeenCalledWith("pbc_1", expect.anything());
  });

  it("Rebuild now surfaces a 409 builder-absent error verbatim", () => {
    configsData = {
      configs: [
        {
          id: "pbc_1",
          orgId: "org_1",
          repoHost: "github",
          repoFullName: "acme/widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
          baseImageId: null,
          schedule: "nightly",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    rebuildMutate.mockImplementation((_id, opts) => {
      opts.onError(
        new ApiError(409, "POST ... -> 409", { error: "prebuilds are unavailable on this deployment" }),
      );
    });
    render(<PrebuildsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild now" }));
    expect(screen.getByText("prebuilds are unavailable on this deployment")).toBeTruthy();
  });

  it("renders build history with status chips and expandable details", async () => {
    configsData = {
      configs: [
        {
          id: "pbc_1",
          orgId: "org_1",
          repoHost: "github",
          repoFullName: "acme/widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
          baseImageId: null,
          schedule: "nightly",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    buildsData = {
      builds: [
        {
          id: "pb_1",
          configId: "pbc_1",
          commitSha: "abcdef1234567",
          imageRef: "registry.local/widgets:abcdef1",
          status: "failed",
          builderBackend: "docker",
          error: "build step 3 failed",
          logTail: "some log output",
          startedAt: 1000,
          finishedAt: 2000,
          createdAt: 1000,
        },
      ],
    };
    render(<PrebuildsSection />);
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("abcdef1")).toBeTruthy();

    const user = userEvent.setup();
    expect(screen.queryByText("build step 3 failed")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("build step 3 failed")).toBeTruthy();
    expect(screen.getByText("some log output")).toBeTruthy();
  });

  it("creating a config from the repo picker fires the create mutation", async () => {
    reposData = {
      repos: [
        {
          fullName: "acme/new-repo",
          url: "https://github.com/acme/new-repo",
          cloneUrl: "https://github.com/acme/new-repo.git",
          defaultBranch: "main",
          private: false,
        },
      ],
      connected: true,
      installed: true,
    };
    render(<PrebuildsSection />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: /search repositories to add a prebuild config/i }));
    await user.click(screen.getByRole("option", { name: /acme\/new-repo/i }));

    await waitFor(() =>
      expect(createConfigMutate).toHaveBeenCalledWith(
        {
          repoFullName: "acme/new-repo",
          cloneUrl: "https://github.com/acme/new-repo.git",
          repoHost: "github",
        },
        expect.anything(),
      ),
    );
  });
});
