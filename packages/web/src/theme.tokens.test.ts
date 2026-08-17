/**
 * Completeness check over `theme.css` itself.
 *
 * A palette block that omits one token does not fail loudly. The missing
 * property falls back to whichever other block still matches, which for a
 * palette is its own opposite polarity — dark text on dark paper, or a wash
 * that vanishes — and the result differs between an OS set to light and one
 * set to dark. Neither the type system nor the component tests can see
 * that. This file reads the stylesheet and fails the build instead.
 *
 * It reads the CSS rather than a rendered page on purpose. jsdom neither
 * parses `oklch()` nor resolves a custom property through a cascade, so a
 * DOM-based assertion here would pass on a stylesheet that renders wrong.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PALETTE_CHOICES } from "./lib/theme";

interface Rule {
  /** The block's selectors, split on commas and trimmed. */
  selectors: string[];
  /** The `@media` prelude the block sits in, or null at the top level. */
  media: string | null;
  declarations: Map<string, string>;
}

interface Block {
  label: string;
  scheme: "light" | "dark";
  media: string | null;
  selectors: string[];
}

const CSS = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
const RULES = parseRules(CSS);

/** The reference block: the default palette's light form. Every other block
 * must declare at least what this one does. */
const BASE = RULES.find(
  (rule) => rule.selectors.includes(":root") && rule.declarations.has("--paper"),
);

const REQUIRED_TOKENS = [...(BASE?.declarations.keys() ?? [])].filter((name) =>
  name.startsWith("--"),
);

/**
 * The three blocks every palette needs, with the exact selector list each
 * one must carry. `.palette-swatch` is the Settings → Appearance preview,
 * which paints an unchosen palette from these same tokens — leave its
 * selector out of a block and the picker shows the wrong colors.
 */
function expectedBlocks(palette: string): Block[] {
  const root = palette === "default" ? ":root" : `:root[data-palette="${palette}"]`;
  const swatch = `.palette-swatch[data-palette="${palette}"]`;
  return [
    {
      label: "light",
      scheme: "light",
      media: null,
      selectors: [root, `${root}[data-theme="light"]`, swatch, `${swatch}[data-theme="light"]`],
    },
    {
      label: "dark (OS preference)",
      scheme: "dark",
      media: "(prefers-color-scheme: dark)",
      selectors: [`${root}:not([data-theme="light"])`, `${swatch}:not([data-theme="light"])`],
    },
    {
      label: "dark (explicit)",
      scheme: "dark",
      media: null,
      selectors: [`${root}[data-theme="dark"]`, `${swatch}[data-theme="dark"]`],
    },
  ];
}

/** Finds the one block carrying ALL of `selectors` under `media`. */
function findRule(block: Block): Rule | undefined {
  return RULES.find(
    (rule) =>
      rule.media === block.media &&
      block.selectors.every((selector) => rule.selectors.includes(selector)),
  );
}

