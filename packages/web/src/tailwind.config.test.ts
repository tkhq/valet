/**
 * Runs Tailwind with the real config on a few classes. A theme color that
 * cannot take a value Tailwind passes either breaks the whole CSS build or
 * emits no rule, and neither shows up in a component test.
 *
 * The config loads by path, as Tailwind loads it, because its function
 * colors do not fit Tailwind's `Config` type.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import resolveConfig from "tailwindcss/resolveConfig";
import { describe, expect, it } from "vitest";

const config = loadConfig(fileURLToPath(new URL("../tailwind.config.ts", import.meta.url)));
const srcRoot = fileURLToPath(new URL(".", import.meta.url));

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

  it("emits the contrast-pair tokens as CSS-variable colors", async () => {
    const css = await cssFor("text-on-moss text-moss-text border-control-border text-danger-text bg-on-moss");
    expect(css).toContain("color: var(--on-moss)");
    expect(css).toContain("color: var(--moss-text)");
    expect(css).toContain("border-color: var(--control-border)");
    expect(css).toContain("color: var(--danger-text)");
    expect(css).toContain("background-color: var(--on-moss)");
  });

  it("takes the neutral and accent scales' hue and chroma from the palette", async () => {
    const css = await cssFor("bg-neutral-100 text-accent-600 ring-accent-500/40");
    // Step 100 keeps its lightness and 0.003 of the default 0.015 chroma.
    expect(css).toContain("oklch(96.7% calc(var(--neutral-c) * 0.003 / 0.015) var(--neutral-h) / var(--tw-bg-opacity, 1))");
    expect(css).toContain("oklch(53.5% calc(var(--accent-c) * 0.19 / 0.19) var(--accent-h) / var(--tw-text-opacity, 1))");
    expect(css).toContain("oklch(60.5% calc(var(--accent-c) * 0.18 / 0.19) var(--accent-h) / 0.4)");
  });

  it("keeps the status ramps fixed in every palette", async () => {
    const css = await cssFor("text-danger-700 bg-success-50");
    expect(css).toContain("color: oklch(46.5% 0.190 27 / var(--tw-text-opacity, 1))");
    expect(css).toContain("background-color: oklch(97.5% 0.025 145 / var(--tw-bg-opacity, 1))");
  });

  it("defines every scale step a class in src names", () => {
    // A class naming a step the scale lacks (`text-danger-700` before the
    // full ramp) emits no rule, so the element silently keeps its parent's
    // color. Comments are skipped: they name missing steps on purpose.
    const colors = resolveConfig(config).theme.colors;
    const scales = new Map<string, Set<string>>();
    for (const [name, value] of Object.entries(colors)) {
      if (value && typeof value === "object") scales.set(name, new Set(Object.keys(value)));
    }
    const pattern = new RegExp(`(?<![\\w])(${[...scales.keys()].join("|")})-(\\d{2,3})(?![\\w-])`, "g");
    const missing = sourceFiles(srcRoot).flatMap((path) => {
      const src = withoutComments(readFileSync(path, "utf8"));
      return [...src.matchAll(pattern)]
        .filter((match) => !scales.get(match[1])?.has(match[2]))
        .map((match) => `${relative(srcRoot, path)}: ${match[0]}`);
    });
    expect([...new Set(missing)]).toEqual([]);
  });

  it("keeps code after a `/*` inside text in the step scan", () => {
    const src = [
      '<code>/admin/*</code> <p className="text-danger-700" />',
      "{/* a JSX comment naming text-danger-950 */}",
      "/** A JSDoc naming text-danger-950. */",
      "// a line comment naming text-danger-950",
    ].join("\n");
    const kept = withoutComments(src);
    expect(kept).toContain('className="text-danger-700"');
    expect(kept).not.toContain("danger-950");
  });

  it("emits slash opacity on amber and the status washes", async () => {
    const css = await cssFor("bg-amber/10 bg-warning-wash/60");
    expect(css).toContain(".bg-amber\\/10");
    expect(css).toContain("color-mix(in oklch, var(--amber)");
    expect(css).toContain(".bg-warning-wash\\/60");
    expect(css).toContain("color-mix(in oklch, var(--warning-wash)");
  });
});

/** The `.ts`, `.tsx` and `.css` files under `dir`, without tests. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Removes block comments and whole-line `//` comments. A block comment must
 * start a line or follow whitespace, `{` or `(`. Without that rule a `/*`
 * inside text, such as the JSX text `/admin/*`, removed real code up to the
 * end of the next comment, and a missing step in that span passed the scan.
 */
function withoutComments(src: string): string {
  return src.replace(/(^|[\s{(])\/\*[^]*?\*\//g, "$1").replace(/^\s*\/\/.*$/gm, "");
}
