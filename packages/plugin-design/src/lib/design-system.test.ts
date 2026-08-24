import { describe, expect, it } from "vitest";
import {
  loadDesignSystem,
  parseDesignTokens,
  parseRootCustomProperties,
  type DesignSystemSource,
} from "./design-system.js";

function sourceOf(files: Record<string, string>): DesignSystemSource {
  return {
    readFile: (path) => Promise.resolve(files[path] ?? null),
  };
}

describe("design token parsing", () => {
  it("accepts a flat map and normalizes leading dashes", () => {
    expect(parseDesignTokens('{"color-primary": "#06c", "--spacing-1": "4px"}')).toEqual({
      "--color-primary": "#06c",
      "--spacing-1": "4px",
    });
  });

  it("accepts a nested tokens container", () => {
    expect(parseDesignTokens('{"tokens": {"font-body": "Inter"}}')).toEqual({
      "--font-body": "Inter",
    });
  });

  it("malformed JSON degrades to empty", () => {
    expect(parseDesignTokens("not json")).toEqual({});
  });

  it("extracts :root custom properties from CSS", () => {
    const css = ":root { --a: 1px; --b: red; }\n.x { color: var(--a); }";
    expect(parseRootCustomProperties(css)).toEqual({ "--a": "1px", "--b": "red" });
  });
});

describe("loadDesignSystem (codebase provider)", () => {
  it("loads tokens and components from repo-root files", async () => {
    const system = await loadDesignSystem(
      sourceOf({
        "design-tokens.json": '{"color-primary": "#0066cc"}',
        "components.index.json": '{"Button": "src/ui/button.tsx"}',
      }),
    );
    expect(system.tokens).toEqual({ "--color-primary": "#0066cc" });
    expect(system.components).toEqual({ Button: "src/ui/button.tsx" });
  });

  it("falls back to CSS scanning when design-tokens.json is absent", async () => {
    const system = await loadDesignSystem(sourceOf({ "src/theme.css": ":root { --x: 1; }" }), {
      cssFallbackPaths: ["src/theme.css"],
    });
    expect(system.tokens).toEqual({ "--x": "1" });
  });

  it("missing files degrade to an empty system", async () => {
    const system = await loadDesignSystem(sourceOf({}));
    expect(system).toEqual({ tokens: {}, components: {} });
  });
});
