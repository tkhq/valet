import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  renderConcept,
  parseConcept,
  sanitizeBody,
  normalizePath,
  assertWritablePath,
  remapImportPath,
  ReservedPathError,
  type RenderableConcept,
} from "./okf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function baseConcept(overrides: Partial<RenderableConcept> = {}): RenderableConcept {
  return {
    type: "note",
    title: "",
    description: "",
    resource: "",
    tags: [],
    updatedAtMs: Date.parse("2026-07-13T00:00:00.000Z"),
    sensitivity: "private",
    origin: "",
    expiresMs: null,
    extras: {},
    content: "Body text.\n",
    ...overrides,
  };
}

describe("okf serialization", () => {
  describe("round trip", () => {
    it("parseConcept(renderConcept(x)) reproduces x's fields", () => {
      const c = baseConcept({
        title: "My Title",
        description: "A description.",
        resource: "https://example.com/thing",
        tags: ["a", "b", "c"],
        sensitivity: "shareable",
        origin: "user-stated",
        expiresMs: Date.parse("2026-08-01T00:00:00.000Z"),
        extras: { foo: "bar", zebra: "last" },
        content: "# Heading\n\nSome body.\n",
      });
      const rendered = renderConcept(c);
      const parsed = parseConcept(rendered);

      expect(parsed.hasFrontmatter).toBe(true);
      expect(parsed.type).toBe(c.type);
      expect(parsed.title).toBe(c.title);
      expect(parsed.description).toBe(c.description);
      expect(parsed.resource).toBe(c.resource);
      expect(parsed.tags).toEqual(c.tags);
      expect(parsed.timestamp).toBe(new Date(c.updatedAtMs).toISOString());
      expect(parsed.valet.sensitivity).toBe("shareable");
      expect(parsed.valet.origin).toBe("user-stated");
      expect(parsed.valet.expires).toBe(new Date(c.expiresMs as number).toISOString());
      expect(parsed.extras).toEqual(c.extras);
      expect(parsed.body).toBe(c.content);
    });

    it("omits empty optionals and the valet block on plain private notes", () => {
      const c = baseConcept({ content: "plain body\n" });
      const rendered = renderConcept(c);
      expect(rendered).not.toContain("title:");
      expect(rendered).not.toContain("description:");
      expect(rendered).not.toContain("resource:");
      expect(rendered).not.toContain("tags:");
      expect(rendered).not.toContain("valet:");

      const parsed = parseConcept(rendered);
      expect(parsed.title).toBe("");
      expect(parsed.valet).toEqual({});
    });

    it("render-twice produces byte-identical output (idempotent canonicalization)", () => {
      const c = baseConcept({
        title: "Stable",
        tags: ["x", "y"],
        extras: { a: "1", b: "2" },
      });
      const once = renderConcept(c);
      const parsed = parseConcept(once);
      const twice = renderConcept({
        ...c,
        title: parsed.title,
        tags: parsed.tags,
        extras: parsed.extras,
        content: parsed.body,
      });
      expect(twice).toBe(once);
    });
  });

  describe("golden file", () => {
    it("locks emitter output byte-for-byte", () => {
      const golden = readFileSync(join(__dirname, "..", "..", "test", "fixtures", "okf-golden.md"), "utf8");
      const rendered = renderConcept({
        type: "project-note",
        title: "Valet Memory Golden Fixture",
        description: "Locks emitter output across yaml package upgrades.",
        resource: "https://github.com/example/valet",
        tags: ["memory", "okf", "golden"],
        updatedAtMs: Date.parse("2026-07-13T09:30:00.000Z"),
        sensitivity: "shareable",
        origin: "user-stated",
        expiresMs: Date.parse("2026-12-31T00:00:00.000Z"),
        extras: { source: "manual", confidence: "0.90" },
        content: "# Golden Fixture\n\nThis file exists to lock canonical YAML emitter bytes.\n\n- one\n- two\n",
      });
      expect(rendered).toBe(golden);
    });
  });

  describe("adversarial YAML", () => {
    it("survives a colon in the title", () => {
      const c = baseConcept({ title: "Deploy: staging vs prod" });
      const rendered = renderConcept(c);
      const parsed = parseConcept(rendered);
      expect(parsed.title).toBe("Deploy: staging vs prod");
    });

    it("survives quotes and newlines in description", () => {
      const c = baseConcept({ description: 'He said "hi"\nand left.' });
      const rendered = renderConcept(c);
      const parsed = parseConcept(rendered);
      expect(parsed.description).toBe('He said "hi"\nand left.');
    });

    it("survives unicode", () => {
      const c = baseConcept({ title: "日本語 emoji 🎉 café" });
      const rendered = renderConcept(c);
      const parsed = parseConcept(rendered);
      expect(parsed.title).toBe("日本語 emoji 🎉 café");
    });

    it("preserves NO and 1.10 in extras as literal strings, not coerced", () => {
      const c = baseConcept({ extras: { flag: "NO", version: "1.10" } });
      const rendered = renderConcept(c);
      expect(rendered).toContain('flag: "NO"');
      expect(rendered).toContain('version: "1.10"');
      const parsed = parseConcept(rendered);
      expect(parsed.extras.flag).toBe("NO");
      expect(parsed.extras.version).toBe("1.10");
    });

    it("parses foreign NO/1.10 extras written unquoted without coercion", () => {
      const doc = ['---', "type: note", "flag: NO", "version: 1.10", "---", "", "body"].join("\n");
      const parsed = parseConcept(doc);
      expect(parsed.extras.flag).toBe("NO");
      expect(parsed.extras.version).toBe("1.10");
    });

    it("tolerates a body that begins with a markdown horizontal rule (---) with no frontmatter", () => {
      const text = "---\nJust a horizontal rule, no frontmatter here.\n";
      const parsed = parseConcept(text);
      expect(parsed.hasFrontmatter).toBe(false);
      expect(parsed.body).toBe(text);
    });

    it("tolerates junk YAML in the frontmatter position (never throws)", () => {
      const text = "---\n:::not: valid: yaml: at: all:::\n---\n\nbody\n";
      expect(() => parseConcept(text)).not.toThrow();
    });

    it("tolerates missing frontmatter entirely", () => {
      const parsed = parseConcept("just a plain markdown file\nwith no frontmatter\n");
      expect(parsed.hasFrontmatter).toBe(false);
      expect(parsed.type).toBe("");
      expect(parsed.body).toBe("just a plain markdown file\nwith no frontmatter\n");
    });

    it("tolerates frontmatter with no type key", () => {
      const text = "---\ntitle: \"Untyped\"\n---\n\nbody\n";
      const parsed = parseConcept(text);
      expect(parsed.hasFrontmatter).toBe(true);
      expect(parsed.type).toBe("");
      expect(parsed.title).toBe("Untyped");
    });
  });

  describe("unknown valet keys", () => {
    it("drops and reports unknown valet.* sub-keys", () => {
      const text = ["---", "type: note", "valet:", "  sensitivity: private", "  pinned: true", "---", "", "b"].join(
        "\n",
      );
      const parsed = parseConcept(text);
      expect(parsed.valet.sensitivity).toBe("private");
      expect(parsed.droppedValetKeys).toEqual(["valet.pinned"]);
    });
  });

  describe("sanitizeBody", () => {
    it("strips a leading frontmatter block", () => {
      const text = "---\ntype: note\n---\n\nActual body.\n";
      expect(sanitizeBody(text)).toBe("Actual body.\n");
    });

    it("is a no-op when there is no frontmatter", () => {
      const text = "No frontmatter at all.\n";
      expect(sanitizeBody(text)).toBe(text);
    });

    it("leaves a body that only superficially starts with --- alone", () => {
      const text = "---\nnot really frontmatter, just dashes\n";
      expect(sanitizeBody(text)).toBe(text);
    });
  });

  describe("path rules", () => {
    it("normalizePath strips leading slash and collapses doubles", () => {
      expect(normalizePath("/foo//bar")).toBe("foo/bar");
    });

    it("normalizePath rejects .. segments", () => {
      expect(() => normalizePath("foo/../bar")).toThrow(ReservedPathError);
    });

    it("normalizePath rejects colons", () => {
      expect(() => normalizePath("team:1/foo.md")).toThrow(ReservedPathError);
    });

    it("assertWritablePath rejects index.md basename with the spec's remediation", () => {
      expect(() => assertWritablePath("notes/index.md")).toThrow(
        "index.md is auto-generated for directories — use overview.md instead",
      );
    });

    it("assertWritablePath rejects log.md basename with the spec's remediation", () => {
      expect(() => assertWritablePath("projects/log.md")).toThrow(
        "index.md is auto-generated for directories — use overview.md instead",
      );
    });

    it("assertWritablePath rejects lib/ prefix with the spec's remediation", () => {
      expect(() => assertWritablePath("lib/foo.md")).toThrow(
        "lib/ is reserved for mounted libraries — write under notes/ or projects/",
      );
    });

    it("assertWritablePath rejects depth > 5 with the spec's remediation", () => {
      expect(() => assertWritablePath("a/b/c/d/e/f.md")).toThrow(
        "path exceeds 5 levels — flatten under projects/<name>/",
      );
    });

    it("assertWritablePath allows depth == 5", () => {
      expect(() => assertWritablePath("a/b/c/d/e.md")).not.toThrow();
    });

    it("remapImportPath remaps lib/ to imported-lib/ instead of rejecting", () => {
      expect(remapImportPath("lib/foo.md")).toBe("imported-lib/foo.md");
    });

    it("remapImportPath flattens over-deep paths instead of rejecting", () => {
      const remapped = remapImportPath("a/b/c/d/e/f.md");
      expect(remapped.split("/").length).toBeLessThanOrEqual(5);
      expect(remapped.endsWith("f.md")).toBe(true);
    });

    it("remapImportPath renames reserved basenames instead of rejecting", () => {
      expect(remapImportPath("notes/index.md")).toBe("notes/index-imported.md");
      expect(remapImportPath("notes/log.md")).toBe("notes/log-imported.md");
    });

    it('root "graph" is reserved (URL-shadowed by the graph view): writes reject, imports remap', () => {
      expect(() => assertWritablePath("graph")).toThrow(/reserved for the memory graph view/);
      expect(remapImportPath("graph")).toBe("graph-imported");
      // Only the exact root path collides with /memory/graph.
      expect(() => assertWritablePath("graph.md")).not.toThrow();
      expect(() => assertWritablePath("notes/graph")).not.toThrow();
      expect(remapImportPath("notes/graph")).toBe("notes/graph");
    });
  });
});
