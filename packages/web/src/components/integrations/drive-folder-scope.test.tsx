// @vitest-environment jsdom
/**
 * The rule this screen exists to keep visible: no scope allows everything,
 * and a scope holding no folders allows nothing. They are one click apart,
 * so "Allow all of Drive" has to clear the scope (null) rather than save an
 * empty list, and Save must refuse an empty selection.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const saveMutate = vi.fn();
let savedFolderIds: string[] | null = null;
let folders: Array<{ id: string; name: string }> = [];
let listedParents: string[] = [];

vi.mock("~/api/integrations", () => ({
  useDriveFolderScope: () => ({ data: { folderIds: savedFolderIds }, isLoading: false, error: null }),
  useDriveFolders: (_service: string, parentId: string) => {
    listedParents.push(parentId);
    return { data: { parentId, folders }, isLoading: false, error: null };
  },
  useSetDriveFolderScope: () => ({ mutate: saveMutate, reset: vi.fn(), isPending: false, error: null }),
}));

import { DriveFolderScope } from "./drive-folder-scope";

function open() {
  render(<DriveFolderScope service="google_workspace" title="Google Workspace" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Choose which Drive folders Google Workspace may use" }),
  );
}

describe("DriveFolderScope", () => {
  beforeEach(() => {
    saveMutate.mockClear();
    savedFolderIds = null;
    folders = [
      { id: "f1", name: "Finance" },
      { id: "f2", name: "Engineering" },
    ];
    listedParents = [];
  });

  it("says the whole Drive is in reach when no scope is set", () => {
    open();
    expect(screen.getByText("All of your Drive")).toBeTruthy();
  });

  it("counts the folders when a scope is set", () => {
    savedFolderIds = ["f1"];
    open();
    expect(screen.getByText("1 folder")).toBeTruthy();
  });

  it("calls an empty scope out rather than showing it as unrestricted", () => {
    savedFolderIds = [];
    open();
    // The dangerous lookalike: [] denies every file, and reading it as
    // "all of your Drive" would invert the meaning of the setting.
    expect(screen.getByText("No folders — nothing is readable")).toBeTruthy();
    expect(screen.queryByText("All of your Drive")).toBeNull();
  });

  it("saves the picked folders", () => {
    open();
    fireEvent.click(screen.getByLabelText("Finance"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate).toHaveBeenCalledWith(["f1"], expect.anything());
  });

  it("clears the scope instead of saving an empty list", () => {
    savedFolderIds = ["f1"];
    open();
    fireEvent.click(screen.getByRole("button", { name: "Allow all of Drive" }));
    // null removes the restriction. [] would lock the integration out of
    // every file, which is the opposite of what the button says.
    expect(saveMutate).toHaveBeenCalledWith(null, expect.anything());
  });

  it("offers nothing to clear when there is no scope", () => {
    open();
    expect(screen.getByRole("button", { name: "Allow all of Drive" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("refuses to save an empty selection", () => {
    open();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("starts from the saved scope so a save does not drop existing folders", () => {
    savedFolderIds = ["f1"];
    open();
    // The saved list arrives after the popover opens, so seeding only at
    // mount would show an empty selection and silently discard f1 on save.
    expect(screen.getByLabelText("Finance")).toHaveProperty("checked", true);
    fireEvent.click(screen.getByLabelText("Engineering"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate).toHaveBeenCalledWith(["f1", "f2"], expect.anything());
  });

  it("descends into a folder and walks back out through the breadcrumb", () => {
    open();
    expect(listedParents).toContain("root");

    fireEvent.click(screen.getByRole("button", { name: "Open Finance" }));
    expect(listedParents).toContain("f1");

    fireEvent.click(screen.getByRole("button", { name: "My Drive" }));
    expect(listedParents.at(-1)).toBe("root");
  });

  it("keeps a selection made in another folder while browsing", () => {
    open();
    fireEvent.click(screen.getByLabelText("Finance"));
    fireEvent.click(screen.getByRole("button", { name: "Open Engineering" }));

    folders = [{ id: "f3", name: "Backend" }];
    fireEvent.click(screen.getByLabelText("Engineering"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Browsing is not deselecting. A picker that dropped the earlier choice
    // would quietly narrow the scope the person thought they were widening.
    expect(saveMutate).toHaveBeenCalledWith(["f1", "f2"], expect.anything());
  });
});
