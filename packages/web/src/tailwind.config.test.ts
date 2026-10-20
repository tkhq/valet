/**
 * Runs Tailwind with the real config on a few classes. A theme color that
 * cannot take a value Tailwind passes either breaks the whole CSS build or
 * emits no rule, and neither shows up in a component test.
 *
 * The config loads by path, as Tailwind loads it, because its function
 * colors do not fit Tailwind's `Config` type.
 */
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import { describe, expect, it } from "vitest";

const config = loadConfig(fileURLToPath(new URL("../tailwind.config.ts", import.meta.url)));

async function cssFor(classes: string): Promise<string> {
  const plugin = tailwindcss({
    ...config,
    content: [{ raw: `<div class="${classes}"></div>`, extension: "html" }],
  });
  const result = await postcss([plugin]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

describe("tailwind.config", () => {
  // Tailwind passes a numeric opacity of 0 for a gradient's fade-out stop.
  it("builds a gradient stop on a CSS-variable color", async () => {
    const css = await cssFor("bg-gradient-to-t from-paper");
    expect(css).toContain("--tw-gradient-from: var(--paper)");
  });

  it("emits slash opacity on amber and the status washes", async () => {
    const css = await cssFor("bg-amber/10 bg-warning-wash/60");
    expect(css).toContain(".bg-amber\\/10");
    expect(css).toContain("color-mix(in oklch, var(--amber)");
    expect(css).toContain(".bg-warning-wash\\/60");
    expect(css).toContain("color-mix(in oklch, var(--warning-wash)");
  });
});
