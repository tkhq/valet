import { describe, expect, it } from "vitest";
import { isActiveStatus, showsLiveBody } from "./types";
import { statusLabel } from "./tool-shell";
import { writeRenderer } from "./write";
import { bashRenderer } from "./bash";
import { editRenderer } from "./edit";
import { fallbackRenderer } from "./fallback";

describe("streaming tool-call rendering (pure logic)", () => {
  it("write and bash opt in to live args streaming", () => {
    expect(writeRenderer.streamsArgs).toBe(true);
    expect(bashRenderer.streamsArgs).toBe(true);
  });

  it("edit and the fallback hold their body until args are complete", () => {
    expect(editRenderer.streamsArgs).toBeFalsy();
    expect(fallbackRenderer.streamsArgs).toBeFalsy();
  });

  it("showsLiveBody: streaming status renders the body only for opt-in renderers", () => {
    expect(showsLiveBody(writeRenderer, "streaming")).toBe(true);
    expect(showsLiveBody(fallbackRenderer, "streaming")).toBe(false);
  });

  it("showsLiveBody: non-streaming statuses always render the body", () => {
    for (const status of ["running", "completed", "error"] as const) {
      expect(showsLiveBody(fallbackRenderer, status)).toBe(true);
      expect(showsLiveBody(writeRenderer, status)).toBe(true);
    }
  });

  it("statusLabel names the streaming state distinctly", () => {
    expect(statusLabel("streaming")).toBe("writing");
    expect(statusLabel("running")).toBe("running");
    expect(statusLabel("completed")).toBe("done");
    expect(statusLabel("error")).toBe("error");
  });

  it("isActiveStatus covers exactly the in-flight states", () => {
    expect(isActiveStatus("streaming")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("completed")).toBe(false);
    expect(isActiveStatus("error")).toBe(false);
  });

  it("write suppresses its line-count summary while args are streaming", () => {
    // Partial args mid-stream must not surface a churning "+N lines" count.
    expect(
      writeRenderer.formatSummary?.(
        { path: "/tmp/x", content: "a\nb" },
        undefined,
        "streaming",
        "write",
      ),
    ).toBeUndefined();
  });
});
