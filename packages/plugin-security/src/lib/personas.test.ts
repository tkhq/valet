import { describe, expect, it } from "vitest";
import {
  ATTACK_TREE_PERSONA,
  bundledPersona,
  BUNDLED_PERSONAS,
  bundledPersonaIds,
  CODE_REVIEW_PERSONA,
  SAST_PERSONA,
  THREAT_MODEL_PERSONA,
} from "./personas.js";

describe("BUNDLED_PERSONAS", () => {
  it("registers the code-review, triad, and M-P2c model personas", () => {
    expect(bundledPersonaIds()).toEqual([
      "code-review",
      "architect",
      "verifier",
      "threat-model",
      "attack-tree",
      "sast",
    ]);
  });

  it("loads non-empty role markdown for every bundled persona", () => {
    for (const p of BUNDLED_PERSONAS) {
      expect(p.roleMarkdown.length).toBeGreaterThan(400);
      // The role frontmatter names the persona; the body is real guidance.
      expect(p.roleMarkdown).toContain(`name: ${p.id}`);
    }
  });

  it("grounds each model persona in its own contract", () => {
    expect(bundledPersona(THREAT_MODEL_PERSONA)?.roleMarkdown).toContain("STRIDE");
    expect(bundledPersona(ATTACK_TREE_PERSONA)?.roleMarkdown).toMatch(/AND\/OR|attack tree/i);
    expect(bundledPersona(SAST_PERSONA)?.roleMarkdown).toContain("scanner");
  });

  it("gives every model persona a display label", () => {
    for (const id of [THREAT_MODEL_PERSONA, ATTACK_TREE_PERSONA, SAST_PERSONA]) {
      expect(bundledPersona(id)?.label).toBeTruthy();
    }
  });

  it("returns null for an unknown persona id", () => {
    expect(bundledPersona("nope")).toBeNull();
    // A known one round-trips.
    expect(bundledPersona(CODE_REVIEW_PERSONA)?.id).toBe(CODE_REVIEW_PERSONA);
  });
});
