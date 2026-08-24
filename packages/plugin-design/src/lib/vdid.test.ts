import { describe, expect, it } from "vitest";
import { applyVdids, computeVdid, findByVdid } from "./vdid.js";

describe("vdid addressing", () => {
  it("is deterministic over tag, role, and text prefix", () => {
    const a = computeVdid("h1", "", "Agenda");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(computeVdid("h1", "", "Agenda")).toBe(a);
    expect(computeVdid("h2", "", "Agenda")).not.toBe(a);
  });

  it("stamps addressable elements and leaves stable ids alone", () => {
    const first = applyVdids("<body><h1>Title</h1><p>Body text</p></body>");
    expect(first.report.addressable).toBe(2);
    const h1 = /<h1 data-vdid="([0-9a-f_]+)">/.exec(first.html);
    expect(h1).not.toBeNull();

    // Re-applying over unchanged content regenerates nothing.
    const second = applyVdids(first.html);
    expect(second.report.regenerated).toEqual([]);
    expect(second.html).toBe(first.html);
  });

  it("new elements hash the same regardless of document position", () => {
    const before = applyVdids("<body><h2>Case Study</h2></body>");
    const vdid = /<h2 data-vdid="([0-9a-f_]+)"/.exec(before.html)?.[1];
    const grown = applyVdids("<body><h1>New First Slide</h1><h2>Case Study</h2></body>");
    expect(grown.html).toContain(`<h2 data-vdid="${vdid}"`);
  });

  it("an existing id is preserved even when the element's content changed", () => {
    // Scenario C: an externally edited slide title keeps the id its Slides
    // objectId carried home; re-addressing must not rewrite it.
    const { html, report } = applyVdids('<body><h2 data-vdid="deadbeef00000000">Edited Title</h2><p>New</p></body>');
    expect(html).toContain('data-vdid="deadbeef00000000"');
    expect(report.regenerated).toHaveLength(1); // only the new <p>
  });

  it("suffixes collisions in document order and reports them", () => {
    const { html, report } = applyVdids("<body><p>Same</p><p>Same</p></body>");
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0]).toMatch(/_1$/);
    expect(html.match(/data-vdid=/g)).toHaveLength(2);
  });

  it("re-stamps a DUPLICATED existing id — first claim wins", () => {
    // A copy-pasted slide keeps its source's ids; the copy must get fresh
    // ones or patches and comment anchors silently hit the original.
    const { html } = applyVdids(
      '<body><section data-vdid="aaaa111122223333"><h2>Src</h2></section><section data-vdid="aaaa111122223333"><h2>Copy</h2></section></body>',
    );
    const ids = [...html.matchAll(/<section data-vdid="([0-9a-f_]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("aaaa111122223333");
    expect(ids[1]).not.toBe("aaaa111122223333");
  });

  it("findByVdid returns the element outer HTML", () => {
    const { html } = applyVdids("<body><h1>Find Me</h1></body>");
    const vdid = /data-vdid="([0-9a-f_]+)"/.exec(html)?.[1] ?? "";
    expect(findByVdid(html, vdid)).toContain("Find Me");
    expect(findByVdid(html, "ffffffffffffffff")).toBeNull();
  });
});
