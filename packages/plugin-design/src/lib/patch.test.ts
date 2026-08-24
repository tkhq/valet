import { describe, expect, it } from "vitest";
import { applyElementPatches } from "./patch.js";
import { applyVdids } from "./vdid.js";

const DOC = applyVdids(
  "<body><h1>Launch Day</h1><p>Go live with the new product.</p></body>",
).html;

function vdidOf(html: string, tag: string): string {
  const m = new RegExp(`<${tag} data-vdid="([0-9a-f_]+)"`).exec(html);
  if (!m) throw new Error(`no ${tag} vdid`);
  return m[1];
}

describe("applyElementPatches", () => {
  it("replaces the targeted element and leaves the rest untouched", () => {
    const h1 = vdidOf(DOC, "h1");
    const { html, replaced } = applyElementPatches(DOC, `<h1 data-vdid="${h1}">Launch</h1>`);
    expect(replaced).toEqual([h1]);
    expect(html).toContain(">Launch</h1>");
    expect(html).toContain("Go live with the new product.");
  });

  it("replaces multiple elements in one patch", () => {
    const h1 = vdidOf(DOC, "h1");
    const p = vdidOf(DOC, "p");
    const { replaced } = applyElementPatches(
      DOC,
      `<h1 data-vdid="${h1}">A</h1><p data-vdid="${p}">B</p>`,
    );
    expect(replaced).toEqual([h1, p]);
  });

  it("rejects a patch element without a data-vdid", () => {
    expect(() => applyElementPatches(DOC, "<h1>No id</h1>")).toThrow(/data-vdid/);
  });

  it("rejects an unknown vdid with a corrective message", () => {
    expect(() => applyElementPatches(DOC, '<h1 data-vdid="ffffffffffffffff">X</h1>')).toThrow(
      /Re-read the artifact/,
    );
  });

  it("rejects an empty patch", () => {
    expect(() => applyElementPatches(DOC, "   ")).toThrow(/no elements/);
  });
});
