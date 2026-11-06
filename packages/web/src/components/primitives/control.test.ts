import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { FOCUS_RING } from "./control";
import { RadioCard } from "./radio-card";
import { Switch } from "./switch";

// Controls in one row had five different heights because call sites styled
// their own buttons and fields, or overrode a primitive's height. These checks
// keep height in the primitives' `size` prop.
const srcRoot = join(__dirname, "..", "..");

/** A raw control that must stay raw, with the reason. Keyed by `file:element`. */
const RAW_ALLOWED: Record<string, string> = {
  "components/security/engagement-panel.tsx:select": "The borderless section picker is the page headline, not a form field.",
  "components/session/model-picker.tsx:input": "The borderless search line at the top of the model menu.",
  "components/session/thread-tree.tsx:input": "The borderless search line of the thread search dialog.",
  "routes/workflows.$workflowId.tsx:input": "The workflow name is an editable page title in heading type.",
};

/** A primitive whose className sets its height on purpose, with the reason. Keyed by file. */
const OVERRIDE_ALLOWED: Record<string, string> = {
  "components/session/browser/browser-overlay.tsx": "The floating preview keeps 44px touch targets in its fixed 48px header.",
  "components/session/composer.tsx": "The composer's round buttons match its 44px input.",
  "components/layout/top-nav.tsx": "The phone layout's menu button keeps a 44px target until md, where the desktop bar replaces it.",
  "components/presence/editor/do-section.tsx": "An inline text action sits in the line of text under its field.",
  "components/presence/editor/name-section.tsx": "An inline text action sits in the line of text under its field.",
  "components/presence/editor/section.tsx": "The Change action sits on the baseline of the section's sentence.",
  "components/presence/editor/when-section.tsx": "The add-condition action sits on the baseline of the condition chips.",
  "components/presence/place-row.tsx": "The overflow menu button lines up with the place name's first line.",
  "components/presence/presence-line.tsx": "Inline text actions sit in the line's status sentence.",
  "components/presence/routine-row.tsx": "Inline text actions sit in the routine's row of text.",
  "components/session/thread-plan.tsx": "The task card's header holds two lines, the task and its status, so it grows past a control's height.",
};

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "number", "date", "month", "password", "tel", "time", "datetime-local"]);
const SIZE_CLASS = /(?<![\w-])(?:[a-z-]+:)*(?:h-(?:\d+|\[[^\]]+\])|min-h-\d+|py-[\d.]+|text-(?:xs|sm|base|\[\d+px\]))(?![\w-])/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "primitives" || entry.name === "dev" ? [] : sourceFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

