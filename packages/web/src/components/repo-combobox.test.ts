import { describe, expect, it } from "vitest";
import { parsePublicRepo, repoBaseName, workspaceForRepo } from "./repo-combobox";

describe("parsePublicRepo", () => {
  const expected = { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" };

  it("parses the accepted forms", () => {
    expect(parsePublicRepo("acme/widgets")).toEqual(expected);
    expect(parsePublicRepo("github.com/acme/widgets")).toEqual(expected);
    expect(parsePublicRepo("https://github.com/acme/widgets")).toEqual(expected);
    expect(parsePublicRepo("https://github.com/acme/widgets.git")).toEqual(expected);
    expect(parsePublicRepo("https://github.com/acme/widgets/tree/main")).toEqual(expected);
    expect(parsePublicRepo("git@github.com:acme/widgets.git")).toEqual(expected);
    expect(parsePublicRepo("  acme/widgets  ")).toEqual(expected);
  });

  it("rejects non-repo input", () => {
    expect(parsePublicRepo("")).toBeNull();
    expect(parsePublicRepo("just-a-word")).toBeNull();
    expect(parsePublicRepo("https://example.com/acme/widgets")).toBeNull();
    expect(parsePublicRepo("acme/widgets/extra")).toBeNull();
  });
});

describe("workspaceForRepo", () => {
  it("derives a host path from the repo base name", () => {
    expect(workspaceForRepo("acme/widgets")).toBe("/tmp/valet/workspace/widgets");
    expect(repoBaseName("acme/widgets")).toBe("widgets");
  });
});
