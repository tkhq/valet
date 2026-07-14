import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "./frontmatter";

describe("splitFrontmatter", () => {
  it("parses a full renderConcept-shaped document", () => {
    const raw =
      '---\n' +
      'type: "preference"\n' +
      'title: "Personality"\n' +
      'tags: ["voice", "assistant"]\n' +
      'timestamp: "2026-07-13T00:00:00.000Z"\n' +
      'valet:\n' +
      '  sensitivity: "shareable"\n' +
      '  origin: "user-stated"\n' +
      '---\n' +
      '\n' +
      '# Personality\n\nWarm and direct.\n';

    const { meta, body } = splitFrontmatter(raw);
    expect(meta).toEqual({
      type: "preference",
      tags: ["voice", "assistant"],
      sensitivity: "shareable",
      origin: "user-stated",
    });
    expect(body).toBe("# Personality\n\nWarm and direct.\n");
  });

  it("handles no frontmatter — returns the whole input as body with empty meta", () => {
    const raw = "# Just a doc\n\nNo frontmatter here.\n";
    const { meta, body } = splitFrontmatter(raw);
    expect(meta).toEqual({});
    expect(body).toBe(raw);
  });

  it("does not treat a body-only leading '---' with no closing fence as frontmatter", () => {
    const raw = "---\nThis is just a horizontal rule up top, no closing fence.\n";
    const { meta, body } = splitFrontmatter(raw);
    expect(meta).toEqual({});
    expect(body).toBe(raw);
  });

  it("tolerates a '---' appearing inside the body after a real frontmatter block", () => {
    const raw =
      '---\n' +
      'type: "note"\n' +
      '---\n' +
      '\n' +
      'Above the line.\n\n---\n\nBelow the line.\n';

    const { meta, body } = splitFrontmatter(raw);
    expect(meta.type).toBe("note");
    expect(body).toBe("Above the line.\n\n---\n\nBelow the line.\n");
  });

  it("omits valet fields when absent", () => {
    const raw = '---\ntype: "note"\ntitle: "x"\n---\n\nbody\n';
    const { meta } = splitFrontmatter(raw);
    expect(meta.sensitivity).toBeUndefined();
    expect(meta.origin).toBeUndefined();
    expect(meta.tags).toBeUndefined();
  });

  it("handles an empty string", () => {
    expect(splitFrontmatter("")).toEqual({ meta: {}, body: "" });
  });
});