/** Each opening tag of `name` in `src`, read up to the `>` outside braces. */
function openingTags(src: string, name: string): string[] {
  const tags: string[] = [];
  const pattern = new RegExp(`<${name}\\b`, "g");
  for (let match = pattern.exec(src); match; match = pattern.exec(src)) {
    let depth = 0;
    let end = match.index;
    for (; end < src.length; end++) {
      const char = src[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }
    tags.push(src.slice(match.index, end + 1));
  }
  return tags;
}

function className(tag: string): string {
  return /className=("[^"]*"|\{[^]*?\}(?=\s+[\w-]+=|\s*\/?>))/.exec(tag)?.[1] ?? "";
}

// Comments may name an element, such as a doc comment that mentions `<select>`.
const withoutComments = (src: string) => src.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const files = sourceFiles(srcRoot).map((path) => ({ file: relative(srcRoot, path), src: withoutComments(readFileSync(path, "utf8")) }));

describe("control sizes", () => {
  it("uses Select and Input instead of a raw select or text input", () => {
    const found = files.flatMap(({ file, src }) => [
      ...openingTags(src, "select").map(() => `${file}:select`),
      ...openingTags(src, "input")
        .filter((tag) => TEXT_INPUT_TYPES.has(/\btype="([\w-]+)"/.exec(tag)?.[1] ?? ""))
        .map(() => `${file}:input`),
    ]);
    expect([...new Set(found)].filter((key) => !(key in RAW_ALLOWED))).toEqual([]);
    expect(Object.keys(RAW_ALLOWED).filter((key) => !found.includes(key))).toEqual([]);
  });

  it("uses TabBar and RadioCard instead of a raw tab or radio card", () => {
    const found = files.flatMap(({ file, src }) =>
      [...src.matchAll(/(?<=\s)role="(tab|radio)"/g)].map((match) => `${file}:${match[1]}`));
    expect([...new Set(found)]).toEqual([]);
  });

  it("takes a control's height from its size prop", () => {
    const found = files.flatMap(({ file, src }) =>
      ["Button", "Input", "Select"].flatMap((name) => openingTags(src, name))
        .filter((tag) => SIZE_CLASS.test(className(tag)))
        .map(() => file));
    expect([...new Set(found)].filter((file) => !(file in OVERRIDE_ALLOWED))).toEqual([]);
    expect(Object.keys(OVERRIDE_ALLOWED).filter((file) => !found.includes(file))).toEqual([]);
  });
});

/** The root element's attributes in server-rendered markup, by name. */
function rootAttributes(html: string): Record<string, string> {
  const tag = /^<\w+([^>]*)>/.exec(html)?.[1] ?? "";
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

const classesOf = (html: string) => (rootAttributes(html).class ?? "").split(/\s+/);
const noop = () => {};

describe("focus ring", () => {
  // The grey `ring-neutral-400` on the secondary and ghost buttons measured
  // 2.49:1 on the page, under the 3:1 floor for a focus indicator.
  const ring = FOCUS_RING.split(" ");
  const strayRings = (classes: string[]) =>
    classes.filter((name) => /^focus-visible:ring-(?!2$|inset$|offset-)/.test(name) && !ring.includes(name));

  for (const variant of ["primary", "secondary", "ghost", "danger"] as const) {
    it(`draws the one moss focus ring on a ${variant} Button`, () => {
      const html = renderToStaticMarkup(createElement(Button, { variant }, "Save"));
      expect(html).toContain(">Save</button>");
      expect(classesOf(html)).toEqual(expect.arrayContaining(ring));
      expect(strayRings(classesOf(html))).toEqual([]);
    });
  }

  it("draws it on Switch, Checkbox, and RadioCard", () => {
    const controls = [
      createElement(Switch, { checked: false, onCheckedChange: noop, "aria-label": "Alerts" }),
      createElement(Checkbox, { checked: true, onCheckedChange: noop, "aria-label": "Platform" }),
      createElement(RadioCard, { title: "Dark", description: "Low-glare surfaces.", selected: true, onSelect: noop }),
    ];
    for (const control of controls) {
      const html = renderToStaticMarkup(control);
      expect(classesOf(html)).toEqual(expect.arrayContaining(ring));
      expect(strayRings(classesOf(html))).toEqual([]);
    }
  });
});

describe("Button size iconSm", () => {
  it("is a 32px square on desktop and 44px on a phone or a coarse pointer", () => {
    const html = renderToStaticMarkup(createElement(Button, { size: "iconSm", "aria-label": "Copy output" }, "x"));
    expect(rootAttributes(html)["aria-label"]).toBe("Copy output");
    expect(rootAttributes(html).type).toBe("button");
    expect(classesOf(html)).toEqual(
      expect.arrayContaining(["h-8", "w-8", "p-0", "max-md:size-11", "[@media(pointer:coarse)]:size-11"]),
    );
  });
});

describe("Button primary", () => {
  it("pairs the moss fill with the on-moss text token", () => {
    const classes = classesOf(renderToStaticMarkup(createElement(Button, null, "Approve")));
    expect(classes).toEqual(expect.arrayContaining(["bg-moss", "text-on-moss"]));
    expect(classes).not.toContain("text-white");
  });
});
