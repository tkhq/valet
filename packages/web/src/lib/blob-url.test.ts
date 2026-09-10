import { describe, expect, it } from "vitest";
import { blobUrl } from "./blob-url";

describe("blobUrl", () => {
  it("encodes refs and file segments without turning fragments into URL syntax", () => {
    expect(blobUrl({ repoFullName: "acme/automation", repoRef: "release/v2#ready" }, ".valet/workflows/a #?.yaml", null))
      .toBe("https://github.com/acme/automation/blob/release%2Fv2%23ready/.valet/workflows/a%20%23%3F.yaml");
  });
  it("preserves line links and refuses missing files or refs", () => {
    expect(blobUrl({ repoFullName: "acme/repo", repoRef: "abc" }, "src/a.ts", 42)).toBe("https://github.com/acme/repo/blob/abc/src/a.ts#L42");
    expect(blobUrl({ repoFullName: "acme/repo", repoRef: "" }, "a.ts", null)).toBeNull();
    expect(blobUrl({ repoFullName: "acme/repo", repoRef: "abc" }, null, null)).toBeNull();
  });
});