describe("theme.css", () => {
  it("has a default light block for every other block to be measured against", () => {
    expect(BASE).toBeDefined();
    // Guards the guard. If the reference block ever loses its washes, every
    // assertion below would keep passing while the app broke.
    expect(REQUIRED_TOKENS).toEqual([
      "--paper",
      "--ink",
      "--muted",
      "--line",
      "--moss",
      "--amber",
      "--ink-wash",
      "--ink-wash-strong",
      "--moss-wash",
      "--moss-wash-strong",
      "--success-wash",
      "--danger-wash",
      "--warning-wash",
      "--warning-fg",
    ]);
  });

  it("pins the default palette to the values an untouched install shows", () => {
    // Nobody opts into the default, so its values are a contract rather
    // than a preference: adding palettes must not repaint it.
    const [light, , dark] = expectedBlocks("default").map(findRule);
    expect(light?.declarations.get("--paper")).toBe("oklch(98.5% 0.002 247)");
    expect(light?.declarations.get("--ink")).toBe("oklch(20.5% 0.006 247)");
    expect(light?.declarations.get("--moss")).toBe("oklch(53.5% 0.190 264)");
    expect(light?.declarations.get("--ink-wash")).toBe("oklch(20.5% 0.006 247 / 0.06)");
    expect(dark?.declarations.get("--paper")).toBe("oklch(13.0% 0.005 247)");
    expect(dark?.declarations.get("--ink")).toBe("oklch(98.5% 0.002 247)");
    expect(dark?.declarations.get("--moss")).toBe("oklch(69.0% 0.150 264)");
    expect(dark?.declarations.get("--ink-wash")).toBe("oklch(98.5% 0.002 247 / 0.08)");
  });

  for (const palette of PALETTE_CHOICES) {
    describe(`palette "${palette}"`, () => {
      for (const block of expectedBlocks(palette)) {
        it(`selects the root and the picker swatch in its ${block.label} block`, () => {
          expect(
            findRule(block),
            `no ${block.label} block matching ${block.selectors.join(", ")}`,
          ).toBeDefined();
        });

        it(`defines every token in its ${block.label} block`, () => {
          const rule = findRule(block);
          const missing = REQUIRED_TOKENS.filter((token) => !rule?.declarations.has(token));
          expect(missing, `"${palette}" ${block.label} drops tokens`).toEqual([]);
        });

        it(`gives every token a value in its ${block.label} block`, () => {
          const rule = findRule(block);
          for (const token of REQUIRED_TOKENS) {
            expect(rule?.declarations.get(token), `${palette} ${block.label} ${token}`).toBeTruthy();
          }
        });

        it(`sets color-scheme in its ${block.label} block`, () => {
          // Without this, native scrollbars and form controls keep the
          // opposite polarity's chrome — a light scrollbar on a dark page.
          expect(findRule(block)?.declarations.get("color-scheme")).toBe(block.scheme);
        });

        it(`keeps every wash on the alpha form in its ${block.label} block`, () => {
          // The opacity-modifier trap, caught at the token: a wash whose
          // value carries no alpha renders as an opaque slab, and one whose
          // alpha was left to a Tailwind `/15` modifier renders as nothing.
          const rule = findRule(block);
          for (const token of REQUIRED_TOKENS.filter(isWash)) {
            expect(
              rule?.declarations.get(token) ?? "",
              `${palette} ${block.label} ${token}`,
            ).toMatch(/\/\s*0?\.\d+\s*\)$/);
          }
        });
      }
    });
  }
});

function isWash(token: string): boolean {
  return token.endsWith("-wash") || token.endsWith("-wash-strong");
}

/**
 * A deliberately small CSS reader: enough for this one stylesheet, which
 * nests at most one level (`@media`). It keeps the check dependency-free —
 * adding a real parser for a single file would be a heavier promise than
 * the check needs.
 */
function parseRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let prelude = "";
  let media: string | null = null;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === "}") {
      // Only an `@media` block's own closing brace reaches here. Rule
      // bodies are consumed whole below, closing brace included.
      media = null;
      prelude = "";
      index += 1;
      continue;
    }

    if (char !== "{") {
      prelude += char;
      index += 1;
      continue;
    }

    const head = prelude.trim();
    prelude = "";
    index += 1;

    if (head.startsWith("@media")) {
      media = head.slice("@media".length).trim();
      continue;
    }

    let depth = 1;
    let body = "";
    while (index < source.length && depth > 0) {
      const inner = source[index];
      if (inner === "{") depth += 1;
      if (inner === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      body += inner;
      index += 1;
    }
    index += 1;

    // `@keyframes` and friends. The body is read above so the scanner stays
    // in step with the braces, but it holds no tokens.
    if (head.startsWith("@")) continue;

    rules.push({
      selectors: head
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean),
      media,
      declarations: parseDeclarations(body),
    });
  }

  return rules;
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const statement of body.split(";")) {
    const colon = statement.indexOf(":");
    if (colon === -1) continue;
    const name = statement.slice(0, colon).trim();
    if (name) declarations.set(name, statement.slice(colon + 1).trim());
  }
  return declarations;
}
