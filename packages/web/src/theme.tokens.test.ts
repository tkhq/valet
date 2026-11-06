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
      "--muted-wash",
      "--success-wash",
      "--danger-wash",
      "--warning-wash",
      "--warning-fg",
      "--on-moss",
      "--moss-text",
      "--control-border",
      "--danger-text",
      "--neutral-h",
      "--neutral-c",
      "--accent-h",
      "--accent-c",
    ]);
  });

  it("gives native checkboxes and radios the moss accent", () => {
    const root = RULES.find(
      (rule) => rule.media === null && rule.selectors.length === 1 && rule.selectors[0] === ":root" && rule.declarations.has("accent-color"),
    );
    expect(root?.declarations.get("accent-color")).toBe("var(--moss)");
  });

  it("pins the default muted text to its contrast-checked values", () => {
    const [light, osDark, dark] = expectedBlocks("default").map(findRule);
    expect(light?.declarations.get("--muted")).toBe("oklch(50.0% 0.015 247)");
    expect(osDark?.declarations.get("--muted")).toBe("oklch(62.0% 0.015 247)");
    expect(dark?.declarations.get("--muted")).toBe("oklch(62.0% 0.015 247)");
    expect(light?.declarations.get("--on-moss")).toBe("#fff");
    expect(dark?.declarations.get("--on-moss")).toBe("oklch(13.0% 0.005 247)");
    // The default moss measures 4.496:1 on its own wash, so light text is
    // one point darker. Dark moss passes and stays `var(--moss)`.
    expect(light?.declarations.get("--moss-text")).toBe("oklch(52.5% 0.190 264)");
    expect(dark?.declarations.get("--moss-text")).toBe("var(--moss)");
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

        it(`reads its scale hue and chroma from the palette in its ${block.label} block`, () => {
          // The `neutral` and `accent` Tailwind scales multiply these, so a
          // wrong pair repaints every `bg-neutral-*` and `text-accent-*`.
          const rule = findRule(block);
          const scale = SCALES[palette];
          expect(rule?.declarations.get("--neutral-h")).toBe(scale.neutral[0]);
          expect(rule?.declarations.get("--neutral-c")).toBe(scale.neutral[1]);
          expect(rule?.declarations.get("--accent-h")).toBe(scale.accent[0]);
          expect(rule?.declarations.get("--accent-c")).toBe(scale.accent[1]);
        });

        it(`keeps --muted-wash on the L/C/H of --muted in its ${block.label} block`, () => {
          const rule = findRule(block);
          const muted = rule?.declarations.get("--muted") ?? "";
          expect(rule?.declarations.get("--muted-wash")).toBe(muted.replace(/\)$/, " / 0.5)"));
        });

        describe(`contrast in its ${block.label} block`, () => {
          // WCAG 2.2: 4.5:1 for text (1.4.3), 3:1 for a control's outline
          // and an off switch's thumb (1.4.11). The washes are translucent,
          // so each one is laid over `--paper` first, as the browser paints
          // it. `--moss-wash` is the fill of a selected `RadioCard`, and
          // `--ink-wash-strong` is the track of an off `Switch`.
          const rule = findRule(block);
          const color = (token: string) => resolveColor(rule?.declarations ?? new Map(), token);
          const paper = () => color("--paper");
          const onPaper = (wash: string) => () => over(color(wash), paper());
          const cases: [string, () => Rgba, () => Rgba, number][] = [
            ["--on-moss on --moss", () => color("--on-moss"), () => color("--moss"), 4.5],
            ["--moss-text on --paper", () => color("--moss-text"), paper, 4.5],
            ["--moss-text on --moss-wash", () => color("--moss-text"), onPaper("--moss-wash"), 4.5],
            ["--muted on --paper", () => color("--muted"), paper, 4.5],
            ["--muted on --ink-wash", () => color("--muted"), onPaper("--ink-wash"), 4.5],
            ["--muted on --moss-wash", () => color("--muted"), onPaper("--moss-wash"), 4.5],
            ["--danger-text on --paper", () => color("--danger-text"), paper, 4.5],
            ["--control-border on --paper", () => color("--control-border"), paper, 3],
            ["--control-border on --ink-wash-strong", () => color("--control-border"), onPaper("--ink-wash-strong"), 3],
          ];
          for (const [name, fg, bg, floor] of cases) {
            it(`${name} is at least ${floor}:1`, () => {
              expect(contrastRatio(fg(), bg())).toBeGreaterThanOrEqual(floor);
            });
          }
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

/** The `[hue, chroma]` each palette gives the `neutral` and `accent` scales. */
const SCALES: Record<string, { neutral: [string, string]; accent: [string, string] }> = {
  default: { neutral: ["247", "0.015"], accent: ["264", "0.19"] },
  ember: { neutral: ["65", "0.030"], accent: ["45", "0.15"] },
  tide: { neutral: ["210", "0.028"], accent: ["195", "0.115"] },
  orchid: { neutral: ["325", "0.030"], accent: ["330", "0.17"] },
};

/** A color in gamma-encoded sRGB, each channel 0 to 1, with its alpha. */
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Reads a token's value as a color. It follows `var(--x)` to another token
 * in the same block, and reads `#rgb`, `#rrggbb`, and `oklch(L% C H / a)`,
 * the only forms `theme.css` uses. Anything else fails the test, so a new
 * form cannot pass unmeasured.
 */
function resolveColor(declarations: Map<string, string>, token: string, seen: string[] = []): Rgba {
  const value = declarations.get(token);
  if (value === undefined) throw new Error(`${token} is not declared`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference) {
    if (seen.includes(reference[1])) throw new Error(`${token} refers to itself`);
    return resolveColor(declarations, reference[1], [...seen, token]);
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit) : hex[1].match(/../g) ?? [];
    const [r, g, b] = digits.map((pair) => parseInt(pair, 16) / 255);
    return { r, g, b, a: 1 };
  }
  const oklch = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  if (oklch) {
    const [r, g, b] = oklchToSrgb(Number(oklch[1]) / 100, Number(oklch[2]), Number(oklch[3]));
    return { r, g, b, a: oklch[4] === undefined ? 1 : Number(oklch[4]) };
  }
  throw new Error(`${token} has a value the contrast check cannot read: ${value}`);
}

/**
 * OKLCH to gamma-encoded sRGB, clipped to the sRGB gamut. The matrices are
 * from the OKLab definition: https://bottosson.github.io/posts/oklab/
 */
function oklchToSrgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const angle = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(angle);
  const b = chroma * Math.sin(angle);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const [r, g, bl] = linear.map((channel) => {
    const clipped = Math.min(1, Math.max(0, channel));
    return clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
  });
  return [r, g, bl];
}

/** Paints a translucent color over an opaque one, in sRGB as browsers do. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (upper: number, lower: number) => upper * top.a + lower * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** The WCAG 2.2 contrast ratio of two opaque colors. */
function contrastRatio(first: Rgba, second: Rgba): number {
  const luminance = ({ r, g, b }: Rgba) => {
    const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

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
