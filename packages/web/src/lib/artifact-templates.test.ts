// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { artifactTemplates } from "./artifact-templates";

describe("artifact template source", () => {
  it("starts a document with a project brief the assistant can refine", () => {
    const template = artifactTemplates.find((item) => item.id === "document");
    expect(template).toBeDefined();
    const source = template?.build("Launch brief");
    expect(source?.format).toBe("markdown");
    expect(source?.title).toBe("Launch brief");
    expect(source?.content).toContain("# Launch brief");
    expect(source?.content).toContain("## Problem");
    expect(source?.content).toContain("## Approach");
    expect(source?.content).toContain("## Next steps");
    expect(source?.content).toContain("1. ");
  });

  it("starts a styled HTML page with stable selectable content and no remote assets", () => {
    const template = artifactTemplates.find((item) => item.id === "html-page");
    const source = template?.build('Launch <script>alert("x")</script>');
    expect(source?.format).toBe("html");
    const page = new DOMParser().parseFromString(source?.content ?? "", "text/html");
    expect(page.querySelector("h1")?.textContent).toBe('Launch <script>alert("x")</script>');
    expect(page.querySelector("script")).toBeNull();
    expect(page.querySelector("[src], link[href]")).toBeNull();
    expect(page.querySelector("style")?.textContent).toContain("var(--artifact-bg");
    expect(page.querySelector("style")?.textContent).toContain("var(--artifact-fg");
    const ids = [...page.querySelectorAll("[data-vdid]")].map((element) => element.getAttribute("data-vdid"));
    expect(ids).toContain("page-title");
    expect(ids).toContain("problem-copy");
    expect(ids).toContain("approach-copy");
    expect(new Set(ids).size).toBe(ids.length);
    expect(page.querySelector("meta[name=viewport]")).toBeTruthy();
  });
});
