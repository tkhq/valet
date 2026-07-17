// @vitest-environment jsdom
/**
 * Organization · Sandbox images — base-image catalog CRUD (sandbox images
 * v2 plan, Task 6). Mocks `~/api/settings` the same way
 * `github-app-section.test.tsx` mocks it — these tests only care what the
 * section renders and which mutation it fires.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImageCatalogEntryWire } from "@valet/api/wire";

const createMutate = vi.fn();
const deleteMutate = vi.fn();

let catalogData: { images: ImageCatalogEntryWire[] } | undefined;
let isLoading = false;
let isError = false;

vi.mock("~/api/settings", () => ({
  useImageCatalog: () => ({ data: catalogData, isLoading, error: isError ? new Error("boom") : null }),
  useCreateImageCatalogEntry: () => ({ mutate: createMutate, isPending: false }),
  useDeleteImageCatalogEntry: () => ({ mutate: deleteMutate, isPending: false }),
}));

import { ImageCatalogSection } from "./image-catalog-section";

describe("ImageCatalogSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogData = { images: [] };
    isLoading = false;
    isError = false;
  });

  it("shows a loading spinner", () => {
    isLoading = true;
    render(<ImageCatalogSection />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows failure text on error", () => {
    isError = true;
    render(<ImageCatalogSection />);
    expect(screen.getByText("Failed to load the image catalog.")).toBeTruthy();
  });

  it("lists catalog entries with name, ref, and pull secret badge", () => {
    catalogData = {
      images: [
        {
          id: "img_1",
          orgId: "org_1",
          name: "Node 22",
          ref: "registry.example.com/base:node22",
          pullSecretName: "regcred",
          kind: "base",
          createdAt: Date.now(),
        },
      ],
    };
    render(<ImageCatalogSection />);
    expect(screen.getByText("Node 22")).toBeTruthy();
    expect(screen.getByText("registry.example.com/base:node22")).toBeTruthy();
    expect(screen.getByText("regcred")).toBeTruthy();
  });

  it("creating an entry fires the create mutation with trimmed fields", async () => {
    render(<ImageCatalogSection />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add base image" }));
    await user.type(screen.getByLabelText("Name"), "Node 22");
    await user.type(screen.getByLabelText("Image ref"), "registry.example.com/base:node22");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(createMutate).toHaveBeenCalledWith(
      { name: "Node 22", ref: "registry.example.com/base:node22", pullSecretName: undefined },
      expect.anything(),
    );
  });

  it("deleting an entry requires confirmation then fires the delete mutation", async () => {
    catalogData = {
      images: [
        {
          id: "img_1",
          orgId: "org_1",
          name: "Node 22",
          ref: "registry.example.com/base:node22",
          pullSecretName: null,
          kind: "base",
          createdAt: Date.now(),
        },
      ],
    };
    render(<ImageCatalogSection />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Node 22" }));
    const confirmButton = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(confirmButton);
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith("img_1", expect.anything()));
  });
});
