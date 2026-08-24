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

  it("id survives unrelated document changes (content-hash, not position)", () => {
    const before = applyVdids("<body><section><h2>Case Study</h2></section></body>");
    const vdid = /data-vdid="([0-9a-f_]+)"><h2/.exec(before.html)?.[1];
    const grown = applyVdids(
      `<body><section><h1>New First Slide</h1></section><section data-vdid="x"><h2>Case Study</h2></section></body>`,
    );
    // The section around Case Study hashes the same regardless of its position.
    expect(grown.html).toContain(`data-vdid="${vdid}"><h2`);
  });

  it("suffixes collisions in document order and reports them", () => {
    const { html, report } = applyVdids("<body><p>Same</p><p>Same</p></body>");
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0]).toMatch(/_1$/);
    expect(html.match(/data-vdid=/g)).toHaveLength(2);
  });

  it("findByVdid returns the element outer HTML", () => {
    const { html } = applyVdids("<body><h1>Find Me</h1></body>");
    const vdid = /data-vdid="([0-9a-f_]+)"/.exec(html)?.[1] ?? "";
    expect(findByVdid(html, vdid)).toContain("Find Me");
    expect(findByVdid(html, "ffffffffffffffff")).toBeNull();
  });
});
