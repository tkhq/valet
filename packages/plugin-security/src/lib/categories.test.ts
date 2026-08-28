import { describe, expect, it } from "vitest";
import {
  categoryDigest,
  categoryYaml,
  isKnownCategory,
  KNOWN_CATEGORIES,
  parseCategory,
} from "./categories.js";

const CWE_RE = /^CWE-\d+$/;
const CAPEC_RE = /^CAPEC-\d+$/;

describe("threat-category library", () => {
  it("loads every known category with real threat patterns", () => {
    for (const id of KNOWN_CATEGORIES) {
      const yaml = categoryYaml(id);
      expect(yaml.length).toBeGreaterThan(100);

      const category = parseCategory(id);
      expect(category.id).toBe(id);
      expect(category.name.length).toBeGreaterThan(0);
      expect(category.detectWhen.length).toBeGreaterThan(0);
      expect(category.threatPatterns.length).toBeGreaterThan(0);

      // Every pattern names a description and look_for; at least one pattern
      // per category carries a real CWE id (not a fabricated one).
      let hasCwe = false;
      for (const p of category.threatPatterns) {
        expect(p.description.length).toBeGreaterThan(0);
        expect(p.lookFor.length).toBeGreaterThan(0);
        if (p.cwe !== null) {
          expect(p.cwe).toMatch(CWE_RE);
          hasCwe = true;
        }
        if (p.capec !== null) expect(p.capec).toMatch(CAPEC_RE);
      }
      expect(hasCwe).toBe(true);
    }
  });

  it("parses the authz category's known patterns and CWE/CAPEC ids", () => {
    const authz = parseCategory("authz");
    const ids = authz.threatPatterns.map((p) => p.id);
    expect(ids).toContain("idor");
    const idor = authz.threatPatterns.find((p) => p.id === "idor");
    expect(idor?.cwe).toBe("CWE-639");
    expect(idor?.capec).toBe("CAPEC-122");
  });

  it("categoryDigest names a known authz pattern and a CWE", () => {
    const digest = categoryDigest(["authz"]);
    expect(digest).toContain("Authorization");
    expect(digest).toContain("idor");
    expect(digest).toContain("CWE-639");
    // The digest is compact — one line per pattern with a look-for cue.
    expect(digest).toContain("look for:");
  });

  it("categoryDigest skips unknown ids and returns empty for none known", () => {
    expect(categoryDigest([])).toBe("");
    expect(categoryDigest(["not-a-category"])).toBe("");
    // A mixed list keeps only the known category.
    const mixed = categoryDigest(["not-a-category", "webhooks"]);
    expect(mixed).toContain("Webhooks");
    expect(mixed).not.toContain("not-a-category");
  });

  it("isKnownCategory gates the ids", () => {
    expect(isKnownCategory("authz")).toBe(true);
    expect(isKnownCategory("crypto-wallets")).toBe(true);
    expect(isKnownCategory("nope")).toBe(false);
    expect(isKnownCategory("")).toBe(false);
  });

  it("categoryYaml and parseCategory throw on an unknown id", () => {
    expect(() => categoryYaml("nope")).toThrow(/Unknown threat category/);
    expect(() => parseCategory("nope")).toThrow(/Unknown threat category/);
  });
});
